import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DomainEvents, HostingReasonSavedPayload } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { StaffActor } from './hosting-restrictions.service';

const REASON_SELECT = {
  id: true,
  title: true,
  message: true,
  archived: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { id: true, username: true, displayName: true } },
  _count: { select: { restrictions: true } },
} as const;

/**
 * The reasons staff wrote for pausing someone's hosting - picked when
 * restricting next time, or a new one written then. Archived ones are no
 * longer offered; restrictions keep their own copy of the words either way.
 */
@Injectable()
export class HostingReasonsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async list(includeArchived: boolean) {
    const rows = await this.prisma.hostingRestrictionReason.findMany({
      where: includeArchived ? {} : { archived: false },
      orderBy: [{ archived: 'asc' }, { createdAt: 'desc' }],
      select: REASON_SELECT,
    });
    return rows.map(({ _count, ...row }) => ({ ...row, used: _count.restrictions }));
  }

  async create(staff: StaffActor, input: { title: string; message: string }) {
    const row = await this.prisma.hostingRestrictionReason.create({
      data: { title: input.title, message: input.message, createdById: staff.id },
      select: { id: true, title: true },
    });
    this.saved(staff, row, 'created');
    return this.one(row.id);
  }

  async update(
    staff: StaffActor,
    id: string,
    input: { title?: string; message?: string; archived?: boolean },
  ) {
    const before = await this.prisma.hostingRestrictionReason.findUnique({
      where: { id },
      select: { archived: true },
    });
    if (!before) throw new NotFoundException('Reason not found');
    const row = await this.prisma.hostingRestrictionReason.update({
      where: { id },
      data: { title: input.title, message: input.message, archived: input.archived },
      select: { id: true, title: true, archived: true },
    });
    let change: HostingReasonSavedPayload['change'] = 'updated';
    if (input.archived !== undefined && input.archived !== before.archived) {
      change = row.archived ? 'archived' : 'restored';
    }
    this.saved(staff, row, change);
    return this.one(id);
  }

  private async one(id: string) {
    const { _count, ...row } = await this.prisma.hostingRestrictionReason.findUniqueOrThrow({
      where: { id },
      select: REASON_SELECT,
    });
    return { ...row, used: _count.restrictions };
  }

  private saved(
    staff: StaffActor,
    row: { id: string; title: string },
    change: HostingReasonSavedPayload['change'],
  ) {
    this.events.emit(DomainEvents.HostingReasonSaved, {
      reasonId: row.id,
      actorId: staff.id,
      title: row.title,
      change,
    } satisfies HostingReasonSavedPayload);
  }
}
