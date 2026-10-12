import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BannedPhraseSeverity, ModeratorCapability, StreamStatus } from '@prisma/client';
import { BannedPhrasesService } from '../chat/banned-phrases.service';
import { DomainEvents } from '../common/events/domain-events';
import { PermissionsService } from '../common/permissions/permissions.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { ModeratorsService } from '../moderators/moderators.service';
import { cleanBoardText } from './board-text';
import { LiveBoardService } from './live-board.service';

const HOST = 'host-1';
const STREAM = 's1';

describe('board text', () => {
  it('keeps a few tidy lines', () => {
    expect(cleanBoardText('  Bingo   night \n\n\n Round 3  ')).toEqual({
      text: 'Bingo night\nRound 3',
    });
    expect(cleanBoardText('Wooooooooow!!!!!!!!')).toEqual({ text: 'Wooooow!!!!!' });
  });

  it('nothing, too many lines, or too long is refused', () => {
    expect(cleanBoardText('  \n ')).toEqual({ error: 'BOARD_EMPTY' });
    expect(cleanBoardText('a\nb\nc\nd\ne')).toEqual({ error: 'BOARD_TOO_LONG' });
    expect(cleanBoardText('ab'.repeat(61))).toEqual({ error: 'BOARD_TOO_LONG' });
    // Emoji count once each.
    expect(cleanBoardText('😀🎉'.repeat(60))).toEqual({ text: '😀🎉'.repeat(60) });
  });
});

describe('LiveBoardService', () => {
  const prisma = { stream: { findUnique: jest.fn(), update: jest.fn() } };
  const moderators = { findActiveGrant: jest.fn() };
  const bannedPhrases = { match: jest.fn(), mask: jest.fn() };
  const events = { emit: jest.fn() };
  const config = {
    get: (key: string) => (key === 'CHAT_LINK_DOMAINS' ? 'mela.example' : undefined),
  };
  const service = () =>
    new LiveBoardService(
      prisma as unknown as PrismaService,
      new PermissionsService(),
      moderators as unknown as ModeratorsService,
      bannedPhrases as unknown as BannedPhrasesService,
      events as never,
      config as unknown as ConfigService,
    );

  const live = (fields: object = {}) =>
    prisma.stream.findUnique.mockResolvedValue({
      hostId: HOST,
      status: StreamStatus.LIVE,
      boardText: null,
      boardX: 0.5,
      boardY: 0.3,
      ...fields,
    });

  beforeEach(() => {
    jest.clearAllMocks();
    live();
    moderators.findActiveGrant.mockResolvedValue(null);
    bannedPhrases.match.mockResolvedValue([]);
  });

  it('the host writes it, and everyone in the live sees it', async () => {
    await expect(service().set(STREAM, HOST, { text: ' Bingo at 8 ' })).resolves.toEqual({
      text: 'Bingo at 8',
      x: 0.5,
      y: 0.3,
    });

    expect(prisma.stream.update).toHaveBeenCalledWith({
      where: { id: STREAM },
      data: { boardText: 'Bingo at 8', boardX: 0.5, boardY: 0.3 },
    });
    expect(events.emit).toHaveBeenCalledWith(DomainEvents.LiveBoardChanged, {
      streamId: STREAM,
      actorId: HOST,
      board: { text: 'Bingo at 8', x: 0.5, y: 0.3 },
    });
  });

  it('moving keeps the text; moving nothing is refused', async () => {
    live({ boardText: 'Round 2' });
    await expect(service().set(STREAM, HOST, { x: 0.1, y: 0.9 })).resolves.toEqual({
      text: 'Round 2',
      x: 0.1,
      y: 0.9,
    });

    live();
    await expect(service().set(STREAM, HOST, { x: 0.1 })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'BOARD_EMPTY' }),
    });
  });

  it('a moderator only with EDIT_BOARD; anyone else is refused', async () => {
    await expect(service().set(STREAM, 'viewer', { text: 'hi' })).rejects.toThrow(
      ForbiddenException,
    );

    moderators.findActiveGrant.mockResolvedValue({
      capabilities: [ModeratorCapability.PIN_MESSAGES],
    });
    await expect(service().set(STREAM, 'mod-1', { text: 'hi' })).rejects.toThrow(
      ForbiddenException,
    );

    moderators.findActiveGrant.mockResolvedValue({
      capabilities: [ModeratorCapability.EDIT_BOARD],
    });
    await expect(service().set(STREAM, 'mod-1', { text: 'hi' })).resolves.toMatchObject({
      text: 'hi',
    });
    expect(moderators.findActiveGrant).toHaveBeenCalledWith(STREAM, 'mod-1');
  });

  it("goes through live chat's phrase filter and link policy", async () => {
    bannedPhrases.match.mockResolvedValue([{ phrase: 'x', severity: BannedPhraseSeverity.REJECT }]);
    await expect(service().set(STREAM, HOST, { text: 'bad' })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'BOARD_BLOCKED' }),
    });

    bannedPhrases.match.mockResolvedValue([
      { phrase: 'darn', severity: BannedPhraseSeverity.MASK },
    ]);
    bannedPhrases.mask.mockResolvedValue('oh ****');
    await expect(service().set(STREAM, HOST, { text: 'oh darn' })).resolves.toMatchObject({
      text: 'oh ****',
    });

    bannedPhrases.match.mockResolvedValue([]);
    await expect(
      service().set(STREAM, HOST, { text: 'pay at evil.example' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'LINK_NOT_ALLOWED' }),
    });
    await expect(service().set(STREAM, HOST, { text: 'mela.example/live' })).resolves.toBeDefined();
  });

  it('too long is refused', async () => {
    await expect(service().set(STREAM, HOST, { text: 'ab'.repeat(100) })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('taken down: everyone sees it go - nothing to do when there is none', async () => {
    live({ boardText: 'Round 2' });
    await service().clear(STREAM, HOST);
    expect(prisma.stream.update).toHaveBeenCalledWith({
      where: { id: STREAM },
      data: { boardText: null },
    });
    expect(events.emit).toHaveBeenCalledWith(
      DomainEvents.LiveBoardChanged,
      expect.objectContaining({ board: null }),
    );

    jest.clearAllMocks();
    live();
    await service().clear(STREAM, HOST);
    expect(prisma.stream.update).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('only on a live that is on', async () => {
    live({ status: StreamStatus.ENDED });
    await expect(service().set(STREAM, HOST, { text: 'hi' })).rejects.toThrow(NotFoundException);
  });
});
