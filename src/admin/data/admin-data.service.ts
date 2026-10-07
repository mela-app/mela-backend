import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PlatformRole, Prisma, StreamStatus } from '@prisma/client';
import { BannedPhrasesService } from '../../chat/banned-phrases.service';
import {
  DataClearedPayload,
  DataResetPayload,
  DomainEvents,
} from '../../common/events/domain-events';
import { PrismaService } from '../../common/prisma/prisma.service';
import { STORAGE_PROVIDER, StorageProvider } from '../../common/storage/storage-provider.interface';
import { AdminPrincipal } from '../admin.guard';
import { passwordMatches } from '../password-policy';

const DAY_MS = 24 * 60 * 60 * 1000;

export const DATA_SET_KEYS = [
  'users',
  'sessions',
  'follows',
  'blocks',
  'personalMutes',
  'notificationSettings',
  'lives',
  'chat',
  'stageGuests',
  'stageRequests',
  'liveModerators',
  'roomBans',
  'liveChatMutes',
  'recordingPermissions',
  'privateMessages',
  'notifications',
  'alerts',
  'auditLog',
  'bannedPhrases',
  'appUpdates',
] as const;
export type DataSetKey = (typeof DATA_SET_KEYS)[number];

/** What a reset can leave in place, and the table each one is. */
export const KEEPABLE_ON_RESET = {
  appUpdates: 'app_releases',
  bannedPhrases: 'banned_phrases',
  auditLog: 'audit_logs',
} as const;
export type KeepableOnReset = keyof typeof KEEPABLE_ON_RESET;

// The admin's own account and how it signs in; everyone else's rows go with their accounts.
const SPARED_BY_RESET = [
  '_prisma_migrations',
  'users',
  'user_sessions',
  'user_identities',
  'notification_settings',
];

type DataGroup = 'people' | 'lives' | 'messages' | 'console';
// 'created': only rows older than N days; 'lastUsed': only devices unused for N days.
type AgeFilter = 'created' | 'lastUsed';

interface DataSet {
  key: DataSetKey;
  group: DataGroup;
  label: string;
  description: string;
  tables: string[];
  ageFilter: AgeFilter | null;
  count(): Promise<number>;
  /** How many rows went - only ones older than [before] when given - and the files they pointed at. */
  clear(
    before: Date | undefined,
    admin: AdminPrincipal,
  ): Promise<{ removed: number; files?: string[] }>;
}

// A running live's room still uses its rows, so they stay whatever is removed.
const NOT_RUNNING = { status: { not: StreamStatus.LIVE } } satisfies Prisma.StreamWhereInput;

const removed = ({ count }: Prisma.BatchPayload) => ({ removed: count });
const olderThan = (before: Date | undefined) => (before ? { createdAt: { lt: before } } : {});
const quoteIdentifier = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * The console's Data page (docs/features/admin.md), super admins only: how
 * much is stored, removing one kind of it - or only what's older than some
 * days - and resetting everything but the admin's own account. Each asks for
 * the admin's password again, and is recorded in the audit log afterwards.
 */
