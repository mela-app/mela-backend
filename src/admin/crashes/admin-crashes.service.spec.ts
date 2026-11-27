import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AppCrashKind } from '@prisma/client';
import { DomainEvents } from '../../common/events/domain-events';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AdminPrincipal } from '../admin.guard';
import { AdminCrashesService } from './admin-crashes.service';

const admin = { id: 'admin-1' } as AdminPrincipal;

function setup() {
  const appCrash = {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    deleteMany: jest.fn(),
  };
  const events = { emit: jest.fn() };
  const service = new AdminCrashesService(
    { appCrash, $queryRaw: jest.fn() } as unknown as PrismaService,
    events as unknown as EventEmitter2,
  );
  return { service, appCrash, events };
}

describe('AdminCrashesService removing crashes', () => {
  it('removes every report of a crash and records it', async () => {
    const { service, appCrash, events } = setup();
    appCrash.findFirst.mockResolvedValue({ kind: AppCrashKind.JAVA_CRASH, message: 'boom' });
    appCrash.deleteMany.mockResolvedValue({ count: 21 });

    await expect(service.removeCrash(admin, 'abcdef0123456789')).resolves.toEqual({ removed: 21 });

    expect(appCrash.deleteMany).toHaveBeenCalledWith({ where: { signature: 'abcdef0123456789' } });
    expect(events.emit).toHaveBeenCalledWith(
      DomainEvents.ActivityRecorded,
      expect.objectContaining({
        action: 'crash.deleted',
        actorId: 'admin-1',
        metadata: expect.objectContaining({ signature: 'abcdef0123456789', removed: 21 }),
      }),
    );
  });

  it('says so when the crash has no reports', async () => {
    const { service, appCrash, events } = setup();
    appCrash.findFirst.mockResolvedValue(null);

    await expect(service.removeCrash(admin, 'abcdef0123456789')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(appCrash.deleteMany).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('removes one report and records it', async () => {
    const { service, appCrash, events } = setup();
    appCrash.findUnique.mockResolvedValue({
      signature: 'abcdef0123456789',
      kind: AppCrashKind.DART_ERROR,
    });
    appCrash.deleteMany.mockResolvedValue({ count: 1 });

    await expect(service.removeReport(admin, 'report-1')).resolves.toEqual({ removed: 1 });

    expect(appCrash.deleteMany).toHaveBeenCalledWith({ where: { id: 'report-1' } });
    expect(events.emit).toHaveBeenCalledWith(
      DomainEvents.ActivityRecorded,
      expect.objectContaining({ action: 'crash.report_deleted' }),
    );
  });

  it("says so when the report isn't there", async () => {
    const { service, appCrash } = setup();
    appCrash.findUnique.mockResolvedValue(null);

    await expect(service.removeReport(admin, 'report-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(appCrash.deleteMany).not.toHaveBeenCalled();
  });
});

describe('AdminCrashesService exporting', () => {
  const group = {
    signature: 'abcdef0123456789',
    kind: AppCrashKind.NATIVE_CRASH,
    fatal: true,
    message: 'Native crash: SIGSEGV',
    count: 5,
    users: 3,
    firstSeen: new Date('2026-11-24T19:37:59Z'),
    lastSeen: new Date('2026-11-25T06:46:54Z'),
    versions: ['1.0.18'],
    devices: ['TECNO TECNO CL6'],
  };

  function exporting() {
    const setup_ = setup();
    jest.spyOn(setup_.service, 'groups').mockResolvedValue({
      items: [group, { ...group, signature: '0123456789abcdef' }],
      total: 2,
      page: 1,
      pageSize: 100,
      totals: { reports: 6, fatal: 6, users: 3 },
      days: [],
      versions: ['1.0.18'],
    });
    setup_.appCrash.findMany.mockResolvedValue([
      {
        id: 'r1',
        kind: AppCrashKind.NATIVE_CRASH,
        fatal: true,
        message: 'Native crash: SIGSEGV',
        stack: '#00 pc 0000000000012345  libjingle_peerconnection_so.so',
        breadcrumbs: ['app start'],
        platform: 'ANDROID',
        appVersion: '1.0.18',
        appBuild: 28,
        deviceModel: 'TECNO TECNO CL6',
        osVersion: 'Android 16 (API 36)',
        occurredAt: new Date('2026-11-25T06:46:54Z'),
        userId: 'user-1',
      },
    ]);
    return setup_;
  }

  it("hands on each crash with its newest reports, without anyone's account, and records it", async () => {
    const { service, appCrash, events } = exporting();

    const result = await service.export(admin, { days: 7 }, new Date('2026-11-27T00:00:00Z'));

    expect(result.groups).toHaveLength(2);
    expect(appCrash.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { occurredAt: 'desc' }, take: 5 }),
    );
    const report = result.groups[0].reports[0];
    expect(report).toMatchObject({
      id: 'r1',
      stack: expect.stringContaining('libjingle'),
      signedIn: true,
    });
    expect(report).not.toHaveProperty('userId');
    expect(events.emit).toHaveBeenCalledWith(
      DomainEvents.ActivityRecorded,
      expect.objectContaining({ action: 'crash.exported', actorId: 'admin-1' }),
    );
  });

  it('exports one crash by its signature', async () => {
    const { service } = exporting();

    const result = await service.export(admin, { days: 7, signature: '0123456789abcdef' });

    expect(result.groups.map((each) => each.signature)).toEqual(['0123456789abcdef']);
  });
});
