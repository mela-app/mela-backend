import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ReportCaseStatus, ReportReason, ReportTargetType } from '@prisma/client';
import { DomainEvents } from '../../common/events/domain-events';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DirectMessagesService } from '../../direct-messages/direct-messages.service';
import { AdminPrincipal } from '../admin.guard';
import { AdminReportsService, caseLabel } from './admin-reports.service';

const admin = { id: 'admin-1' } as AdminPrincipal;
const ana = { id: 'ana-1', username: 'ana', displayName: 'Ana', avatarUrl: null, status: 'ACTIVE' };
const caseRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'case-1',
  targetType: ReportTargetType.CHAT_MESSAGE,
  targetId: 'm1',
  streamId: 's1',
  snapshot: { text: 'rude', person: { username: 'ana' } },
  status: ReportCaseStatus.OPEN,
  urgent: false,
  reportCount: 3,
  lastReportedAt: new Date('2026-10-07T10:00:00.000Z'),
  createdAt: new Date('2026-10-07T09:00:00.000Z'),
  resolvedAt: null,
  resolutionNote: null,
  reportedUser: ana,
  resolvedBy: null,
  ...overrides,
});

describe('AdminReportsService', () => {
  const prisma = {
    reportCase: {
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    report: { groupBy: jest.fn() },
    stream: { findUnique: jest.fn() },
    chatMessage: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    directMessage: { findUnique: jest.fn() },
  };
  const directMessages = { erase: jest.fn() };
  const events = { emit: jest.fn() };
  const service = () =>
    new AdminReportsService(
      prisma as unknown as PrismaService,
      directMessages as unknown as DirectMessagesService,
      events as unknown as EventEmitter2,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.report.groupBy.mockResolvedValue([
      { caseId: 'case-1', reason: ReportReason.SPAM, _count: { _all: 1 } },
      { caseId: 'case-1', reason: ReportReason.HARASSMENT, _count: { _all: 2 } },
    ]);
  });

  it('names what was reported', () => {
    expect(
      caseLabel(ReportTargetType.LIVE, { title: 'Poker night', person: { username: 'host' } }),
    ).toBe('Live "Poker night" by @host');
    expect(caseLabel(ReportTargetType.USER, { person: { username: 'ana' } })).toBe(
      'Profile of @ana',
    );
    expect(caseLabel(ReportTargetType.DIRECT_MESSAGE, {})).toBe(
      'Private message from a deleted account',
    );
  });

  it('lists open cases urgent first, then the latest, with why they were reported', async () => {
    prisma.reportCase.findMany.mockResolvedValue([caseRow()]);
    prisma.reportCase.count.mockResolvedValue(1);

    const page = await service().list({ status: ReportCaseStatus.OPEN, page: 1, pageSize: 25 });

    expect(prisma.reportCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: ReportCaseStatus.OPEN },
        orderBy: [{ urgent: 'desc' }, { lastReportedAt: 'desc' }],
        skip: 0,
        take: 25,
      }),
    );
    expect(page.items[0]).toMatchObject({
      label: 'Chat message from @ana',
      reasons: [
        { reason: ReportReason.HARASSMENT, count: 2 },
        { reason: ReportReason.SPAM, count: 1 },
      ],
    });
    expect(page.total).toBe(1);
  });

  it('shows a case with every report, whether the message still exists, and the live', async () => {
    prisma.reportCase.findUnique.mockResolvedValue({
      ...caseRow(),
      reports: [
        {
          id: 'r1',
          reason: ReportReason.SPAM,
          details: null,
          createdAt: new Date(),
          reporter: null,
        },
      ],
    });
    prisma.chatMessage.findUnique.mockResolvedValue(null);
    prisma.stream.findUnique.mockResolvedValue({ id: 's1', title: 'Poker night', status: 'LIVE' });
    prisma.reportCase.count.mockResolvedValue(2);

    const detail = await service().detail('case-1');

    expect(detail).toMatchObject({
      targetExists: false,
      live: { id: 's1', status: 'LIVE' },
      otherCases: 2,
      reports: [{ id: 'r1', reporter: null }],
    });
  });

  it('decides a case once, telling everyone who reported it', async () => {
    prisma.reportCase.findUnique
      .mockResolvedValueOnce({
        status: ReportCaseStatus.OPEN,
        targetType: ReportTargetType.CHAT_MESSAGE,
        snapshot: { person: { username: 'ana' } },
        reports: [{ reporterId: 'ben-1' }, { reporterId: null }, { reporterId: 'cal-1' }],
      })
      .mockResolvedValueOnce({ ...caseRow(), reports: [] });
    prisma.reportCase.updateMany.mockResolvedValue({ count: 1 });
    prisma.chatMessage.findUnique.mockResolvedValue(null);
    prisma.stream.findUnique.mockResolvedValue(null);
    prisma.reportCase.count.mockResolvedValue(0);

    await service().resolve(admin, 'case-1', 'ACTIONED', '  Deleted it  ');

    expect(prisma.reportCase.updateMany).toHaveBeenCalledWith({
      where: { id: 'case-1', status: ReportCaseStatus.OPEN },
      data: {
        status: 'ACTIONED',
        resolvedById: 'admin-1',
        resolvedAt: expect.any(Date),
        resolutionNote: 'Deleted it',
      },
    });
    expect(events.emit).toHaveBeenCalledWith(DomainEvents.ReportCaseResolved, {
      caseId: 'case-1',
      outcome: 'ACTIONED',
      actorId: 'admin-1',
      targetType: ReportTargetType.CHAT_MESSAGE,
      label: 'Chat message from @ana',
      reporterIds: ['ben-1', 'cal-1'],
      note: 'Deleted it',
    });
  });

  it('refuses deciding a case twice', async () => {
    prisma.reportCase.findUnique.mockResolvedValue({
      status: ReportCaseStatus.DISMISSED,
      targetType: ReportTargetType.USER,
      snapshot: {},
      reports: [],
    });
    prisma.reportCase.updateMany.mockResolvedValue({ count: 0 });

    await expect(service().resolve(admin, 'case-1', 'DISMISSED', undefined)).rejects.toThrow(
      ConflictException,
    );
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('erases only a reported private message', async () => {
    prisma.reportCase.findUnique.mockResolvedValueOnce({
      targetType: ReportTargetType.DIRECT_MESSAGE,
      targetId: 'dm-1',
    });
    directMessages.erase.mockResolvedValue(true);

    await expect(service().removeMessage(admin, 'case-1')).resolves.toEqual({ removed: true });
    expect(directMessages.erase).toHaveBeenCalledWith('dm-1', 'admin-1');

    prisma.reportCase.findUnique.mockResolvedValueOnce({
      targetType: ReportTargetType.CHAT_MESSAGE,
      targetId: 'm1',
    });
    await expect(service().removeMessage(admin, 'case-1')).rejects.toThrow(BadRequestException);

    prisma.reportCase.findUnique.mockResolvedValueOnce(null);
    await expect(service().removeMessage(admin, 'gone')).rejects.toThrow(NotFoundException);
  });
});