@Injectable()
export class AdminDataService {
  private readonly sets: DataSet[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly bannedPhrases: BannedPhrasesService,
    private readonly events: EventEmitter2,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {
    this.sets = this.defineSets();
  }

  async overview() {
    const [runningLives, ...counts] = await Promise.all([
      this.prisma.stream.count({ where: { status: StreamStatus.LIVE } }),
      ...this.sets.map((set) => set.count()),
    ]);
    return {
      runningLives,
      sets: this.sets.map(({ key, group, label, description, tables, ageFilter }, index) => ({
        key,
        group,
        label,
        description,
        tables,
        ageFilter,
        count: counts[index],
      })),
    };
  }

  async clear(
    admin: AdminPrincipal,
    key: DataSetKey,
    olderThanDays: number | undefined,
    password: string,
  ) {
    const set = this.sets.find((each) => each.key === key);
    if (!set) throw new BadRequestException('There is no such data');
    if (olderThanDays !== undefined && !set.ageFilter) {
      throw new BadRequestException(`${set.label} can only be removed all at once`);
    }
    await this.confirmPassword(admin, password);
    const before =
      olderThanDays === undefined ? undefined : new Date(Date.now() - olderThanDays * DAY_MS);
    const { removed: count, files = [] } = await set.clear(before, admin);
    if (files.length > 0) void this.storage.deleteUrls(files);
    this.events.emit(DomainEvents.DataCleared, {
      actorId: admin.id,
      dataSet: key,
      label: set.label,
      olderThanDays: olderThanDays ?? null,
      removed: count,
      signedOut: key === 'sessions' && before === undefined,
    } satisfies DataClearedPayload);
    return { removed: count };
  }

  /** Everything but the admin's own account - other staff included. Never while a live runs. */
  async reset(admin: AdminPrincipal, password: string, keep: KeepableOnReset[]) {
    await this.confirmPassword(admin, password);
    const running = await this.prisma.stream.count({ where: { status: StreamStatus.LIVE } });
    if (running > 0) {
      throw new ConflictException({
        message:
          running === 1
            ? 'A live is running. Lock it on the Lives page first'
            : `${running} lives are running. Lock them on the Lives page first`,
        code: 'LIVES_RUNNING',
      });
    }
    const others = { id: { not: admin.id } } satisfies Prisma.UserWhereInput;
    const files = await this.filesOf({}, others);
    const spared = new Set<string>([
      ...SPARED_BY_RESET,
      ...keep.map((each) => KEEPABLE_ON_RESET[each]),
    ]);
    const usersRemoved = await this.prisma.$transaction(
      async (tx) => {
        const tables = await tx.$queryRaw<Array<{ name: string }>>`
          SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema()`;
        const wiped = tables.map((table) => table.name).filter((name) => !spared.has(name));
        if (wiped.length > 0) {
          await tx.$executeRawUnsafe(`TRUNCATE ${wiped.map(quoteIdentifier).join(', ')}`);
        }
        return (await tx.user.deleteMany({ where: others })).count;
      },
      { timeout: 120_000 },
    );
    if (files.length > 0) void this.storage.deleteUrls(files);
    this.bannedPhrases.invalidate();
    this.events.emit(DomainEvents.DataReset, {
      actorId: admin.id,
      kept: keep,
      usersRemoved,
    } satisfies DataResetPayload);
    return { usersRemoved };
  }

  private async confirmPassword(admin: AdminPrincipal, password: string): Promise<void> {
    const account = await this.prisma.user.findUnique({
      where: { id: admin.id },
      select: { passwordHash: true },
    });
    if (!(await passwordMatches(account?.passwordHash ?? null, password))) {
      throw new BadRequestException({
        message: 'Your password is incorrect',
        code: 'WRONG_PASSWORD',
      });
    }
  }

  // What rows about to go point at in storage: chat photos, and profile pictures.
  private async filesOf(
    chat: Prisma.ChatMessageWhereInput | null,
    users: Prisma.UserWhereInput | null,
  ): Promise<string[]> {
    const [photos, pictures] = await Promise.all([
      chat
        ? this.prisma.chatMessage.findMany({
            where: { AND: [chat, { imageUrl: { not: null } }] },
            select: { imageUrl: true },
          })
        : [],
      users
        ? this.prisma.user.findMany({
            where: { AND: [users, { avatarUrl: { not: null } }] },
            select: { avatarUrl: true },
          })
        : [],
    ]);
    return [
      ...photos.flatMap((row) => row.imageUrl ?? []),
      ...pictures.flatMap((row) => row.avatarUrl ?? []),
    ];
  }

  private defineSets(): DataSet[] {
    const prisma = this.prisma;
    return [
      {
        key: 'users',
        group: 'people',
        label: 'App users',
        description:
          "Everyone who isn't staff, with all they made - lives, chat, messages, follows and " +
          'notifications. Anyone hosting a live right now is kept.',
        tables: ['users'],
        ageFilter: null,
        count: () => prisma.user.count({ where: { platformRole: PlatformRole.USER } }),
        clear: async () => {
          const leaving = {
            platformRole: PlatformRole.USER,
            streams: { none: { status: StreamStatus.LIVE } },
          } satisfies Prisma.UserWhereInput;
          const files = await this.filesOf({ stream: { host: leaving } }, leaving);
          // Their lives first: a live can't outlast its host.
          const [, users] = await prisma.$transaction([
            prisma.stream.deleteMany({ where: { host: leaving } }),
            prisma.user.deleteMany({ where: leaving }),
          ]);
          return { ...removed(users), files };
        },
      },
      {
        key: 'sessions',
        group: 'people',
        label: 'Signed-in devices',
        description: 'Signs everyone out of the app and the console - everyone but you, here.',
        tables: ['user_sessions'],
        ageFilter: 'lastUsed',
        count: () => prisma.userSession.count(),
        clear: async (before, admin) =>
          removed(
            await prisma.userSession.deleteMany({
              where: {
                id: { not: admin.sessionId },
                ...(before && { lastSeenAt: { lt: before } }),
              },
            }),
          ),
      },
      {
        key: 'follows',
        group: 'people',
        label: 'Follows',
        description: 'Who follows whom. Everyone starts again with no followers or friends.',
        tables: ['follows'],
        ageFilter: null,
        count: () => prisma.follow.count(),
        clear: async () => removed(await prisma.follow.deleteMany()),
      },
      {
        key: 'blocks',
        group: 'people',
        label: 'Blocks',
        description: 'Everyone people have blocked.',
        tables: ['blocks'],
        ageFilter: null,
        count: () => prisma.block.count(),
        clear: async () => removed(await prisma.block.deleteMany()),
      },
      {
        key: 'personalMutes',
        group: 'people',
        label: 'Muted people',
        description: 'Whom each person muted in chat, for themselves.',
        tables: ['personal_chat_mutes'],
        ageFilter: null,
        count: () => prisma.personalChatMute.count(),
        clear: async () => removed(await prisma.personalChatMute.deleteMany()),
      },
      {
        key: 'notificationSettings',
        group: 'people',
        label: 'Notification settings',
        description: "Everyone's push notification choices - they all go back to on.",
        tables: ['notification_settings'],
        ageFilter: null,
        count: () => prisma.notificationSettings.count(),
        clear: async () => removed(await prisma.notificationSettings.deleteMany()),
      },
      {
        key: 'lives',
        group: 'lives',
        label: 'Lives',
        description:
          'Lives that have ended, with their chat, stage guests and requests, moderators, ' +
          'mutes and bans. Lives running right now are kept.',
        tables: ['streams'],
        ageFilter: 'created',
        count: () => prisma.stream.count(),
        clear: async (before) => {
          const where = { ...NOT_RUNNING, ...olderThan(before) } satisfies Prisma.StreamWhereInput;
          const files = await this.filesOf({ stream: where }, null);
          return { ...removed(await prisma.stream.deleteMany({ where })), files };
        },
      },
      {
        key: 'chat',
        group: 'lives',
        label: 'Live chat',
        description: 'Messages and photos sent in lives. Lives running right now keep theirs.',
        tables: ['chat_messages'],
        ageFilter: 'created',
        count: () => prisma.chatMessage.count(),
        clear: async (before) => {
          const where = {
            stream: NOT_RUNNING,
            ...olderThan(before),
          } satisfies Prisma.ChatMessageWhereInput;
          const files = await this.filesOf(where, null);
          return { ...removed(await prisma.chatMessage.deleteMany({ where })), files };
        },
      },
      {
        key: 'stageGuests',
        group: 'lives',
        label: 'Stage guests',
        description: 'Who was on stage in which live. Lives running right now keep theirs.',
        tables: ['stream_guests'],
        ageFilter: null,
        count: () => prisma.streamGuest.count(),
        clear: async () =>
          removed(await prisma.streamGuest.deleteMany({ where: { stream: NOT_RUNNING } })),
      },
      {
        key: 'stageRequests',
        group: 'lives',
        label: 'Stage requests',
        description:
          "Asks to join a stage, and hosts' invitations. Lives running right now keep theirs.",
        tables: ['guest_requests'],
        ageFilter: null,
        count: () => prisma.guestRequest.count(),
        clear: async () =>
          removed(await prisma.guestRequest.deleteMany({ where: { stream: NOT_RUNNING } })),
      },
      {
        key: 'liveModerators',
        group: 'lives',
        label: 'Live moderators',
        description:
          'Whom hosts made moderators of their lives. Lives running right now keep theirs.',
        tables: ['moderators'],
        ageFilter: null,
        count: () => prisma.moderator.count(),
        clear: async () =>
          removed(await prisma.moderator.deleteMany({ where: { stream: NOT_RUNNING } })),
      },
      {
        key: 'roomBans',
        group: 'lives',
        label: 'Room bans',
        description:
          'People hosts banned from their lives, permanent bans included. Bans in lives running ' +
          'right now are kept.',
        tables: ['room_bans'],
        ageFilter: null,
        count: () => prisma.roomBan.count(),
        clear: async () =>
          removed(
            await prisma.roomBan.deleteMany({
              where: { OR: [{ streamId: null }, { stream: { is: NOT_RUNNING } }] },
            }),
          ),
      },
      {
        key: 'liveChatMutes',
        group: 'lives',
        label: 'Chat mutes in lives',
        description: "Who was muted in which live's chat. Lives running right now keep theirs.",
        tables: ['room_chat_mutes'],
        ageFilter: null,
        count: () => prisma.roomChatMute.count(),
        clear: async () =>
          removed(await prisma.roomChatMute.deleteMany({ where: { stream: NOT_RUNNING } })),
      },
      {
        key: 'recordingPermissions',
        group: 'lives',
        label: 'Recording permissions',
        description: 'Whom hosts let record their lives. Lives running right now keep theirs.',
        tables: ['recording_permissions'],
        ageFilter: null,
        count: () => prisma.recordingPermission.count(),
        clear: async () =>
          removed(await prisma.recordingPermission.deleteMany({ where: { stream: NOT_RUNNING } })),
      },
      {
        key: 'privateMessages',
        group: 'messages',
        label: 'Private messages',
        description: 'Messages between friends. A conversation left with none goes too.',
        tables: ['direct_messages', 'conversations'],
        ageFilter: 'created',
        count: () => prisma.directMessage.count(),
        clear: async (before) => {
          const messages = await prisma.directMessage.deleteMany({ where: olderThan(before) });
          await prisma.conversation.deleteMany({ where: { messages: { none: {} } } });
          return removed(messages);
        },
      },
      {
        key: 'notifications',
        group: 'messages',
        label: 'Notifications',
        description: "Everyone's notification inbox.",
        tables: ['notifications'],
        ageFilter: 'created',
        count: () => prisma.notification.count(),
        clear: async (before) =>
          removed(await prisma.notification.deleteMany({ where: olderThan(before) })),
      },
      {
        key: 'alerts',
        group: 'console',
        label: 'Alerts',
        description: 'The alerts staff sent to lives and to everyone.',
        tables: ['admin_alerts'],
        ageFilter: 'created',
        count: () => prisma.adminAlert.count(),
        clear: async (before) =>
          removed(await prisma.adminAlert.deleteMany({ where: olderThan(before) })),
      },
      {
        key: 'auditLog',
        group: 'console',
        label: 'Audit log',
        description:
          'What staff, hosts and moderators did. This removal becomes the first entry of what is left.',
        tables: ['audit_logs'],
        ageFilter: 'created',
        count: () => prisma.auditLog.count(),
        clear: async (before) =>
          removed(await prisma.auditLog.deleteMany({ where: olderThan(before) })),
      },
      {
        key: 'bannedPhrases',
        group: 'console',
        label: 'Banned phrases',
        description: "The chat filter's list - chat goes unfiltered until phrases are added again.",
        tables: ['banned_phrases'],
        ageFilter: null,
        count: () => prisma.bannedPhrase.count(),
        clear: async () => {
          const result = removed(await prisma.bannedPhrase.deleteMany());
          this.bannedPhrases.invalidate();
          return result;
        },
      },
      {
        key: 'appUpdates',
        group: 'console',
        label: 'App updates',
        description: 'Published versions of the app - phones stop being told about them.',
        tables: ['app_releases'],
        ageFilter: null,
        count: () => prisma.appRelease.count(),
        clear: async () => removed(await prisma.appRelease.deleteMany()),
      },
    ];
  }
}
