import { createHmac, randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ANONYMOUS_VIEWER_PREFIX } from '../common/presence/live-presence.service';

/** A watching session's length; the player asks for a new one after that. */
export const WATCH_TICKET_TTL_SECONDS = 4 * 60 * 60;
const AUDIENCE = 'mela-watch';

export interface WatchTicket {
  viewerId: string;
  streamId: string;
}

/**
 * Watch-only access to one live for the share page's player without an
 * account (docs/features/share.md): an anonymous viewer id, and a signed
 * ticket its socket presents to follow that live's public updates. Signed
 * with a key of its own, derived from the access-token secret, so a ticket
 * never passes as an access token, nor an access token as a ticket.
 */
@Injectable()
export class WatchTicketService {
  private key?: string;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async issue(streamId: string): Promise<WatchTicket & { ticket: string }> {
    const viewerId = `${ANONYMOUS_VIEWER_PREFIX}${randomUUID()}`;
    const ticket = await this.jwt.signAsync(
      { sub: viewerId, streamId },
      { secret: this.secret(), audience: AUDIENCE, expiresIn: WATCH_TICKET_TTL_SECONDS },
    );
    return { viewerId, streamId, ticket };
  }

  /** Throws for anything but a current ticket. */
  async verify(ticket: string): Promise<WatchTicket> {
    const claims = await this.jwt.verifyAsync<{ sub: string; streamId: string }>(ticket, {
      secret: this.secret(),
      audience: AUDIENCE,
    });
    return { viewerId: claims.sub, streamId: claims.streamId };
  }

  private secret(): string {
    this.key ??= createHmac('sha256', this.config.getOrThrow<string>('JWT_ACCESS_SECRET'))
      .update('mela-watch-ticket')
      .digest('base64url');
    return this.key;
  }
}
