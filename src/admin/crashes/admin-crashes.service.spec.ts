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
    deleteMany: jest.fn(),
  };
  const events = { emit: jest.fn() };
  const service = new AdminCrashesService(
    { appCrash } as unknown as PrismaService,
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
