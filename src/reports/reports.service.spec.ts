import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { ReportCaseStatus, ReportReason, ReportTargetType } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { SocialService } from '../social/social.service';
import { REPORT_RATE_LIMIT, ReportsService } from './reports.service';

const LIVE = '0190f0a1-0000-7000-8000-000000000001';
const MESSAGE = '0190f0a1-0000-7000-8000-000000000002';
const host = { id: 'host-1', username: 'host', displayName: 'Host', avatarUrl: null };
const ana = { id: 'ana-1', username: 'ana', displayName: 'Ana', avatarUrl: null };

describe('ReportsService', () => {
  const tx = {
    $executeRaw: jest.fn(),
    reportCase: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    report: { findUnique: jest.fn(), create: jest.fn() },
  };
  const prisma = {
    stream: { findUnique: jest.fn() },
    chatMessage: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    directMessage: { findUnique: jest.fn() },
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
  };
  const rateLimit = { take: jest.fn() };
  const social = { block: jest.fn() };
  const service = () =>
    new ReportsService(
      prisma as unknown as PrismaService,
      rateLimit as unknown as RateLimitService,
      social as unknown as SocialService,
    );
  const report = (overrides: Record<string, unknown> = {}) => ({
    targetType: ReportTargetType.CHAT_MESSAGE,
    targetId: MESSAGE,
    reason: ReportReason.HARASSMENT,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    rateLimit.take.mockResolvedValue(0);
    tx.reportCase.findFirst.mockResolvedValue(null);
    tx.report.findUnique.mockResolvedValue(null);
    prisma.chatMessage.findUnique.mockResolvedValue({
      text: 'you are nothing',
      imageUrl: null,
      createdAt: new Date('2026-10-07T10:00:00.000Z'),
      streamId: LIVE,
      user: ana,
      stream: { title: 'Poker night' },
    });
  });

  it('opens a case about a chat message, keeping what it said', async () => {
    await expect(service().submit('ben-1', report({ details: '  rude  ' }))).resolves.toEqual({
      ok: true,
    });

    expect(rateLimit.take).toHaveBeenCalledWith('report:ben-1', REPORT_RATE_LIMIT);
    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(tx.reportCase.create).toHaveBeenCalledWith({
      data: {
        targetType: ReportTargetType.CHAT_MESSAGE,
        targetId: MESSAGE,
        reportedUserId: 'ana-1',
        streamId: LIVE,
        snapshot: {
          text: 'you are nothing',
          imageUrl: null,
          sentAt: '2026-10-07T10:00:00.000Z',
          liveTitle: 'Poker night',
          person: ana,
        },
        urgent: false,
        reports: {
          create: { reporterId: 'ben-1', reason: ReportReason.HARASSMENT, details: 'rude' },
        },
      },
    });
  });

  it('adds a second person to the open case, marking it urgent for a child', async () => {
    tx.reportCase.findFirst.mockResolvedValue({ id: 'case-1' });

    await service().submit('cal-1', report({ reason: ReportReason.CHILD_SAFETY }));

    expect(tx.reportCase.findFirst).toHaveBeenCalledWith({
      where: {
        targetType: ReportTargetType.CHAT_MESSAGE,
        targetId: MESSAGE,
        status: ReportCaseStatus.OPEN,
      },
      select: { id: true },
    });
    expect(tx.report.create).toHaveBeenCalledWith({
      data: {
        caseId: 'case-1',
        reporterId: 'cal-1',
        reason: ReportReason.CHILD_SAFETY,
        details: null,
      },
    });
    expect(tx.reportCase.update).toHaveBeenCalledWith({
      where: { id: 'case-1' },
      data: { reportCount: { increment: 1 }, lastReportedAt: expect.any(Date), urgent: true },
    });
    expect(tx.reportCase.create).not.toHaveBeenCalled();
  });

  it('counts someone reporting the same thing again only once', async () => {
    tx.reportCase.findFirst.mockResolvedValue({ id: 'case-1' });
    tx.report.findUnique.mockResolvedValue({ id: 'report-1' });

    await service().submit('ben-1', report());

    expect(tx.report.create).not.toHaveBeenCalled();
    expect(tx.reportCase.update).not.toHaveBeenCalled();
  });

  it('needs a few words for "something else"', async () => {
    await expect(service().submit('ben-1', report({ reason: ReportReason.OTHER }))).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses reporting one's own message", async () => {
    await expect(service().submit('ana-1', report())).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('slows down someone sending many reports', async () => {
    rateLimit.take.mockResolvedValue(30_000);

    const attempt = service().submit('ben-1', report());

    await expect(attempt).rejects.toThrow(HttpException);
    await expect(service().submit('ben-1', report())).rejects.toMatchObject({ status: 429 });
  });

  it("reports a live as its host's, and blocks them when asked", async () => {
    prisma.stream.findUnique.mockResolvedValue({
      title: 'Poker night',
      category: 'Games',
      startedAt: new Date('2026-10-07T09:00:00.000Z'),
      host,
    });

    await service().submit('ben-1', {
      targetType: ReportTargetType.LIVE,
      targetId: LIVE,
      reason: ReportReason.SEXUAL_CONTENT,
      block: true,
    });

    expect(tx.reportCase.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reportedUserId: 'host-1',
        streamId: LIVE,
        snapshot: {
          title: 'Poker night',
          category: 'Games',
          startedAt: '2026-10-07T09:00:00.000Z',
          person: host,
        },
      }),
    });
    expect(social.block).toHaveBeenCalledWith('ben-1', 'host-1');
  });

  it('lets only its recipient report a private message', async () => {
    prisma.directMessage.findUnique.mockResolvedValue({
      text: 'send me money',
      createdAt: new Date('2026-10-07T08:00:00.000Z'),
      recipientId: 'ben-1',
      sender: ana,
    });
    const privateMessage = {
      targetType: ReportTargetType.DIRECT_MESSAGE,
      targetId: MESSAGE,
      reason: ReportReason.SCAM,
    };

    await expect(service().submit('cal-1', privateMessage)).rejects.toThrow(NotFoundException);
    await service().submit('ben-1', privateMessage);

    expect(tx.reportCase.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reportedUserId: 'ana-1',
        streamId: null,
        snapshot: { text: 'send me money', sentAt: '2026-10-07T08:00:00.000Z', person: ana },
      }),
    });
  });

  it('says when what was reported is gone', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service().submit('ben-1', {
        targetType: ReportTargetType.USER,
        targetId: 'ana-1',
        reason: ReportReason.IMPERSONATION,
      }),
    ).rejects.toThrow(NotFoundException);
  });
});
