import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { WatchTicketService } from './watch-ticket.service';

const LIVE = '3f1c9a52-7c2e-4a8b-9d7e-2b6f0c1d4e5a';

describe('WatchTicketService', () => {
  const jwt = new JwtService({});
  const config = { getOrThrow: jest.fn(() => 'access-secret') };
  const tickets = new WatchTicketService(jwt, config as unknown as ConfigService);

  it('issues an anonymous viewer a ticket for one live, and reads it back', async () => {
    const { viewerId, streamId, ticket } = await tickets.issue(LIVE);

    expect(viewerId).toMatch(/^web-[0-9a-f-]{36}$/);
    expect(streamId).toBe(LIVE);
    await expect(tickets.verify(ticket)).resolves.toEqual({ viewerId, streamId: LIVE });
  });

  it('gives each watcher an identity of their own', async () => {
    const first = await tickets.issue(LIVE);
    const second = await tickets.issue(LIVE);

    expect(first.viewerId).not.toBe(second.viewerId);
  });

  it('never passes as an access token, nor an access token as a ticket', async () => {
    const { ticket } = await tickets.issue(LIVE);
    const accessToken = await jwt.signAsync(
      { sub: 'user-1', streamId: LIVE },
      { secret: 'access-secret' },
    );

    await expect(jwt.verifyAsync(ticket, { secret: 'access-secret' })).rejects.toThrow();
    await expect(tickets.verify(accessToken)).rejects.toThrow();
  });

  it('refuses a ticket that has run out', async () => {
    const expired = await jwt.signAsync(
      { sub: 'web-1', streamId: LIVE, exp: Math.floor(Date.now() / 1000) - 60 },
      { secret: (tickets as unknown as { secret(): string }).secret(), audience: 'mela-watch' },
    );

    await expect(tickets.verify(expired)).rejects.toThrow();
  });
});
