import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AdminPermission, PlatformRole, Prisma, StreamStatus, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { AuthService } from '../../auth/auth.service';
import {
  DomainEvents,
  StaffAccountCreatedPayload,
  UserAdminPermissionsChangedPayload,
  UserProfileModeratedPayload,
  UserReinstatedPayload,
  UserRoleChangedPayload,
  UserSessionsRevokedPayload,
  UserSuspendedPayload,
} from '../../common/events/domain-events';
import { pageArgs, toPage } from '../../common/pagination/page-query.dto';
import { effectiveAdminPermissions, withIncludedPermissions } from '../../common/permissions/admin-permissions';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StreamsService } from '../../streams/streams.service';
import { AdminPrincipal } from '../admin.guard';
import { generateTemporaryPassword } from '../password-policy';
import { AdminUsersQueryDto, CreateStaffDto, EditUserProfileDto } from './admin-users.dto';

const USER_ROW_SELECT = {
  id: true,
  username: true,
  displayName: true,
  email: true,
  avatarUrl: true,
  platformRole: true,
  status: true,
  createdAt: true,
  lastLoginAt: true,
  suspendedAt: true,
  _count: { select: { streams: true, followedBy: true } },
} as const;

const STAFF_ROLES = [PlatformRole.PLATFORM_MODERATOR, PlatformRole.SUPER_ADMIN];

