import { Job } from 'bullmq';
import { PrismaService } from '../common/prisma/prisma.service';
import { PushProvider } from '../common/push/push-provider.interface';
import { PushProcessor } from './push.processor';
import { PushJobData } from './push-queue.service';

describe('PushProcessor', () => {
  const prisma = {
    userSession: { findMany: jest.fn(), updateMany: jest.fn() },
    user: { findUnique: jest.fn() },
  };
  const pushProvider = { send: jest.fn() };
  const processor = () =>
    new PushProcessor(prisma as unknown as PrismaService, pushProvider as unknown as PushProvider);
  const job = (data: Partial<PushJobData> = {}) =>
    ({
      data: { recipientId: 'u1', title: 'Live now', body: 'Abebe is live', ...data },
    }) as Job<PushJobData>;

  beforeEach(() => {
    jest.clearAllMocks();
    pushProvider.send.mockResolvedValue({ invalidTokens: [] });
    prisma.user.findUnique.mockResolvedValue({ username: 'kebede' });
  });

  // First call: the recipient's tokens; second: which of them other accounts share.
  const tokens = (own: string[], shared: string[]) =>
    prisma.userSession.findMany
      .mockResolvedValueOnce(own.map((pushToken) => ({ pushToken })))
      .mockResolvedValueOnce(shared.map((pushToken) => ({ pushToken })));

  it('sends nothing to someone with no device', async () => {
    prisma.userSession.findMany.mockResolvedValueOnce([]);

    await processor().process(job());

    expect(pushProvider.send).not.toHaveBeenCalled();
  });

  it('says whose push it is, and keeps collapse keys per account', async () => {
    tokens(['phone'], []);

    await processor().process(job({ data: { type: 'DIRECT_MESSAGE' }, collapseKey: 'dm-s1' }));

    expect(pushProvider.send).toHaveBeenCalledWith(['phone'], {
      title: 'Live now',
      body: 'Abebe is live',
      data: { type: 'DIRECT_MESSAGE', recipientId: 'u1' },
      collapseKey: 'u1:dm-s1',
    });
  });

  it("on a phone with several accounts, the title names the account it's for", async () => {
    tokens(['own-phone', 'shared-phone'], ['shared-phone']);

    await processor().process(job());

    expect(pushProvider.send).toHaveBeenCalledWith(
      ['own-phone'],
      expect.objectContaining({ title: 'Live now' }),
    );
    expect(pushProvider.send).toHaveBeenCalledWith(
      ['shared-phone'],
      expect.objectContaining({ title: '@kebede · Live now' }),
    );
    expect(prisma.userSession.findMany).toHaveBeenLastCalledWith({
      where: { pushToken: { in: ['own-phone', 'shared-phone'] }, userId: { not: 'u1' } },
      select: { pushToken: true },
      distinct: ['pushToken'],
    });
  });

  it('prunes tokens the vendor reports as gone', async () => {
    tokens(['own-phone', 'shared-phone'], ['shared-phone']);
    pushProvider.send
      .mockResolvedValueOnce({ invalidTokens: ['own-phone'] })
      .mockResolvedValueOnce({ invalidTokens: ['shared-phone'] });

    await processor().process(job());

    expect(prisma.userSession.updateMany).toHaveBeenCalledWith({
      where: { pushToken: { in: ['own-phone', 'shared-phone'] } },
      data: { pushToken: null },
    });
  });
});
