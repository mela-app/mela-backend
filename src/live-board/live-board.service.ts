import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BannedPhraseSeverity, ModeratorCapability, StreamStatus } from '@prisma/client';
import { BannedPhrasesService } from '../chat/banned-phrases.service';
import { hasDisallowedLink, parseLinkDomains } from '../chat/link-policy';
import { DomainEvents, LiveBoardChangedPayload } from '../common/events/domain-events';
import { PermissionsService } from '../common/permissions/permissions.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { ModeratorsService } from '../moderators/moderators.service';
import { BOARD_MAX_LENGTH, BOARD_MAX_LINES, clampUnit, cleanBoardText } from './board-text';

/** The text on a live's board, and where it sits (0 to 1 across and down the stage). */
export interface LiveBoard {
  text: string;
  x: number;
  y: number;
}

const BOARD_SELECT = {
  hostId: true,
  status: true,
  boardText: true,
  boardX: true,
  boardY: true,
} as const;

/** A board as phones get it - null when there's none. */
export function boardOf(stream: {
  boardText: string | null;
  boardX: number;
  boardY: number;
}): LiveBoard | null {
  return stream.boardText ? { text: stream.boardText, x: stream.boardX, y: stream.boardY } : null;
}

/**
 * The live's board (client request, 2026-10): a short see-through text the
 * host - or a moderator holding `EDIT_BOARD` - puts on the stage, edits, and
 * drags anywhere, at any time. Everyone in the live sees it move and change
 * at once (`stream:board`). Its text goes through live chat's phrase filter
 * and link policy. See docs/features/streams.md.
 */
@Injectable()
export class LiveBoardService {
  private readonly linkDomains: string[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly moderators: ModeratorsService,
    private readonly bannedPhrases: BannedPhrasesService,
    private readonly events: EventEmitter2,
    config: ConfigService,
  ) {
    this.linkDomains = parseLinkDomains(config.get<string>('CHAT_LINK_DOMAINS'));
  }

  /** Writes, edits or moves the board - [input.text] left out moves the one there. */
  async set(
    streamId: string,
    requesterId: string,
    input: { text?: string; x?: number; y?: number },
  ): Promise<LiveBoard> {
    const stream = await this.liveFor(streamId, requesterId);
    let text = stream.boardText;
    if (input.text !== undefined) {
      text = await this.checkedText(input.text);
    }
    if (!text) {
      throw new BadRequestException({
        message: 'Write something for the board first',
        code: 'BOARD_EMPTY',
      });
    }
    const board: LiveBoard = {
      text,
      x: input.x === undefined ? stream.boardX : clampUnit(input.x),
      y: input.y === undefined ? stream.boardY : clampUnit(input.y),
    };
    await this.prisma.stream.update({
      where: { id: streamId },
      data: { boardText: board.text, boardX: board.x, boardY: board.y },
    });
    this.announce(streamId, requesterId, board);
    return board;
  }

  /** Takes the board down - a no-op success when there's none. */
  async clear(streamId: string, requesterId: string): Promise<{ ok: true }> {
    const stream = await this.liveFor(streamId, requesterId);
    if (stream.boardText) {
      await this.prisma.stream.update({ where: { id: streamId }, data: { boardText: null } });
      this.announce(streamId, requesterId, null);
    }
    return { ok: true };
  }

  private async liveFor(streamId: string, requesterId: string) {
    const stream = await this.prisma.stream.findUnique({
      where: { id: streamId },
      select: BOARD_SELECT,
    });
    if (!stream || stream.status !== StreamStatus.LIVE)
      throw new NotFoundException('This live has ended');
    if (!this.permissions.isHost(requesterId, stream.hostId)) {
      const grant = await this.moderators.findActiveGrant(streamId, requesterId);
      if (
        !this.permissions.hasChannelCapability(
          requesterId,
          stream.hostId,
          grant,
          ModeratorCapability.EDIT_BOARD,
        )
      ) {
        throw new ForbiddenException('Only the host or a moderator can change the board');
      }
    }
    return stream;
  }

  private async checkedText(raw: string): Promise<string> {
    const cleaned = cleanBoardText(raw);
    if ('error' in cleaned) {
      throw new BadRequestException({
        message:
          cleaned.error === 'BOARD_EMPTY'
            ? 'Write something for the board'
            : `Keep it to ${BOARD_MAX_LINES} lines and ${BOARD_MAX_LENGTH} characters`,
        code: cleaned.error,
      });
    }
    const matches = await this.bannedPhrases.match(cleaned.text);
    if (matches.some((match) => match.severity === BannedPhraseSeverity.REJECT)) {
      throw new BadRequestException({
        message: "That can't go on the board",
        code: 'BOARD_BLOCKED',
      });
    }
    if (hasDisallowedLink(cleaned.text, this.linkDomains)) {
      throw new BadRequestException({
        message: "Links to other sites can't go on the board",
        code: 'LINK_NOT_ALLOWED',
      });
    }
    return matches.length > 0 ? this.bannedPhrases.mask(cleaned.text) : cleaned.text;
  }

  private announce(streamId: string, actorId: string, board: LiveBoard | null) {
    this.events.emit(DomainEvents.LiveBoardChanged, {
      streamId,
      actorId,
      board,
    } satisfies LiveBoardChangedPayload);
  }
}
