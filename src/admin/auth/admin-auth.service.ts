import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { AdminPermission, PlatformRole, SessionPlatform, User, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { AuthService, TokenPair } from '../../auth/auth.service';
import { RefreshTokenClaims } from '../../auth/auth.types';
import {
  AccountCredentialChangedPayload,
  AdminSignedInPayload,
  AdminSignInFailedPayload,
  DomainEvents,
  UserProfileUpdatedPayload,
} from '../../common/events/domain-events';
import { PrismaService } from '../../common/prisma/prisma.service';
import { effectiveAdminPermissions } from '../../common/permissions/admin-permissions';
import { RateLimit, RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { AdminPrincipal } from '../admin.guard';
import { adminPasswordProblem } from '../password-policy';
import { AdminSignInDto, ChangeEmailDto, ChangePasswordDto, UpdateAdminProfileDto } from './admin-auth.dto';

export const DEFAULT_ADMIN_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

export interface AdminView {
  id: string;
  username: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  platformRole: PlatformRole;
  // What the console may show and do for them.
  permissions: AdminPermission[];
  passwordChangeRequired: boolean;
}

export interface AdminSession {
  tokens: TokenPair;
  admin: AdminView;
}

const SIGN_IN_FAILED = 'Incorrect email or password';

// Per account, on top of the per-IP throttle: 10 tries, then one every 3 minutes.
export const ADMIN_SIGN_IN_LIMIT: RateLimit = { capacity: 10, refillMs: 3 * 60_000 };

/**
 * Staff sign-in for the admin console (plan §6.8) on the app's own
 * per-device sessions (docs/features/auth.md), limited to platform
 * moderators and super admins, and never longer than the admin session age.
 */
@Injectable()
export class AdminAuthService implements OnModuleInit {
  // Verified against when no account matches, so a wrong email takes as long as a wrong password.
  private dummyHash = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
    private readonly rateLimit: RateLimitService,
  ) {}

  async onModuleInit() {
    this.dummyHash = await argon2.hash('not-a-real-password-for-timing');
  }

  sessionMaxAgeSeconds(): number {
    return Number(this.config.get('ADMIN_SESSION_MAX_AGE_SECONDS')) || DEFAULT_ADMIN_SESSION_MAX_AGE_SECONDS;
  }

  async signIn(dto: AdminSignInDto): Promise<AdminSession> {
    // Redis being down must not lock staff out.
    const wait = await this.rateLimit
      .take(`admin-sign-in:${dto.email.toLowerCase()}`, ADMIN_SIGN_IN_LIMIT)
      .catch(() => 0);
    if (wait > 0) {
      this.events.emit(DomainEvents.AdminSignInFailed, {
        email: dto.email,
        reason: 'rate_limited',
      } satisfies AdminSignInFailedPayload);
      const minutes = Math.ceil(wait / 60_000);
      throw new HttpException(
        {
          message: `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
          code: 'TOO_MANY_ATTEMPTS',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await this.prisma.user.findFirst({ where: { email: { equals: dto.email, mode: 'insensitive' } } });
    const passwordValid = await argon2.verify(user?.passwordHash ?? this.dummyHash, dto.password);
    if (!user || !passwordValid || user.platformRole === PlatformRole.USER || user.status !== UserStatus.ACTIVE) {
      this.events.emit(DomainEvents.AdminSignInFailed, { email: dto.email } satisfies AdminSignInFailedPayload);
      throw new UnauthorizedException(SIGN_IN_FAILED);
    }

    const tokens = await this.auth.startSessionFor(user, SessionPlatform.WEB);
    const signedIn = await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    this.events.emit(DomainEvents.AdminSignedIn, { userId: user.id } satisfies AdminSignedInPayload);
    return { tokens, admin: toAdminView(signedIn) };
  }

  /** Rotates the console's refresh token; the session ends at its maximum age however active it is. */
  async refresh(refreshToken: string | undefined): Promise<AdminSession> {
    if (!refreshToken) throw new UnauthorizedException('Sign in to continue');
    const claims = this.jwt.decode<RefreshTokenClaims | null>(refreshToken);
    if (!claims?.sid) throw new UnauthorizedException('Sign in to continue');

    const session = await this.prisma.userSession.findUnique({
      where: { id: claims.sid },
      select: { createdAt: true, platform: true },
    });
    const expired =
      !session ||
      session.platform !== SessionPlatform.WEB ||
      Date.now() - session.createdAt.getTime() > this.sessionMaxAgeSeconds() * 1000;
    if (expired) {
      if (session) await this.auth.endSession(refreshToken);
      throw new UnauthorizedException('Your session has expired. Sign in again.');
    }

    const tokens = await this.auth.refresh(refreshToken);
    const user = await this.prisma.user.findUnique({ where: { id: claims.sub } });
    if (!user || user.platformRole === PlatformRole.USER || user.status !== UserStatus.ACTIVE) {
      await this.auth.endSession(tokens.refreshToken);
      throw new UnauthorizedException('Admin access is required');
    }
    return { tokens, admin: toAdminView(user) };
  }

  async signOut(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    const userId = await this.auth.endSession(refreshToken);
    if (userId) {
      this.events.emit(DomainEvents.AdminSignedOut, { userId } satisfies AdminSignedInPayload);
    }
  }

  async me(admin: AdminPrincipal): Promise<AdminView> {
    return toAdminView(await this.prisma.user.findUniqueOrThrow({ where: { id: admin.id } }));
  }

  /** Every other device of this account is signed out, the console included. */
  async changePassword(admin: AdminPrincipal, dto: ChangePasswordDto): Promise<AdminView> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    if (!(await argon2.verify(user.passwordHash, dto.currentPassword))) {
      throw new BadRequestException('Your current password is incorrect');
    }
    const problem = adminPasswordProblem(dto.newPassword, user.email);
    if (problem) throw new BadRequestException(problem);
    if (await argon2.verify(user.passwordHash, dto.newPassword)) {
      throw new BadRequestException('Choose a password different from your current one');
    }

    const updated = await this.prisma.user.update({
      where: { id: admin.id },
      data: { passwordHash: await argon2.hash(dto.newPassword), passwordChangeRequired: false },
    });
    await this.auth.revokeOtherSessions(admin.id, admin.sessionId);
    this.events.emit(DomainEvents.AccountPasswordChanged, { userId: admin.id } satisfies AccountCredentialChangedPayload);
    return toAdminView(updated);
  }

  async changeEmail(admin: AdminPrincipal, dto: ChangeEmailDto): Promise<AdminView> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    if (!(await argon2.verify(user.passwordHash, dto.currentPassword))) {
      throw new BadRequestException('Your current password is incorrect');
    }
    if (user.email.toLowerCase() === dto.email.toLowerCase()) return toAdminView(user);
    const taken = await this.prisma.user.findFirst({
      where: { email: { equals: dto.email, mode: 'insensitive' }, id: { not: admin.id } },
      select: { id: true },
    });
    if (taken) throw new ConflictException('That email address is already in use');

    const updated = await this.prisma.user.update({ where: { id: admin.id }, data: { email: dto.email } });
    this.events.emit(DomainEvents.AccountEmailChanged, { userId: admin.id } satisfies AccountCredentialChangedPayload);
    return toAdminView(updated);
  }

  async updateProfile(admin: AdminPrincipal, dto: UpdateAdminProfileDto): Promise<AdminView> {
    const updated = await this.prisma.user.update({ where: { id: admin.id }, data: { displayName: dto.displayName } });
    this.events.emit(DomainEvents.UserProfileUpdated, {
      userId: admin.id,
      fields: ['displayName'],
    } satisfies UserProfileUpdatedPayload);
    return toAdminView(updated);
  }

  /** This account's signed-in devices - the app's and the console's. */
  async sessions(admin: AdminPrincipal) {
    const sessions = await this.prisma.userSession.findMany({
      where: { userId: admin.id },
      orderBy: { lastSeenAt: 'desc' },
      select: { id: true, platform: true, createdAt: true, lastSeenAt: true },
    });
    return { items: sessions.map((session) => ({ ...session, current: session.id === admin.sessionId })) };
  }

  async revokeSession(admin: AdminPrincipal, sessionId: string): Promise<{ ok: true }> {
    if (sessionId === admin.sessionId) throw new BadRequestException('Use sign out to end this session');
    const { count } = await this.prisma.userSession.deleteMany({ where: { id: sessionId, userId: admin.id } });
    if (count === 0) throw new NotFoundException('Session not found');
    return { ok: true };
  }
}

export function toAdminView(user: User): AdminView {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    platformRole: user.platformRole,
    permissions: effectiveAdminPermissions(user.platformRole, user.adminPermissions),
    passwordChangeRequired: user.passwordChangeRequired,
  };
}
