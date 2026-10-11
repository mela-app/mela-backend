import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GuestRequestInitiator, NotificationType } from '@prisma/client';
import { DomainEvents } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { SocialService } from '../social/social.service';
import { NotificationsService } from './notifications.service';
import { PushQueueService } from './push-queue.service';

const HOST = 'host-1';
const STREAM = 's1';

describe('NotificationsService', () => {
  const prisma = {
    user: { findUnique: jest.fn() },
    stream: { findUnique: jest.fn() },
    follow: { findMany: jest.fn() },
    scheduledLiveReminder: { findMany: jest.fn() },
    notification: {
      createManyAndReturn: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn(),
    },
    notificationSettings: { findMany: jest.fn(), findUnique: jest.fn(), upsert: jest.fn() },
    userSession: { updateMany: jest.fn() },
  };
  const redisClient = { set: jest.fn(), incr: jest.fn(), expire: jest.fn() };
  const redis = { getClient: () => redisClient } as unknown as RedisService;
  const events = { emit: jest.fn() };
  const social = { blockedEitherWayUserIds: jest.fn().mockResolvedValue([]) };
  const pushQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };

  const service = () =>
    new NotificationsService(
      prisma as unknown as PrismaService,
      redis,
      events as never,
      social as unknown as SocialService,
      pushQueue as unknown as PushQueueService,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    social.blockedEitherWayUserIds.mockResolvedValue([]);
    prisma.notificationSettings.findMany.mockResolvedValue([]);
    prisma.notification.createManyAndReturn.mockImplementation(
      ({ data }: { data: Array<Record<string, unknown>> }) =>
        Promise.resolve(
          data.map((row, index) => ({
            id: `n${index}`,
            readAt: null,
            createdAt: new Date(),
            ...row,
          })),
        ),
    );
  });

  describe('onStreamStarted', () => {
    const payload = { streamId: STREAM, hostId: HOST, title: 'Poker night' };

    it("a friends' live notifies only the followers the host follows back", async () => {
      redisClient.set.mockResolvedValue('OK');
      prisma.follow.findMany
        .mockResolvedValueOnce([{ followerId: 'friend-1' }, { followerId: 'fan-1' }])
        .mockResolvedValueOnce([{ followeeId: 'friend-1' }]);
      prisma.user.findUnique.mockResolvedValue({ displayName: 'Kebede' });

      await service().onStreamStarted({ ...payload, visibility: 'FRIENDS' });

      expect(prisma.follow.findMany).toHaveBeenLastCalledWith({
        where: { followerId: HOST, followeeId: { in: ['friend-1', 'fan-1'] } },
        select: { followeeId: true },
      });
      expect(prisma.notification.createManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [expect.objectContaining({ recipientId: 'friend-1' })],
        }),
      );
    });

    it('started from a scheduled live, also tells whoever asked to be reminded', async () => {
      redisClient.set.mockResolvedValue('OK');
      prisma.follow.findMany.mockResolvedValue([{ followerId: 'f1' }]);
      prisma.scheduledLiveReminder.findMany.mockResolvedValue([
        { userId: 'f1' },
        { userId: 'stranger-1' },
      ]);
      prisma.user.findUnique.mockResolvedValue({ displayName: 'Kebede' });

      await service().onStreamStarted({ ...payload, scheduledLiveId: 'e1', visibility: 'PUBLIC' });

      expect(prisma.notification.createManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [
            expect.objectContaining({ recipientId: 'f1' }),
            expect.objectContaining({ recipientId: 'stranger-1' }),
          ],
        }),
      );
    });

    it("a followers' live leaves out reminded people who don't follow", async () => {
      redisClient.set.mockResolvedValue('OK');
      prisma.follow.findMany.mockResolvedValue([{ followerId: 'f1' }]);
      prisma.scheduledLiveReminder.findMany.mockResolvedValue([{ userId: 'stranger-1' }]);
      prisma.user.findUnique.mockResolvedValue({ displayName: 'Kebede' });

      await service().onStreamStarted({
        ...payload,
        scheduledLiveId: 'e1',
        visibility: 'FOLLOWERS',
      });

      expect(prisma.notification.createManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({ data: [expect.objectContaining({ recipientId: 'f1' })] }),
      );
    });

    it('does nothing when the per-host cooldown is still active', async () => {
      redisClient.set.mockResolvedValue(null);

      await service().onStreamStarted(payload);

      expect(prisma.follow.findMany).not.toHaveBeenCalled();
    });

    it('notifies followers with the bell on, excluding blocked either way', async () => {
      redisClient.set.mockResolvedValue('OK');
      prisma.follow.findMany.mockResolvedValue([{ followerId: 'f1' }, { followerId: 'f2' }]);
      social.blockedEitherWayUserIds.mockResolvedValue(['f2']);
      prisma.user.findUnique.mockResolvedValue({ displayName: 'Kebede' });

      await service().onStreamStarted(payload);

      expect(redisClient.set).toHaveBeenCalledWith(`notif:golive:${HOST}`, '1', 'EX', 300, 'NX');
      expect(prisma.notification.createManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [
            {
              recipientId: 'f1',
              type: NotificationType.STREAM_STARTED,
              actorId: HOST,
              streamId: STREAM,
            },
          ],
        }),
      );
      expect(events.emit).toHaveBeenCalledWith(
        DomainEvents.NotificationCreated,
        expect.objectContaining({ recipientId: 'f1' }),
      );
      expect(pushQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientId: 'f1',
          body: expect.stringContaining('Kebede'),
          data: { type: NotificationType.STREAM_STARTED, streamId: STREAM, actorId: HOST },
        }),
      );
    });

    it('does nothing when nobody has the bell on', async () => {
      redisClient.set.mockResolvedValue('OK');
      prisma.follow.findMany.mockResolvedValue([]);

      await service().onStreamStarted(payload);

      expect(prisma.notification.createManyAndReturn).not.toHaveBeenCalled();
    });
  });

  describe('onViewerJoinedLive', () => {
    const KEBEDE = 'kebede';
    const payload = {
      streamId: STREAM,
      hostId: HOST,
      viewerId: KEBEDE,
      visibility: 'PUBLIC' as const,
    };
    const kebede = {
      id: KEBEDE,
      username: 'kebede',
      displayName: 'Kebede',
      avatarUrl: null,
      shareLiveJoins: true,
      status: 'ACTIVE',
    };

    beforeEach(() => {
      redisClient.set.mockResolvedValue('OK');
      redisClient.incr.mockResolvedValue(1);
      prisma.user.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === KEBEDE ? kebede : { id: HOST, displayName: 'Abebe' }),
      );
      prisma.stream.findUnique.mockResolvedValue({ title: 'Coffee talk' });
      prisma.follow.findMany.mockResolvedValue([
        { followerId: 'f1' },
        { followerId: 'f2' },
        { followerId: HOST },
      ]);
    });

    const recipients = () =>
      prisma.notification.createManyAndReturn.mock.calls.flatMap(
        ([{ data }]: [{ data: Array<{ recipientId: string }> }]) =>
          data.map((row) => row.recipientId),
      );

    it("tells the joiner's followers, not the host, with a push", async () => {
      await service().onViewerJoinedLive(payload);

      expect(recipients()).toEqual(['f1', 'f2']);
      expect(prisma.notification.createManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({
              type: NotificationType.FOLLOWING_JOINED_LIVE,
              actorId: KEBEDE,
              streamId: STREAM,
            }),
          ]),
        }),
      );
      expect(pushQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Joined a live', body: "Kebede joined Abebe's live" }),
      );
    });

    it('only once per live per joiner', async () => {
      redisClient.set.mockResolvedValue(null);

      await service().onViewerJoinedLive(payload);

      expect(redisClient.set).toHaveBeenCalledWith(
        `notif:joined:${STREAM}:${KEBEDE}`,
        '1',
        'EX',
        86400,
        'NX',
      );
      expect(prisma.notification.createManyAndReturn).not.toHaveBeenCalled();
    });

    it('at most three an hour from the same joiner', async () => {
      redisClient.incr.mockResolvedValue(4);

      await service().onViewerJoinedLive(payload);

      expect(prisma.notification.createManyAndReturn).not.toHaveBeenCalled();
    });

    it('nothing when the joiner stopped sharing their joins', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...kebede, shareLiveJoins: false });

      await service().onViewerJoinedLive(payload);

      expect(redisClient.set).not.toHaveBeenCalled();
      expect(prisma.notification.createManyAndReturn).not.toHaveBeenCalled();
    });

    it('leaves out anyone blocked either way with the joiner or the host, and who turned it off', async () => {
      social.blockedEitherWayUserIds.mockImplementation(async (id: string) =>
        id === HOST ? ['f2'] : [],
      );
      prisma.follow.findMany.mockResolvedValue([
        { followerId: 'f1' },
        { followerId: 'f2' },
        { followerId: 'f3' },
      ]);
      prisma.notificationSettings.findMany.mockImplementation(
        ({ where }: { where: { pushFollowingJoinedLive?: boolean } }) =>
          Promise.resolve(where.pushFollowingJoinedLive === false ? [{ userId: 'f3' }] : []),
      );

      await service().onViewerJoinedLive(payload);

      expect(recipients()).toEqual(['f1']);
    });

    it("a friends' live: only followers who are the host's friends hear", async () => {
      prisma.follow.findMany
        .mockResolvedValueOnce([{ followerId: 'f1' }, { followerId: 'f2' }])
        // Both follow the host; only f1 is followed back.
        .mockResolvedValueOnce([{ followerId: 'f1' }, { followerId: 'f2' }])
        .mockResolvedValueOnce([{ followeeId: 'f1' }]);

      await service().onViewerJoinedLive({ ...payload, visibility: 'FRIENDS' });

      expect(recipients()).toEqual(['f1']);
    });
  });

  it('onUserFollowed notifies the followee only', async () => {
    prisma.user.findUnique.mockResolvedValue({ displayName: 'Abebe' });

    await service().onUserFollowed({ followerId: 'f1', followeeId: 'host-2' });

    expect(prisma.notification.createManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          {
            recipientId: 'host-2',
            type: NotificationType.NEW_FOLLOWER,
            actorId: 'f1',
            streamId: null,
          },
        ],
      }),
    );
  });

  it('onModeratorGranted notifies the newly granted moderator', async () => {
    prisma.user.findUnique.mockResolvedValue({ displayName: 'Abebe' });

    await service().onModeratorGranted({
      hostId: HOST,
      streamId: STREAM,
      userId: 'mod-1',
      capabilities: [],
    });

    expect(prisma.notification.createManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          {
            recipientId: 'mod-1',
            type: NotificationType.MODERATOR_GRANTED,
            actorId: HOST,
            streamId: STREAM,
          },
        ],
      }),
    );
  });

  it('onStreamInviteSent notifies every recipient the sender already filtered', async () => {
    prisma.user.findUnique.mockResolvedValue({ displayName: 'Abebe' });
    prisma.stream.findUnique.mockResolvedValue({ title: 'Poker night' });

    await service().onStreamInviteSent({
      streamId: STREAM,
      senderId: HOST,
      recipientIds: ['f1', 'f2'],
    });

    expect(prisma.notification.createManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          {
            recipientId: 'f1',
            type: NotificationType.STREAM_INVITE,
            actorId: HOST,
            streamId: STREAM,
          },
          {
            recipientId: 'f2',
            type: NotificationType.STREAM_INVITE,
            actorId: HOST,
            streamId: STREAM,
          },
        ],
      }),
    );
  });

  it('does not queue a push for a recipient who turned that type off, but still writes the row', async () => {
    prisma.user.findUnique.mockResolvedValue({ displayName: 'Abebe' });
    prisma.notificationSettings.findMany.mockResolvedValue([
      { userId: 'f1', pushNewFollower: false },
    ]);

    await service().onUserFollowed({ followerId: HOST, followeeId: 'f1' });

    expect(events.emit).toHaveBeenCalledWith(DomainEvents.NotificationCreated, expect.anything());
    expect(pushQueue.enqueue).not.toHaveBeenCalled();
  });

  describe('security notices', () => {
    it('tells the account a password was added, with no actor', async () => {
      await service().onPasswordAdded({ userId: 'u1' });

      expect(prisma.notification.createManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [
            {
              recipientId: 'u1',
              type: NotificationType.PASSWORD_ADDED,
              actorId: null,
              streamId: null,
            },
          ],
        }),
      );
      expect(pushQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientId: 'u1',
          title: 'Password added',
          data: { type: NotificationType.PASSWORD_ADDED },
        }),
      );
    });

    it('always pushes a changed password - no setting turns it off', async () => {
      await service().onPasswordChanged({ userId: 'u1' });

      expect(prisma.notificationSettings.findMany).not.toHaveBeenCalled();
      expect(pushQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Password changed',
          data: { type: NotificationType.PASSWORD_CHANGED },
        }),
      );
    });
  });

  describe('report outcomes', () => {
    const resolved = (outcome: 'ACTIONED' | 'DISMISSED') => ({
      caseId: 'case-1',
      outcome,
      actorId: 'admin-1',
      targetType: 'CHAT_MESSAGE',
      label: 'Chat message from @ana',
      reporterIds: ['ben-1', 'cal-1'],
      note: null,
    });

    it('tells everyone who reported something that action was taken - not what it was', async () => {
      await service().onReportResolved(resolved('ACTIONED'));

      expect(prisma.notification.createManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [
            {
              recipientId: 'ben-1',
              type: NotificationType.REPORT_ACTIONED,
              actorId: null,
              streamId: null,
            },
            {
              recipientId: 'cal-1',
              type: NotificationType.REPORT_ACTIONED,
              actorId: null,
              streamId: null,
            },
          ],
        }),
      );
      expect(pushQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ recipientId: 'ben-1', title: 'Thanks for your report' }),
      );
    });

    it('tells them when nothing went against the guidelines', async () => {
      await service().onReportResolved(resolved('DISMISSED'));

      expect(pushQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'We reviewed your report',
          data: { type: NotificationType.REPORT_DISMISSED },
        }),
      );
    });
  });

  describe('onGuestRequestCreated', () => {
    const user = { id: 'g1', username: 'guest', displayName: 'Guest', avatarUrl: null };

    it("notifies the invitee of a host's stage invite", async () => {
      prisma.stream.findUnique.mockResolvedValue({ hostId: HOST, title: 'Poker night' });
      prisma.user.findUnique.mockResolvedValue({
        id: HOST,
        username: 'kebede',
        displayName: 'Kebede',
        avatarUrl: null,
      });

      await service().onGuestRequestCreated({
        streamId: STREAM,
        requestId: 'req-1',
        initiatedBy: GuestRequestInitiator.HOST,
        user,
        recipientIds: ['g1'],
      });

      expect(prisma.notification.createManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [
            {
              recipientId: 'g1',
              type: NotificationType.GUEST_INVITE,
              actorId: HOST,
              streamId: STREAM,
            },
          ],
        }),
      );
      expect(pushQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ recipientId: 'g1', body: expect.stringContaining('Kebede') }),
      );
    });

    it("stores nothing for a viewer's own raised hand", async () => {
      await service().onGuestRequestCreated({
        streamId: STREAM,
        requestId: 'req-1',
        initiatedBy: GuestRequestInitiator.VIEWER,
        user,
        recipientIds: [HOST],
      });

      expect(prisma.stream.findUnique).not.toHaveBeenCalled();
      expect(prisma.notification.createManyAndReturn).not.toHaveBeenCalled();
    });
  });

  describe('list/unreadCount/markRead', () => {
    // Nothing from anyone blocked either way; an account since deleted still shows.
    const inbox = {
      recipientId: 'u1',
      OR: [
        { actorId: null },
        {
          actor: {
            blockedBy: { none: { blockerId: 'u1' } },
            blocksMade: { none: { blockedId: 'u1' } },
          },
        },
      ],
    };

    it('pages the inbox newest-first with a cursor', async () => {
      prisma.notification.findMany.mockResolvedValue([{ id: 'n1' }]);

      const page = await service().list('u1', undefined, 30);

      expect(page).toEqual({ items: [{ id: 'n1' }], hasMore: false, nextCursor: null });
    });

    it('leaves out what came from anyone blocked either way, in the inbox and its count', async () => {
      prisma.notification.findMany.mockResolvedValue([]);
      prisma.notification.count.mockResolvedValue(0);

      await service().list('u1', 'n9', 30);
      await service().unreadCount('u1');

      expect(prisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { ...inbox, id: { lt: 'n9' } } }),
      );
      expect(prisma.notification.count).toHaveBeenCalledWith({ where: { ...inbox, readAt: null } });
    });

    it('reports the unread count', async () => {
      prisma.notification.count.mockResolvedValue(4);

      await expect(service().unreadCount('u1')).resolves.toEqual({ count: 4 });
    });

    it('marks every unread as read with {all: true}', async () => {
      await service().markRead('u1', { all: true });

      expect(prisma.notification.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { recipientId: 'u1', readAt: null } }),
      );
    });

    it('marks specific ids as read with {ids}', async () => {
      await service().markRead('u1', { ids: ['n1', 'n2'] });

      expect(prisma.notification.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { recipientId: 'u1', id: { in: ['n1', 'n2'] } } }),
      );
    });

    it('rejects neither "all" nor "ids"', async () => {
      await expect(service().markRead('u1', {})).rejects.toThrow(BadRequestException);
    });
  });

  describe('push token', () => {
    it('requires a sessionId to set a push token', async () => {
      await expect(service().setPushToken(undefined, 'tok')).rejects.toThrow(BadRequestException);
    });

    it('404s setting a token for a session that no longer exists', async () => {
      prisma.userSession.updateMany.mockResolvedValue({ count: 0 });

      await expect(service().setPushToken('sess-1', 'tok')).rejects.toThrow(NotFoundException);
    });

    it("takes the device's token away from any other session, so a signed-out account stops getting its pushes", async () => {
      prisma.userSession.updateMany.mockResolvedValue({ count: 1 });

      await expect(service().setPushToken('sess-2', 'tok')).resolves.toEqual({ ok: true });

      expect(prisma.userSession.updateMany).toHaveBeenNthCalledWith(1, {
        where: { pushToken: 'tok', id: { not: 'sess-2' } },
        data: { pushToken: null },
      });
      expect(prisma.userSession.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: 'sess-2' },
        data: { pushToken: 'tok' },
      });
    });

    it('lets every account on the same app install share the token, and nobody else', async () => {
      prisma.userSession.updateMany.mockResolvedValue({ count: 1 });

      await service().setPushToken('sess-2', 'tok', 'install-0123456789ab', 'u1');

      expect(prisma.userSession.updateMany).toHaveBeenNthCalledWith(1, {
        where: {
          pushToken: 'tok',
          id: { not: 'sess-2' },
          // Signed in again on the same phone: the earlier session of the same account lets go too.
          OR: [
            { installationId: null },
            { installationId: { not: 'install-0123456789ab' } },
            { userId: 'u1' },
          ],
        },
        data: { pushToken: null },
      });
      expect(prisma.userSession.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: 'sess-2' },
        data: { pushToken: 'tok', installationId: 'install-0123456789ab' },
      });
    });

    it('clearing with no sessionId is a harmless no-op', async () => {
      await expect(service().clearPushToken(undefined)).resolves.toEqual({ ok: true });
      expect(prisma.userSession.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('settings', () => {
    it('defaults every type to on when no row exists yet', async () => {
      prisma.notificationSettings.findUnique.mockResolvedValue(null);

      await expect(service().getSettings('u1')).resolves.toEqual({
        pushStreamStarted: true,
        pushNewFollower: true,
        pushStreamInvite: true,
        pushModeratorGranted: true,
        pushGuestInvite: true,
        pushDirectMessages: true,
        pushFollowingJoinedLive: true,
      });
    });

    it('upserts a partial update', async () => {
      prisma.notificationSettings.upsert.mockResolvedValue({
        pushStreamStarted: false,
        pushNewFollower: true,
        pushStreamInvite: true,
        pushModeratorGranted: true,
        pushGuestInvite: true,
        pushDirectMessages: true,
        pushFollowingJoinedLive: true,
      });

      const result = await service().updateSettings('u1', { pushStreamStarted: false });

      expect(result.pushStreamStarted).toBe(false);
      expect(prisma.notificationSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'u1' }, update: { pushStreamStarted: false } }),
      );
    });
  });

  describe('direct message pushes', () => {
    const payload = (text: string) => ({
      message: {
        id: 'm1',
        senderId: 'friend-1',
        recipientId: 'me',
        text,
        clientId: null,
        createdAt: new Date(),
        readAt: null,
      },
      sender: { id: 'friend-1', username: 'abebe', displayName: 'Abebe', avatarUrl: null },
      recipient: { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null },
      recipientUnreadCount: 1,
    });

    it("pushes the sender's name and text, one notification per conversation, no inbox row", async () => {
      prisma.notificationSettings.findUnique.mockResolvedValue(null);

      await service().onDirectMessageSent(payload('  See you at the live tonight  '));

      expect(pushQueue.enqueue).toHaveBeenCalledWith({
        recipientId: 'me',
        title: 'Abebe',
        body: 'See you at the live tonight',
        data: { type: 'DIRECT_MESSAGE', actorId: 'friend-1' },
        collapseKey: 'dm-friend-1',
      });
      expect(prisma.notification.createManyAndReturn).not.toHaveBeenCalled();
    });

    it('shortens a long message', async () => {
      prisma.notificationSettings.findUnique.mockResolvedValue(null);

      await service().onDirectMessageSent(payload('x'.repeat(500)));

      const body = (pushQueue.enqueue.mock.calls[0][0] as { body: string }).body;
      expect(body).toHaveLength(140);
      expect(body.endsWith('…')).toBe(true);
    });

    it('respects the recipient turning message pushes off', async () => {
      prisma.notificationSettings.findUnique.mockResolvedValue({ pushDirectMessages: false });

      await service().onDirectMessageSent(payload('hi'));

      expect(pushQueue.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('scheduled lives starting soon', () => {
    it("tells the reminded it's starting soon, from the host, skipping anyone blocked", async () => {
      social.blockedEitherWayUserIds.mockResolvedValue(['u2']);
      prisma.user.findUnique.mockResolvedValue({ id: HOST, displayName: 'Kebede' });

      await service().onScheduledLiveStartingSoon({
        scheduledLiveId: 'e1',
        hostId: HOST,
        title: 'Poker night',
        startsAt: new Date(),
        userIds: ['u1', 'u2'],
      });

      expect(prisma.notification.createManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [
            {
              recipientId: 'u1',
              type: NotificationType.SCHEDULED_LIVE_SOON,
              actorId: HOST,
              streamId: null,
            },
          ],
        }),
      );
      expect(pushQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Starting soon',
          body: 'Kebede goes live soon: Poker night',
        }),
      );
    });
  });
});
