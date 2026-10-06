import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { SessionPlatform, User, UserSession, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  DomainEvents,
  UserLoggedInPayload,
  UserLoggedOutPayload,
  UserSuspendedPayload,
} from '../common/events/domain-events';
import { AccessTokenClaims, RefreshTokenClaims } from './auth.types';
import { LoginDto } from './dto/login.dto';

// A just-rotated refresh token keeps working this long, so a device whose
// refresh response was lost on a slow network can retry instead of being
// signed out. Past it, a replayed token is treated as stolen.
export const REFRESH_REUSE_GRACE_MS = 2 * 60_000;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

type TokenUser = Pick<User, 'id' | 'username' | 'platformRole'>;

// Checked when there's no password to check, so every failed login takes as long.
let dummyPasswordHash: Promise<string> | undefined;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
  ) {}

  async login(dto: LoginDto): Promise<TokenPair> {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ username: dto.usernameOrEmail }, { email: dto.usernameOrEmail }] },
    });

    // An account made with Google has no password. Deliberately generic message either way.
    dummyPasswordHash ??= argon2.hash(randomUUID());
    const passwordValid = await argon2.verify(
      user?.passwordHash ?? (await dummyPasswordHash),
      dto.password,
    );
    if (!user?.passwordHash || !passwordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }
    // Only after the right password: telling a stranger an account is suspended would leak that it exists.
    if (user.status === UserStatus.SUSPENDED) {
      throw new ForbiddenException({
        message: 'This account has been suspended',
        code: 'ACCOUNT_SUSPENDED',
      });
    }

    const tokens = await this.startSession(user, dto.platform);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    this.events.emit(DomainEvents.UserLoggedIn, {
      userId: user.id,
      platform: dto.platform ?? SessionPlatform.UNKNOWN,
      method: 'password',
    } satisfies UserLoggedInPayload);
    return tokens;
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const claims = await this.verifyRefreshToken(refreshToken);
    // Tokens issued before per-device sessions carry no session id.
    if (!claims?.sid) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    return this.rotate(claims.sid, claims.sub, hashToken(refreshToken), true);
  }

  // Signs out the one device holding this refresh token. Always succeeds, so
  // it reveals nothing about whether the token was valid.
  async logout(refreshToken: string): Promise<void> {
    const userId = await this.endSession(refreshToken);
    if (userId) {
      this.events.emit(DomainEvents.UserLoggedOut, { userId } satisfies UserLoggedOutPayload);
    }
  }

  /** Ends the one session [refreshToken] belongs to; returns whose it was, or null. */
  async endSession(refreshToken: string): Promise<string | null> {
    const claims = await this.verifyRefreshToken(refreshToken, { ignoreExpiration: true });
    if (!claims?.sid) return null;
    const { count } = await this.prisma.userSession.deleteMany({
      where: { id: claims.sid, userId: claims.sub },
    });
    return count > 0 ? claims.sub : null;
  }

  /** A new signed-in device for an already-verified user - the admin console's sign-in. */
  startSessionFor(user: TokenUser, platform: SessionPlatform): Promise<TokenPair> {
    return this.startSession(user, platform);
  }

  /** Signs this user out everywhere; their access tokens stop working on the next session check. */
  async revokeAllSessions(userId: string): Promise<number> {
    const { count } = await this.prisma.userSession.deleteMany({ where: { userId } });
    return count;
  }

  /** Everywhere but the device in [keepSessionId] - after a password change. */
  async revokeOtherSessions(userId: string, keepSessionId: string): Promise<number> {
    const { count } = await this.prisma.userSession.deleteMany({
      where: { userId, id: { not: keepSessionId } },
    });
    return count;
  }

  @OnEvent(DomainEvents.UserSuspended)
  async endAllSessions(payload: UserSuspendedPayload): Promise<void> {
    await this.prisma.userSession.deleteMany({ where: { userId: payload.userId } });
  }

  /** Whether this device is still signed in: its access token alone outlives a logout or suspension. */
  async isSessionActive(sessionId: string, userId: string): Promise<boolean> {
    const session = await this.prisma.userSession.findFirst({
      where: { id: sessionId, userId, user: { status: UserStatus.ACTIVE } },
      select: { id: true },
    });
    return session !== null;
  }

  private async rotate(
    sessionId: string,
    userId: string,
    presentedHash: string,
    retryOnRace: boolean,
  ): Promise<TokenPair> {
    const session = await this.prisma.userSession.findUnique({
      where: { id: sessionId },
      include: { user: true },
    });
    if (!session || session.userId !== userId) {
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    if (session.user.status === UserStatus.SUSPENDED) {
      await this.prisma.userSession.deleteMany({ where: { userId } });
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    if (!isAcceptable(session, presentedHash)) {
      // An older token coming back means it leaked: end this device's session.
      await this.prisma.userSession.deleteMany({ where: { id: session.id } });
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    const claims = claimsFor(session.user, session.id);
    const refreshToken = await this.signRefreshToken(claims);
    const now = new Date();
    // Compare-and-set, so two concurrent refreshes can't both rotate from the same row.
    const { count } = await this.prisma.userSession.updateMany({
      where: { id: session.id, refreshTokenHash: session.refreshTokenHash },
      data: {
        previousRefreshTokenHash: session.refreshTokenHash,
        refreshTokenHash: hashToken(refreshToken),
        rotatedAt: now,
        lastSeenAt: now,
      },
    });
    if (count === 0) {
      // The other refresh won; the presented token is now the in-grace previous one.
      if (retryOnRace) return this.rotate(sessionId, userId, presentedHash, false);
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    return { accessToken: await this.signAccessToken(claims), refreshToken };
  }

  private async startSession(user: TokenUser, platform?: SessionPlatform): Promise<TokenPair> {
    const sessionId = randomUUID();
    const claims = claimsFor(user, sessionId);
    const refreshToken = await this.signRefreshToken(claims);

    // Sessions idle longer than the refresh TTL can never refresh again.
    await this.prisma.userSession.deleteMany({
      where: {
        userId: user.id,
        lastSeenAt: { lt: new Date(Date.now() - this.refreshTtlSeconds() * 1000) },
      },
    });
    await this.prisma.userSession.create({
      data: {
        id: sessionId,
        userId: user.id,
        platform: platform ?? SessionPlatform.UNKNOWN,
        refreshTokenHash: hashToken(refreshToken),
      },
    });

    return { accessToken: await this.signAccessToken(claims), refreshToken };
  }

  private async verifyRefreshToken(
    token: string,
    options: { ignoreExpiration?: boolean } = {},
  ): Promise<RefreshTokenClaims | null> {
    try {
      return await this.jwtService.verifyAsync<RefreshTokenClaims>(token, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
        ignoreExpiration: options.ignoreExpiration,
      });
    } catch {
      if (options.ignoreExpiration) return null;
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  private signAccessToken(claims: AccessTokenClaims): Promise<string> {
    return this.jwtService.signAsync(claims, {
      secret: this.config.get<string>('JWT_ACCESS_SECRET'),
      expiresIn: Number(this.config.get('JWT_ACCESS_TTL_SECONDS')) || 900,
    });
  }

  private signRefreshToken(claims: AccessTokenClaims): Promise<string> {
    // A unique jti keeps two refreshes in the same second from minting identical tokens.
    return this.jwtService.signAsync(
      { ...claims, jti: randomUUID() } satisfies RefreshTokenClaims,
      {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: this.refreshTtlSeconds(),
      },
    );
  }

  refreshTtlSeconds(): number {
    return Number(this.config.get('JWT_REFRESH_TTL_SECONDS')) || 604800;
  }
}

function isAcceptable(session: UserSession, presentedHash: string): boolean {
  if (hashesEqual(session.refreshTokenHash, presentedHash)) return true;
  const withinGrace = Date.now() - session.rotatedAt.getTime() < REFRESH_REUSE_GRACE_MS;
  return (
    withinGrace &&
    session.previousRefreshTokenHash !== null &&
    hashesEqual(session.previousRefreshTokenHash, presentedHash)
  );
}

function claimsFor(user: TokenUser, sessionId: string): AccessTokenClaims {
  return { sub: user.id, username: user.username, platformRole: user.platformRole, sid: sessionId };
}

// Refresh tokens are long random JWTs, so a fast hash is enough (no argon2).
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}