/**
 * Accounts from the admin console (plan §6.8): find, inspect, suspend and
 * reinstate, sign out everywhere, and - super admins only - change a
 * platform role or add staff. Every change goes out as a domain event,
 * which the audit trail records.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly streams: StreamsService,
    private readonly events: EventEmitter2,
  ) {}

  async list(query: AdminUsersQueryDto) {
    const q = query.q?.trim();
    const where: Prisma.UserWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.role ? { platformRole: query.role } : {}),
      ...(q
        ? {
            OR: [
              { username: { contains: q, mode: 'insensitive' } },
              { displayName: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
              { id: q },
            ],
          }
        : {}),
    };
    const sort = query.sort ?? 'createdAt';
    const order = query.order ?? (sort === 'username' ? 'asc' : 'desc');
    const orderBy: Prisma.UserOrderByWithRelationInput[] =
      sort === 'lastLoginAt'
        ? [{ lastLoginAt: { sort: order, nulls: 'last' } }, { id: 'asc' }]
        : sort === 'username'
          ? [{ username: order }, { id: 'asc' }]
          : [{ createdAt: order }, { id: 'asc' }];
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy,
        select: USER_ROW_SELECT,
        ...pageArgs(query),
      }),
      this.prisma.user.count({ where }),
    ]);
    return toPage(rows.map(toUserRow), total, query);
  }

  async detail(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        ...USER_ROW_SELECT,
        bio: true,
        suspensionReason: true,
        passwordChangeRequired: true,
        adminPermissions: true,
        _count: {
          select: {
            streams: true,
            followedBy: true,
            following: true,
            chatMessages: true,
            sessions: true,
            blockedBy: true,
          },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    const liveStream = await this.prisma.stream.findFirst({
      where: { hostId: userId, status: StreamStatus.LIVE },
      select: { id: true, title: true, startedAt: true },
    });
    const { _count: counts, adminPermissions, ...profile } = user;
    return {
      ...profile,
      permissions: effectiveAdminPermissions(user.platformRole, adminPermissions),
      counts: {
        streams: counts.streams,
        followers: counts.followedBy,
        following: counts.following,
        messages: counts.chatMessages,
        sessions: counts.sessions,
        blockedBy: counts.blockedBy,
      },
      liveStream,
    };
  }

  async sessions(userId: string) {
    await this.assertExists(userId);
    const sessions = await this.prisma.userSession.findMany({
      where: { userId },
      orderBy: { lastSeenAt: 'desc' },
      select: { id: true, platform: true, createdAt: true, lastSeenAt: true },
    });
    return { items: sessions };
  }

  /**
   * Signs them out everywhere and disconnects them (Phase 1.5), and locks
   * any live they're running. Only a super admin can suspend staff.
   */
  async suspend(admin: AdminPrincipal, userId: string, reason: string) {
    const target = await this.getTarget(userId);
    if (target.id === admin.id) throw new BadRequestException("You can't suspend your own account");
    this.assertCanActOnStaff(admin, target.platformRole);
    if (target.status === UserStatus.SUSPENDED) throw new ConflictException('This account is already suspended');
    if (target.platformRole === PlatformRole.SUPER_ADMIN) await this.assertAnotherSuperAdmin(target.id);

    await this.prisma.user.update({
      where: { id: userId },
      data: { status: UserStatus.SUSPENDED, suspendedAt: new Date(), suspensionReason: reason },
    });
    this.events.emit(DomainEvents.UserSuspended, {
      userId,
      suspendedBy: admin.id,
      reason,
    } satisfies UserSuspendedPayload);
    // Viewers see this; the suspension reason itself stays in the console.
    const lockedLives = await this.streams.lockLiveStreamsOfHost(userId, admin.id, "The host's account was suspended");
    return { ok: true, lockedLives };
  }

  async reinstate(admin: AdminPrincipal, userId: string) {
    const target = await this.getTarget(userId);
    this.assertCanActOnStaff(admin, target.platformRole);
    if (target.status !== UserStatus.SUSPENDED) throw new ConflictException('This account is not suspended');
    await this.prisma.user.update({
      where: { id: userId },
      data: { status: UserStatus.ACTIVE, suspendedAt: null, suspensionReason: null },
    });
    this.events.emit(DomainEvents.UserReinstated, { userId, reinstatedBy: admin.id } satisfies UserReinstatedPayload);
    return { ok: true };
  }

  /**
   * Super admins only (guarded on the route). There is always at least one
   * active super admin, and a new platform moderator is given what they may do.
   */
  async changeRole(admin: AdminPrincipal, userId: string, role: PlatformRole, permissions: AdminPermission[] = []) {
    const target = await this.getTarget(userId);
    if (target.id === admin.id) throw new BadRequestException("You can't change your own role");
    if (target.platformRole === role) return { ok: true };
    const granted = role === PlatformRole.PLATFORM_MODERATOR ? moderatorPermissions(permissions) : [];
    if (target.platformRole === PlatformRole.SUPER_ADMIN) await this.assertAnotherSuperAdmin(target.id);

    await this.prisma.user.update({ where: { id: userId }, data: { platformRole: role, adminPermissions: granted } });
    this.events.emit(DomainEvents.UserRoleChanged, {
      userId,
      actorId: admin.id,
      from: target.platformRole,
      to: role,
      ...(role === PlatformRole.PLATFORM_MODERATOR ? { permissions: granted } : {}),
    } satisfies UserRoleChangedPayload);
    return { ok: true };
  }

  /** Super admins only (guarded on the route). Applies from the moderator's next request. */
  async changePermissions(admin: AdminPrincipal, userId: string, permissions: AdminPermission[]) {
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, platformRole: true, adminPermissions: true },
    });
    if (!target) throw new NotFoundException('User not found');
    if (target.platformRole !== PlatformRole.PLATFORM_MODERATOR) {
      throw new BadRequestException("Only a platform moderator's access can be chosen. A super admin can do everything.");
    }
    const from = withIncludedPermissions(target.adminPermissions);
    const to = moderatorPermissions(permissions);
    if (from.join() !== to.join()) {
      await this.prisma.user.update({ where: { id: userId }, data: { adminPermissions: to } });
      this.events.emit(DomainEvents.UserAdminPermissionsChanged, {
        userId,
        actorId: admin.id,
        from,
        to,
      } satisfies UserAdminPermissionsChangedPayload);
    }
    return { ok: true, permissions: to };
  }

  async revokeSessions(admin: AdminPrincipal, userId: string) {
    const target = await this.getTarget(userId);
    this.assertCanActOnStaff(admin, target.platformRole);
    const revoked = await this.auth.revokeAllSessions(userId);
    this.events.emit(DomainEvents.UserSessionsRevoked, { userId, actorId: admin.id } satisfies UserSessionsRevokedPayload);
    return { ok: true, revoked };
  }

  /** Fixes an offensive username, name, bio or picture; the audit entry keeps what it was. */
  async editProfile(admin: AdminPrincipal, userId: string, dto: EditUserProfileDto) {
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, platformRole: true, username: true, displayName: true, bio: true, avatarUrl: true },
    });
    if (!target) throw new NotFoundException('User not found');
    this.assertCanActOnStaff(admin, target.platformRole);

    const data: Prisma.UserUpdateInput = {};
    const changes: UserProfileModeratedPayload['changes'] = {};
    if (dto.username !== undefined && dto.username !== target.username) {
      const taken = await this.prisma.user.findFirst({
        where: { username: { equals: dto.username, mode: 'insensitive' }, id: { not: userId } },
        select: { id: true },
      });
      if (taken) throw new ConflictException('That username is taken');
      data.username = dto.username;
      changes.username = { from: target.username, to: dto.username };
    }
    if (dto.displayName !== undefined && dto.displayName !== target.displayName) {
      data.displayName = dto.displayName;
      changes.displayName = { from: target.displayName, to: dto.displayName };
    }
    const bio = dto.bio === undefined ? undefined : dto.bio || null;
    if (bio !== undefined && bio !== target.bio) {
      data.bio = bio;
      changes.bio = { from: target.bio, to: bio };
    }
    if (dto.removeAvatar && target.avatarUrl) {
      data.avatarUrl = null;
      changes.avatar = { from: target.avatarUrl, to: null };
    }
    if (Object.keys(changes).length === 0) throw new BadRequestException('Nothing to change');

    try {
      await this.prisma.user.update({ where: { id: userId }, data });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('That username is taken');
      }
      throw error;
    }
    this.events.emit(DomainEvents.UserProfileModerated, {
      userId,
      actorId: admin.id,
      reason: dto.reason,
      changes,
    } satisfies UserProfileModeratedPayload);
    return this.detail(userId);
  }

  async listStaff() {
    const staff = await this.prisma.user.findMany({
      where: { platformRole: { in: STAFF_ROLES } },
      orderBy: [{ platformRole: 'desc' }, { displayName: 'asc' }],
      select: {
        id: true,
        username: true,
        displayName: true,
        email: true,
        avatarUrl: true,
        platformRole: true,
        status: true,
        createdAt: true,
        lastLoginAt: true,
        passwordChangeRequired: true,
        adminPermissions: true,
      },
    });
    return {
      items: staff.map(({ adminPermissions, ...member }) => ({
        ...member,
        permissions: effectiveAdminPermissions(member.platformRole, adminPermissions),
      })),
    };
  }

  /** A console-only account with a one-time password, shown to the creator once and replaced at first sign-in. */
  async createStaff(admin: AdminPrincipal, dto: CreateStaffDto) {
    const permissions =
      dto.platformRole === PlatformRole.PLATFORM_MODERATOR ? moderatorPermissions(dto.permissions ?? []) : [];
    const existing = await this.prisma.user.findFirst({
      where: { email: { equals: dto.email, mode: 'insensitive' } },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('An account with this email already exists - change its role from its user page');
    }
    const temporaryPassword = generateTemporaryPassword();
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        displayName: dto.displayName,
        username: await this.availableUsername(dto.email),
        passwordHash: await argon2.hash(temporaryPassword),
        platformRole: dto.platformRole,
        adminPermissions: permissions,
        passwordChangeRequired: true,
      },
      select: { id: true, username: true, displayName: true, email: true, platformRole: true },
    });
    this.events.emit(DomainEvents.StaffAccountCreated, {
      userId: user.id,
      actorId: admin.id,
      role: dto.platformRole,
      permissions,
    } satisfies StaffAccountCreatedPayload);
    return {
      user: { ...user, permissions: effectiveAdminPermissions(user.platformRole, permissions) },
      temporaryPassword,
    };
  }

  private async availableUsername(email: string): Promise<string> {
    const base =
      email
        .split('@')[0]
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '')
        .slice(0, 20) || 'staff';
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = attempt === 0 ? base : `${base}${Math.floor(1000 + Math.random() * 9000)}`;
      const taken = await this.prisma.user.findUnique({ where: { username: candidate }, select: { id: true } });
      if (!taken) return candidate;
    }
    throw new ConflictException('Could not pick a username - try again');
  }

  private assertCanActOnStaff(admin: AdminPrincipal, targetRole: PlatformRole): void {
    if (targetRole !== PlatformRole.USER && admin.platformRole !== PlatformRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only a super admin can do this to a staff account');
    }
  }

  private async assertAnotherSuperAdmin(exceptUserId: string): Promise<void> {
    const others = await this.prisma.user.count({
      where: { platformRole: PlatformRole.SUPER_ADMIN, status: UserStatus.ACTIVE, id: { not: exceptUserId } },
    });
    if (others === 0) throw new ConflictException('There must always be at least one active super admin');
  }

  private async getTarget(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, platformRole: true, status: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  private async assertExists(userId: string): Promise<void> {
    await this.getTarget(userId);
  }
}

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_ROW_SELECT }>;

// A platform moderator can do only what they're given, so they must be given something.
function moderatorPermissions(permissions: readonly AdminPermission[]): AdminPermission[] {
  const granted = withIncludedPermissions(permissions);
  if (granted.length === 0) throw new BadRequestException('Choose what they can do in the console');
  return granted;
}

function toUserRow(row: UserRow) {
  const { _count: counts, ...user } = row;
  return { ...user, streamCount: counts.streams, followerCount: counts.followedBy };
}
