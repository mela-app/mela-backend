import {
  AdminPermission,
  AuditActorRole,
  GuestRequestInitiator,
  PlatformRole,
  StreamEndReason,
} from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RequestContext } from '../common/request-context/request-context';
import { AuditEventsListener } from './audit-events.listener';
import { AuditService } from './audit.service';

const MESSAGE = 'a3d4e5f6-7b8c-4d1e-9f0a-1b2c3d4e5f6a';

describe('AuditEventsListener', () => {
  const audit = { record: jest.fn() };
  const prisma = {
    user: { findUnique: jest.fn(), findFirst: jest.fn() },
    stream: { findUnique: jest.fn() },
    chatMessage: { findUnique: jest.fn() },
  };
  const listener = () => new AuditEventsListener(audit as unknown as AuditService, prisma as unknown as PrismaService);
  const entry = () => audit.record.mock.calls[0][0];

  beforeEach(() => {
    jest.clearAllMocks();
    audit.record.mockResolvedValue(undefined);
    prisma.user.findUnique.mockResolvedValue({ username: 'troll' });
    prisma.stream.findUnique.mockResolvedValue({ hostId: 'host-1', title: 'Friday poker night' });
  });

  it('keeps the request it came from, even though labels are looked up afterwards', async () => {
    await RequestContext.run({ ip: '203.0.113.9', userAgent: 'Chrome', surface: 'admin' }, () =>
      listener().onSuspended({ userId: 'u1', suspendedBy: 'admin-1', reason: 'Spam' }),
    );

    expect(entry()).toEqual(
      expect.objectContaining({
        action: 'user.suspended',
        actorId: 'admin-1',
        target: { type: 'USER', id: 'u1', label: '@troll' },
        reason: 'Spam',
        context: { ip: '203.0.113.9', userAgent: 'Chrome', surface: 'admin' },
      }),
    );
  });

  describe('lives', () => {
    it('leaves a locked live to the lock entry', async () => {
      await listener().onStreamEnded({ streamId: 's1', reason: StreamEndReason.LOCKED, message: 'Graphic' });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('credits a lost connection to the system and a normal end to the host', async () => {
      const startedAt = new Date('2026-09-27T10:00:00Z');
      prisma.stream.findUnique.mockResolvedValue({
        hostId: 'host-1',
        title: 'Friday poker night',
        startedAt,
        endedAt: new Date(startedAt.getTime() + 90_000),
        peakViewerCount: 12,
      });

      await listener().onStreamEnded({ streamId: 's1', reason: StreamEndReason.HOST_DISCONNECTED });
      await listener().onStreamEnded({ streamId: 's1', reason: StreamEndReason.HOST_ENDED });

      expect(audit.record.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          actorId: null,
          actorRole: AuditActorRole.SYSTEM,
          metadata: { reason: StreamEndReason.HOST_DISCONNECTED, peakViewerCount: 12, durationSeconds: 90 },
        }),
      );
      expect(audit.record.mock.calls[1][0]).toEqual(
        expect.objectContaining({ actorId: 'host-1', actorRole: AuditActorRole.HOST }),
      );
    });

    it('records a lock with the admin, the reason and the host', async () => {
      await listener().onStreamLocked({ streamId: 's1', hostId: 'host-1', actorId: 'admin-1', reason: 'Graphic' });

      expect(entry()).toEqual(
        expect.objectContaining({
          action: 'stream.locked',
          actorId: 'admin-1',
          target: { type: 'STREAM', id: 's1', label: 'Friday poker night' },
          streamId: 's1',
          reason: 'Graphic',
          metadata: { hostId: 'host-1' },
        }),
      );
    });
  });

  describe('moderation inside a live', () => {
    it('credits a deleted message to whoever deleted it, with an excerpt of what it said', async () => {
      prisma.chatMessage.findUnique.mockResolvedValue({
        text: `  buy   followers at ${'x'.repeat(100)}`,
        userId: 'u9',
        user: { username: 'spammer' },
        stream: { hostId: 'host-1' },
      });

      await listener().onMessageDeleted({ streamId: 's1', messageId: MESSAGE, actorId: 'mod-1' });

      expect(entry()).toEqual(
        expect.objectContaining({
          action: 'chat.message_deleted',
          actorId: 'mod-1',
          hostId: 'host-1',
          streamId: 's1',
          metadata: { senderId: 'u9', sender: '@spammer' },
        }),
      );
      expect(entry().target.label.startsWith('buy followers at')).toBe(true);
      expect(entry().target.label).toHaveLength(80);
    });

    it('tells a removed guest from one who left', async () => {
      await listener().onGuestRemoved({
        streamId: 's1',
        hostId: 'host-1',
        userId: 'g1',
        wasRemovedByHostOrModerator: true,
        actorId: 'mod-1',
      });
      await listener().onGuestRemoved({ streamId: 's1', hostId: 'host-1', userId: 'g1', wasRemovedByHostOrModerator: false });

      expect(audit.record.mock.calls[0][0]).toEqual(
        expect.objectContaining({ action: 'guest.removed', actorId: 'mod-1', hostId: 'host-1' }),
      );
      expect(audit.record.mock.calls[1][0]).toEqual(
        expect.objectContaining({ action: 'guest.left', actorId: 'g1', actorRole: AuditActorRole.USER }),
      );
    });

    it("tells a viewer's raised hand from the host's invitation", async () => {
      const user = { id: 'v1', username: 'viewer', displayName: 'Viewer', avatarUrl: null };

      await listener().onGuestRequest({
        streamId: 's1',
        requestId: 'q1',
        initiatedBy: GuestRequestInitiator.VIEWER,
        user,
        recipientIds: [],
      });
      await listener().onGuestRequest({
        streamId: 's1',
        requestId: 'q2',
        initiatedBy: GuestRequestInitiator.HOST,
        user,
        recipientIds: [],
      });

      expect(audit.record.mock.calls[0][0]).toEqual(expect.objectContaining({ action: 'guest.requested', actorId: 'v1' }));
      expect(audit.record.mock.calls[1][0]).toEqual(
        expect.objectContaining({
          action: 'guest.invited',
          actorId: 'host-1',
          actorRole: AuditActorRole.HOST,
          target: { type: 'USER', id: 'v1', label: '@viewer' },
        }),
      );
    });
  });

  describe('the console itself', () => {
    it('records a failed sign-in against the account it tried, labelled with the email typed', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'admin-1', username: 'admin' });

      await listener().onAdminSignInFailed({ email: 'Admin@Example.com', reason: 'rate_limited' });

      expect(entry()).toEqual(
        expect.objectContaining({
          action: 'admin.sign_in_failed',
          actorRole: AuditActorRole.SYSTEM,
          actorLabel: 'Admin@Example.com',
          target: { type: 'USER', id: 'admin-1', label: '@admin' },
          metadata: { reason: 'rate_limited' },
        }),
      );
    });

    it('keeps what a profile said before staff edited it', async () => {
      await listener().onProfileModerated({
        userId: 'u9',
        actorId: 'admin-1',
        reason: 'Offensive name',
        changes: { username: { from: 'bad_name', to: 'user_9' } },
      });

      expect(entry()).toEqual(
        expect.objectContaining({
          action: 'user.profile_edited',
          reason: 'Offensive name',
          metadata: { changes: { username: { from: 'bad_name', to: 'user_9' } } },
        }),
      );
    });

    it('records role changes with both roles, and what a new moderator may do', async () => {
      await listener().onRoleChanged({
        userId: 'u9',
        actorId: 'admin-1',
        from: PlatformRole.USER,
        to: PlatformRole.PLATFORM_MODERATOR,
        permissions: [AdminPermission.VIEW_USERS],
      });

      expect(entry().metadata).toEqual({
        from: PlatformRole.USER,
        to: PlatformRole.PLATFORM_MODERATOR,
        permissions: [AdminPermission.VIEW_USERS],
      });
    });

    it("records a moderator's access before and after a change", async () => {
      await listener().onAdminPermissionsChanged({
        userId: 'u9',
        actorId: 'admin-1',
        from: [AdminPermission.VIEW_LIVES],
        to: [AdminPermission.VIEW_LIVES, AdminPermission.MANAGE_LIVES],
      });

      expect(entry()).toEqual(
        expect.objectContaining({
          action: 'user.permissions_changed',
          actorId: 'admin-1',
          metadata: { from: [AdminPermission.VIEW_LIVES], to: [AdminPermission.VIEW_LIVES, AdminPermission.MANAGE_LIVES] },
        }),
      );
    });
  });

  it('logs, rather than throws, when building an entry fails', async () => {
    prisma.user.findUnique.mockRejectedValue(new Error('db down'));

    await expect(listener().onFollowed({ followerId: 'u1', followeeId: 'u2' })).resolves.toBeUndefined();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
