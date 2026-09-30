import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AdminPermission, PlatformRole, UserStatus } from '@prisma/client';
import { AccessTokenClaims } from '../auth/auth.types';
import { extractBearerToken } from '../auth/extract-bearer-token';
import { effectiveAdminPermissions } from '../common/permissions/admin-permissions';
import { PrismaService } from '../common/prisma/prisma.service';

/** The signed-in staff member, re-read from the database on every admin request. */
export interface AdminPrincipal {
  id: string;
  username: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  platformRole: PlatformRole;
  // Everything for a super admin; what a super admin gave them for a platform moderator.
  permissions: AdminPermission[];
  passwordChangeRequired: boolean;
  sessionId: string;
}

const ADMIN_ROLES_KEY = 'adminRoles';
const ADMIN_PERMISSION_KEY = 'adminPermission';
const ALLOW_PENDING_PASSWORD_KEY = 'adminAllowPendingPassword';

/** Staff work in the console all day, often from one office address: more headroom than the app's default. */
export const ADMIN_API_THROTTLE = { default: { limit: 300, ttl: 60_000 } };

/** Narrows a route to these platform roles; every admin route already excludes USER. */
export const AdminRoles = (...roles: PlatformRole[]) => SetMetadata(ADMIN_ROLES_KEY, roles);

export const SuperAdminOnly = () => AdminRoles(PlatformRole.SUPER_ADMIN);

/** Needs this console permission (a super admin has them all). On a method, it replaces the controller's. */
export const RequirePermission = (permission: AdminPermission) => SetMetadata(ADMIN_PERMISSION_KEY, permission);

/** Still reachable before a seeded or staff-created account has set its own password. */
export const AllowPendingPasswordChange = () => SetMetadata(ALLOW_PENDING_PASSWORD_KEY, true);

export const CurrentAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AdminPrincipal => context.switchToHttp().getRequest().admin,
);

/**
 * Every /admin route (plan §6.8): a valid access token whose session is
 * still open, for an active platform moderator or super admin, holding the
 * route's permission. Role, status and permissions are read from the
 * database rather than trusted from the token, so a demotion, a suspension
 * or a change of permissions applies to the very next request.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = extractBearerToken(request);
    if (!token) throw new UnauthorizedException('Sign in to continue');

    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(token, {
        secret: this.config.get<string>('JWT_ACCESS_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Your session has expired');
    }
    if (!claims.sid) throw new UnauthorizedException('Your session has expired');

    const session = await this.prisma.userSession.findFirst({
      where: { id: claims.sid, userId: claims.sub },
      select: {
        user: {
          select: {
            id: true,
            username: true,
            email: true,
            displayName: true,
            avatarUrl: true,
            platformRole: true,
            adminPermissions: true,
            status: true,
            passwordChangeRequired: true,
          },
        },
      },
    });
    const user = session?.user;
    if (!user || user.status !== UserStatus.ACTIVE) throw new UnauthorizedException('Your session has ended');
    if (user.platformRole === PlatformRole.USER) throw new ForbiddenException('Admin access is required');

    const roles = this.reflector.getAllAndOverride<PlatformRole[] | undefined>(ADMIN_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (roles && !roles.includes(user.platformRole)) {
      throw new ForbiddenException('Only a super admin can do this');
    }
    const allowPending = this.reflector.getAllAndOverride<boolean | undefined>(ALLOW_PENDING_PASSWORD_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (user.passwordChangeRequired && !allowPending) {
      throw new ForbiddenException({ message: 'Set a new password to continue', code: 'PASSWORD_CHANGE_REQUIRED' });
    }
    const permissions = effectiveAdminPermissions(user.platformRole, user.adminPermissions);
    const required = this.reflector.getAllAndOverride<AdminPermission | undefined>(ADMIN_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required && !permissions.includes(required)) {
      throw new ForbiddenException({
        message: "You don't have access to this. A super admin can give it to you",
        code: 'MISSING_PERMISSION',
      });
    }

    request.admin = {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      platformRole: user.platformRole,
      permissions,
      passwordChangeRequired: user.passwordChangeRequired,
      sessionId: claims.sid,
    } satisfies AdminPrincipal;
    return true;
  }
}
