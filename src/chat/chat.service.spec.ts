import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ChatModerationStatus } from '@prisma/client';
import { PermissionsService } from '../common/permissions/permissions.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { RedisService } from '../common/redis/redis.service';
import { StorageProvider } from '../common/storage/storage-provider.interface';
import { ModeratorsService } from '../moderators/moderators.service';
import { RoomChatMutesService } from '../room-chat-mutes/room-chat-mutes.service';
import { StreamsService } from '../streams/streams.service';
import { BannedPhrasesService } from './banned-phrases.service';
import { CHAT_RATE_LIMIT, ChatService } from './chat.service';

const LIVE = '3f1c9a52-7c2e-4a8b-9d7e-2b6f0c1d4e5a';
const PHOTO_KEY = `chat-images/${LIVE}/5f0c2b1a-3d4e-4f5a-8b6c-7d8e9f0a1b2c.jpg`;

describe('ChatService', () => {
  const row = (id: string, text = 'hi') => ({
    id,
    streamId: LIVE,
    text,
    createdAt: new Date('2026-09-26T12:00:00Z'),
    user: { id: 'user-1', username: 'ana', displayName: 'Ana', avatarUrl: null },
  });
  const prisma = {
    chatMessage: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      findFirst: jest.fn(),
    },
    stream: { update: jest.fn() },
    user: { findMany: jest.fn() },
  };
  const redisClient = { get: jest.fn(), set: jest.fn() };
  const redis = { getClient: () => redisClient };
  const rateLimit = { take: jest.fn() };
  const streams = { findLive: jest.fn() };
  const realPermissions = new PermissionsService();
  const permissions = { isHost: jest.fn(), hasChannelCapability: jest.fn(), moderationTargetRefusal: jest.fn() };
  const moderators = { findActiveGrant: jest.fn(), isActiveModerator: jest.fn() };
  const bannedPhrases = { match: jest.fn(), mask: jest.fn() };
  const events = { emit: jest.fn() };
  const roomChatMutes = { findActive: jest.fn() };
  const config = { get: (key: string) => (key === 'CHAT_LINK_DOMAINS' ? 'mela.example' : undefined) };
  const storage = {
    publicUrl: jest.fn((key: string) => `https://media.example/${key}`),
    createUploadUrl: jest.fn(),
  };

  const service = () =>
    new ChatService(
      prisma as unknown as PrismaService,
      redis as unknown as RedisService,
      rateLimit as unknown as RateLimitService,
      streams as unknown as StreamsService,
      permissions as unknown as PermissionsService,
      moderators as unknown as ModeratorsService,
      bannedPhrases as unknown as BannedPhrasesService,
      events as unknown as EventEmitter2,
      roomChatMutes as unknown as RoomChatMutesService,
      config as unknown as ConfigService,
      storage as unknown as StorageProvider,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    rateLimit.take.mockResolvedValue(0);
    roomChatMutes.findActive.mockResolvedValue(null);
    redisClient.get.mockResolvedValue(null);
    prisma.chatMessage.create.mockImplementation(({ data }: { data: { text: string } }) =>
      Promise.resolve(row('m1', data.text)),
    );
    streams.findLive.mockResolvedValue({ id: LIVE, hostId: 'host-1' });
    permissions.isHost.mockImplementation((requesterId: string, hostId: string) => requesterId === hostId);
    permissions.hasChannelCapability.mockReturnValue(false);
    permissions.moderationTargetRefusal.mockImplementation(
      (requesterId: string, hostId: string, targetId: string, targetIsModerator: boolean) =>
        realPermissions.moderationTargetRefusal(requesterId, hostId, targetId, targetIsModerator),
    );
    moderators.findActiveGrant.mockResolvedValue(null);
    moderators.isActiveModerator.mockResolvedValue(false);
    bannedPhrases.match.mockResolvedValue([]);
    bannedPhrases.mask.mockImplementation((text: string) => Promise.resolve(text));
  });

  describe('send', () => {
    it('saves the cleaned text and hands back what everyone sees', async () => {
      const result = await service().send(LIVE, 'user-1', '  gg\n\nwp  ');

      expect(prisma.chatMessage.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: { streamId: LIVE, userId: 'user-1', text: 'gg wp' } }),
      );
      expect(result).toEqual({
        ok: true,
        resent: false,
        message: {
          id: 'm1',
          streamId: LIVE,
          text: 'gg wp',
          createdAt: new Date('2026-09-26T12:00:00Z'),
          sender: { id: 'user-1', username: 'ana', displayName: 'Ana', avatarUrl: null },
          mentions: [],
        },
      });
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('names the accounts its @usernames mention, however they were typed, and nothing else', async () => {
      prisma.user.findMany.mockResolvedValue([
        { id: 'u-kebede', username: 'Kebede' },
        { id: 'u-sara', username: 'sara_99' },
      ]);

      const result = await service().send(LIVE, 'user-1', '@kebede and @sara_99 - ask @nobody, not me@home');

      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { username: { in: ['kebede', 'sara_99', 'nobody'], mode: 'insensitive' } },
        select: { id: true, username: true },
      });
      expect(result).toMatchObject({
        ok: true,
        message: {
          mentions: [
            { id: 'u-kebede', username: 'Kebede' },
            { id: 'u-sara', username: 'sara_99' },
          ],
        },
      });
    });

    it('refuses an empty or oversized message before spending a rate-limit token', async () => {
      await expect(service().send(LIVE, 'user-1', ' \n ')).resolves.toEqual({
        ok: false,
        error: 'MESSAGE_EMPTY',
      });
      // Varied text: a run of one character would be collapsed as a flood first.
      await expect(service().send(LIVE, 'user-1', 'ab'.repeat(101))).resolves.toEqual({
        ok: false,
        error: 'MESSAGE_TOO_LONG',
      });
      expect(rateLimit.take).not.toHaveBeenCalled();
      expect(prisma.chatMessage.create).not.toHaveBeenCalled();
    });

    it('refuses someone muted in this live for a while, saying when it lifts, without spending a token', async () => {
      jest.useFakeTimers({ now: new Date('2026-09-27T12:00:00Z') });
      try {
        roomChatMutes.findActive.mockResolvedValue({ expiresAt: new Date('2026-09-27T12:05:00Z') });

        await expect(service().send(LIVE, 'user-1', 'let me talk')).resolves.toEqual({
          ok: false,
          error: 'CHAT_MUTED',
          retryAfterMs: 5 * 60 * 1000,
        });
        expect(roomChatMutes.findActive).toHaveBeenCalledWith(LIVE, 'user-1');
        expect(rateLimit.take).not.toHaveBeenCalled();
        expect(prisma.chatMessage.create).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('refuses someone muted until the live ends with no retry time', async () => {
      roomChatMutes.findActive.mockResolvedValue({ expiresAt: null });

      await expect(service().send(LIVE, 'user-1', 'hello?')).resolves.toEqual({ ok: false, error: 'CHAT_MUTED' });
    });

    it('still answers a resend of a message that went through before the mute', async () => {
      redisClient.get.mockResolvedValue('m0');
      prisma.chatMessage.findUnique.mockResolvedValue(row('m0', 'sent earlier'));
      roomChatMutes.findActive.mockResolvedValue({ expiresAt: null });

      const result = await service().send(LIVE, 'user-1', 'sent earlier', 'client-1');

      expect(result).toMatchObject({ ok: true, resent: true });
      expect(roomChatMutes.findActive).not.toHaveBeenCalled();
    });

    it('rejects a REJECT-severity banned-phrase match before spending a rate-limit token', async () => {
      bannedPhrases.match.mockResolvedValue([{ phrase: 'slur', severity: 'REJECT' }]);

      await expect(service().send(LIVE, 'user-1', 'you are a slur')).resolves.toEqual({
        ok: false,
        error: 'MESSAGE_BLOCKED',
      });
      expect(rateLimit.take).not.toHaveBeenCalled();
      expect(prisma.chatMessage.create).not.toHaveBeenCalled();
    });

    it('masks a MASK-severity match instead of rejecting the send', async () => {
      bannedPhrases.match.mockResolvedValue([{ phrase: 'darn', severity: 'MASK' }]);
      bannedPhrases.mask.mockResolvedValue('oh ****');

      const result = await service().send(LIVE, 'user-1', 'oh darn');

      expect(prisma.chatMessage.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: { streamId: LIVE, userId: 'user-1', text: 'oh ****' } }),
      );
      expect(result).toMatchObject({ ok: true });
    });

    it('holds back a sender over the rate limit, per person per live', async () => {
      rateLimit.take.mockResolvedValueOnce(1200);

      await expect(service().send(LIVE, 'user-1', 'spam')).resolves.toEqual({
        ok: false,
        error: 'RATE_LIMITED',
        retryAfterMs: 1200,
      });
      expect(rateLimit.take).toHaveBeenCalledWith(`ratelimit:chat:${LIVE}:user-1`, CHAT_RATE_LIMIT);
      expect(prisma.chatMessage.create).not.toHaveBeenCalled();
    });

    it('rejects a message linking to a domain that is not allowlisted', async () => {
      await expect(service().send(LIVE, 'user-1', 'dm me at scam-site.example')).resolves.toEqual({
        ok: false,
        error: 'LINK_NOT_ALLOWED',
      });
      expect(prisma.chatMessage.create).not.toHaveBeenCalled();
    });

    it('lets through links to the platform domains in CHAT_LINK_DOMAINS, subdomains included', async () => {
      await expect(service().send(LIVE, 'user-1', 'watch at https://share.mela.example/live/1')).resolves.toMatchObject(
        { ok: true },
      );
      await expect(service().send(LIVE, 'user-1', 'or mela.example.evil.test')).resolves.toEqual({
        ok: false,
        error: 'LINK_NOT_ALLOWED',
      });
    });

    it('remembers a message by its client id, so a resend returns the first one', async () => {
      await service().send(LIVE, 'user-1', 'hello', 'c-42');
      expect(redisClient.set).toHaveBeenCalledWith('chat:sent:user-1:c-42', 'm1', 'EX', 120);

      redisClient.get.mockResolvedValueOnce('m1');
      prisma.chatMessage.findUnique.mockResolvedValueOnce(row('m1', 'hello'));
      const resend = await service().send(LIVE, 'user-1', 'hello', 'c-42');

      expect(resend).toMatchObject({ ok: true, resent: true, message: { id: 'm1' } });
      expect(prisma.chatMessage.create).toHaveBeenCalledTimes(1);
      expect(rateLimit.take).toHaveBeenCalledTimes(1);
    });
  });

  describe("the host's photos", () => {
    const withPhoto = () =>
      prisma.chatMessage.create.mockImplementationOnce(({ data }: { data: { text: string; imageUrl?: string } }) =>
        Promise.resolve({ ...row('m1', data.text), imageUrl: data.imageUrl ?? null }),
      );

    it('posts a photo from the host, with or without a caption', async () => {
      withPhoto();
      const result = await service().send(LIVE, 'host-1', '', 'c1', PHOTO_KEY);

      expect(prisma.chatMessage.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { streamId: LIVE, userId: 'host-1', text: '', imageUrl: `https://media.example/${PHOTO_KEY}` },
        }),
      );
      expect(result).toMatchObject({ ok: true, message: { text: '', imageUrl: `https://media.example/${PHOTO_KEY}` } });
      expect(bannedPhrases.match).not.toHaveBeenCalled();

      withPhoto();
      await expect(service().send(LIVE, 'host-1', ' tonight\n', 'c2', PHOTO_KEY)).resolves.toMatchObject({
        ok: true,
        message: { text: 'tonight' },
      });
    });

    it('is the host alone - a moderator or viewer is refused before anything is saved', async () => {
      await expect(service().send(LIVE, 'user-1', 'look', undefined, PHOTO_KEY)).resolves.toEqual({
        ok: false,
        error: 'NOT_ALLOWED',
      });
      streams.findLive.mockResolvedValueOnce(null);
      await expect(service().send(LIVE, 'host-1', '', undefined, PHOTO_KEY)).resolves.toEqual({
        ok: false,
        error: 'NOT_ALLOWED',
      });
      expect(prisma.chatMessage.create).not.toHaveBeenCalled();
    });

    it('only takes a photo this API handed out for this live', async () => {
      for (const key of [
        `chat-images/9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a/5f0c2b1a-3d4e-4f5a-8b6c-7d8e9f0a1b2c.jpg`,
        `chat-images/${LIVE}/../avatars/5f0c2b1a-3d4e-4f5a-8b6c-7d8e9f0a1b2c.jpg`,
        `chat-images/${LIVE}/5f0c2b1a-3d4e-4f5a-8b6c-7d8e9f0a1b2c.gif`,
        'avatars/host-1/5f0c2b1a-3d4e-4f5a-8b6c-7d8e9f0a1b2c.jpg',
        'https://elsewhere.example/x.jpg',
      ]) {
        await expect(service().send(LIVE, 'host-1', '', undefined, key)).resolves.toEqual({
          ok: false,
          error: 'IMAGE_INVALID',
        });
      }
      expect(prisma.chatMessage.create).not.toHaveBeenCalled();
    });

    it('still holds a caption to the usual length', async () => {
      await expect(service().send(LIVE, 'host-1', 'ab'.repeat(101), undefined, PHOTO_KEY)).resolves.toEqual({
        ok: false,
        error: 'MESSAGE_TOO_LONG',
      });
    });

    it('hands the host an upload for a new photo in this live, and no one else', async () => {
      storage.createUploadUrl.mockResolvedValue({ uploadUrl: 'https://put.example', publicUrl: 'https://get.example' });

      const upload = await service().createImageUploadUrl(LIVE, 'host-1', 'image/png');

      expect(upload).toEqual({
        uploadUrl: 'https://put.example',
        publicUrl: 'https://get.example',
        imageKey: expect.stringMatching(new RegExp(`^chat-images/${LIVE}/[0-9a-f-]{36}\\.png$`)),
      });
      expect(storage.createUploadUrl).toHaveBeenCalledWith(upload.imageKey, 'image/png');

      await expect(service().createImageUploadUrl(LIVE, 'user-1', 'image/jpeg')).rejects.toThrow(ForbiddenException);
      streams.findLive.mockResolvedValueOnce(null);
      await expect(service().createImageUploadUrl(LIVE, 'host-1', 'image/jpeg')).rejects.toThrow(NotFoundException);
    });

    it('pins a photo as one', async () => {
      prisma.chatMessage.findFirst.mockResolvedValue({
        id: 'm1',
        text: '',
        imageUrl: 'https://media.example/x.jpg',
        user: { displayName: 'Host' },
      });

      await service().pin(LIVE, 'm1', 'host-1');

      expect(events.emit).toHaveBeenCalledWith('chat_message.pinned', expect.objectContaining({ text: '📷 Photo' }));
    });
  });

  describe('history', () => {
    it('hands out the latest page oldest first, saying whether older ones exist', async () => {
      // Newest first from the database, one more than asked for.
      prisma.chatMessage.findMany.mockResolvedValue([row('m3'), row('m2'), row('m1')]);

      const page = await service().history(LIVE, { limit: 2 });

      expect(page.messages.map((message) => message.id)).toEqual(['m2', 'm3']);
      expect(page.hasEarlier).toBe(true);
      expect(prisma.chatMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            streamId: LIVE,
            moderationStatus: ChatModerationStatus.VISIBLE,
            id: { lt: undefined, gt: undefined },
          },
          orderBy: { id: 'desc' },
          take: 3,
        }),
      );
    });

    it('pages by message id in either direction', async () => {
      prisma.chatMessage.findMany.mockResolvedValue([row('m9')]);

      const page = await service().history(LIVE, { limit: 50, before: 'b', after: 'a' });

      expect(page).toMatchObject({ hasEarlier: false });
      expect(prisma.chatMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: { lt: 'b', gt: 'a' } }),
        }),
      );
    });

    it("keeps an ended live's chat private", async () => {
      streams.findLive.mockResolvedValue(null);

      await expect(service().history(LIVE, { limit: 50 })).rejects.toThrow(NotFoundException);
      expect(prisma.chatMessage.findMany).not.toHaveBeenCalled();
    });

    it("looks up every page's mentions in one go", async () => {
      prisma.chatMessage.findMany.mockResolvedValue([row('m2', 'thanks @ana'), row('m1', '@Ana @bo hi')]);
      prisma.user.findMany.mockResolvedValue([{ id: 'u-ana', username: 'ana' }]);

      const page = await service().history(LIVE, { limit: 50 });

      expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { username: { in: ['ana', 'bo'], mode: 'insensitive' } } }),
      );
      expect(page.messages.map((message) => message.mentions)).toEqual([
        [{ id: 'u-ana', username: 'ana' }],
        [{ id: 'u-ana', username: 'ana' }],
      ]);
    });
  });

  describe('delete', () => {
    const canDelete = () => {
      moderators.findActiveGrant.mockResolvedValue({ capabilities: ['DELETE_MESSAGES'] });
      permissions.hasChannelCapability.mockReturnValue(true);
    };

    it("lets the host delete anyone's message", async () => {
      prisma.chatMessage.updateMany.mockResolvedValue({ count: 1 });

      await expect(service().delete(LIVE, 'm1', 'host-1')).resolves.toEqual({ ok: true });
      expect(moderators.findActiveGrant).not.toHaveBeenCalled();
      expect(prisma.chatMessage.findFirst).not.toHaveBeenCalled();
      expect(prisma.chatMessage.updateMany).toHaveBeenCalledWith({
        where: { id: 'm1', streamId: LIVE, moderationStatus: ChatModerationStatus.VISIBLE },
        data: { moderationStatus: ChatModerationStatus.DELETED },
      });
      expect(events.emit).toHaveBeenCalledWith('chat_message.deleted', {
        streamId: LIVE,
        messageId: 'm1',
        actorId: 'host-1',
      });
    });

    it("lets a moderator holding DELETE_MESSAGES delete a viewer's message", async () => {
      canDelete();
      prisma.chatMessage.findFirst.mockResolvedValue({ userId: 'viewer-2' });
      prisma.chatMessage.updateMany.mockResolvedValue({ count: 1 });

      await expect(service().delete(LIVE, 'm1', 'mod-1')).resolves.toEqual({ ok: true });
      expect(moderators.findActiveGrant).toHaveBeenCalledWith(LIVE, 'mod-1');
      expect(moderators.isActiveModerator).toHaveBeenCalledWith(LIVE, 'viewer-2');
      expect(events.emit).toHaveBeenCalledWith('chat_message.deleted', {
        streamId: LIVE,
        messageId: 'm1',
        actorId: 'mod-1',
      });
    });

    it("never lets a moderator delete another moderator's message, or the host's", async () => {
      canDelete();
      prisma.chatMessage.findFirst.mockResolvedValueOnce({ userId: 'mod-2' });
      moderators.isActiveModerator.mockResolvedValueOnce(true);
      await expect(service().delete(LIVE, 'm1', 'mod-1')).resolves.toEqual({ ok: false, error: 'NOT_ALLOWED' });

      prisma.chatMessage.findFirst.mockResolvedValueOnce({ userId: 'host-1' });
      await expect(service().delete(LIVE, 'm2', 'mod-1')).resolves.toEqual({ ok: false, error: 'NOT_ALLOWED' });
      expect(prisma.chatMessage.updateMany).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('lets a moderator delete their own message', async () => {
      canDelete();
      prisma.chatMessage.findFirst.mockResolvedValue({ userId: 'mod-1' });
      prisma.chatMessage.updateMany.mockResolvedValue({ count: 1 });

      await expect(service().delete(LIVE, 'm1', 'mod-1')).resolves.toEqual({ ok: true });
      expect(moderators.isActiveModerator).not.toHaveBeenCalled();
    });

    it('never lets a viewer delete a message, not even their own', async () => {
      await expect(service().delete(LIVE, 'm1', 'user-1')).resolves.toEqual({ ok: false, error: 'NOT_ALLOWED' });
      expect(prisma.chatMessage.findFirst).not.toHaveBeenCalled();
      expect(prisma.chatMessage.updateMany).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('answers NOT_FOUND for a message already deleted or that never existed', async () => {
      prisma.chatMessage.updateMany.mockResolvedValue({ count: 0 });
      await expect(service().delete(LIVE, 'ghost', 'host-1')).resolves.toEqual({ ok: false, error: 'NOT_FOUND' });

      canDelete();
      prisma.chatMessage.findFirst.mockResolvedValue(null);
      await expect(service().delete(LIVE, 'ghost', 'mod-1')).resolves.toEqual({ ok: false, error: 'NOT_FOUND' });
    });

    it("keeps an ended live's chat private from deletes too", async () => {
      streams.findLive.mockResolvedValue(null);

      await expect(service().delete(LIVE, 'm1', 'host-1')).resolves.toEqual({
        ok: false,
        error: 'NOT_FOUND',
      });
      expect(prisma.chatMessage.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('pin', () => {
    it('lets the host pin a visible message', async () => {
      prisma.chatMessage.findFirst.mockResolvedValue({ id: 'm1', text: 'hi', user: { displayName: 'Ann' } });

      await expect(service().pin(LIVE, 'm1', 'host-1')).resolves.toEqual({ ok: true });
      expect(prisma.stream.update).toHaveBeenCalledWith({
        where: { id: LIVE },
        data: { pinnedMessageId: 'm1' },
      });
      expect(events.emit).toHaveBeenCalledWith('chat_message.pinned', {
        streamId: LIVE,
        messageId: 'm1',
        actorId: 'host-1',
        text: 'hi',
        senderName: 'Ann',
      });
    });

    it('refuses a plain viewer', async () => {
      await expect(service().pin(LIVE, 'm1', 'viewer-2')).resolves.toEqual({ ok: false, error: 'NOT_ALLOWED' });
      expect(prisma.stream.update).not.toHaveBeenCalled();
    });

    it('404s pinning a message that is not visible in this stream', async () => {
      prisma.chatMessage.findFirst.mockResolvedValue(null);

      await expect(service().pin(LIVE, 'ghost', 'host-1')).resolves.toEqual({ ok: false, error: 'NOT_FOUND' });
    });
  });

  describe('unpin', () => {
    it('lets the host unpin', async () => {
      await expect(service().unpin(LIVE, 'host-1')).resolves.toEqual({ ok: true });
      expect(prisma.stream.update).toHaveBeenCalledWith({ where: { id: LIVE }, data: { pinnedMessageId: null } });
    });

    it('refuses a plain viewer', async () => {
      await expect(service().unpin(LIVE, 'viewer-2')).resolves.toEqual({ ok: false, error: 'NOT_ALLOWED' });
      expect(prisma.stream.update).not.toHaveBeenCalled();
    });
  });
});
