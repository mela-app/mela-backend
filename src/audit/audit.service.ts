import { Injectable, Logger } from '@nestjs/common';
import { AuditActorRole, PlatformRole, Prisma } from '@prisma/client';
import { toPage, pageArgs } from '../common/pagination/page-query.dto';
import { PrismaService } from '../common/prisma/prisma.service';
import { RequestContext, RequestContextStore } from '../common/request-context/request-context';
import {
  AUDIT_ACTIONS,
  AUDIT_CATEGORY_LABELS,
  AuditAction,
  AuditTargetType,
} from './audit-catalog';
import { AuditLogQueryDto } from './audit-log-query.dto';

export interface AuditEntry {
  action: AuditAction;
  actorId?: string | null;
  // Worked out from the actor's account (and hostId) when not given.
  actorRole?: AuditActorRole;
  actorLabel?: string | null;
  // Stream-scoped moderation: the host acts as HOST, anyone else as MODERATOR.
  hostId?: string;
  target?: { type: AuditTargetType; id: string; label?: string | null } | null;
  streamId?: string | null;
  reason?: string | null;
  metadata?: Prisma.InputJsonObject;
  // Captured when the event fired, if the write happens later.
  context?: RequestContextStore;
}

const EXPORT_LIMIT = 10_000;

const ACTOR_ROLE_LABELS: Record<AuditActorRole, string> = {
  SUPER_ADMIN: 'Super admin',
  PLATFORM_MODERATOR: 'Platform moderator',
  HOST: 'Host',
  MODERATOR: 'Moderator',
  USER: 'User',
  SYSTEM: 'System',
};

/**
 * The audit trail (plan §6.8, §11): who did what, to what, from where.
 * Append-only - there is no update or delete. See docs/features/admin.md.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Never throws - a failed audit write is logged, not surfaced to the action it describes. */
  async record(entry: AuditEntry): Promise<void> {
    const context = entry.context ?? RequestContext.current();
    try {
      const actor = entry.actorId
        ? await this.prisma.user.findUnique({
            where: { id: entry.actorId },
            select: { username: true, platformRole: true },
          })
        : null;
      await this.prisma.auditLog.create({
        data: {
          category: AUDIT_ACTIONS[entry.action].category,
          action: entry.action,
          actorId: actor ? entry.actorId : null,
          actorRole: entry.actorRole ?? resolveActorRole(entry, actor, context),
          actorLabel: truncate(entry.actorLabel ?? (actor ? `@${actor.username}` : null), 200),
          targetType: entry.target?.type ?? null,
          targetId: entry.target?.id ?? null,
          targetLabel: truncate(entry.target?.label, 200),
          streamId: entry.streamId ?? null,
          reason: truncate(entry.reason, 500),
          metadata: entry.metadata,
          ip: context?.ip ?? null,
          userAgent: context?.userAgent ?? null,
        },
      });
    } catch (error) {
      this.logger.warn(`Could not record ${entry.action}: ${error}`);
    }
  }

  async list(query: AuditLogQueryDto) {
    const where = this.where(query);
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(query),
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return toPage(rows.map(toView), total, query);
  }

  /** The same filters as `list`, newest first, as CSV - capped at EXPORT_LIMIT rows. */
  async exportCsv(query: AuditLogQueryDto): Promise<string> {
    const rows = await this.prisma.auditLog.findMany({
      where: this.where(query),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: EXPORT_LIMIT,
    });
    const header = [
      'Time (UTC)',
      'Category',
      'Action',
      'Actor role',
      'Actor',
      'Actor ID',
      'Target type',
      'Target',
      'Target ID',
      'Stream ID',
      'Reason',
      'IP',
      'User agent',
      'Details',
    ];
    const lines = rows.map((row) => {
      const view = toView(row);
      return [
        row.createdAt.toISOString(),
        view.categoryLabel,
        view.actionLabel,
        ACTOR_ROLE_LABELS[row.actorRole],
        row.actorLabel,
        row.actorId,
        row.targetType,
        row.targetLabel,
        row.targetId,
        row.streamId,
        row.reason,
        row.ip,
        row.userAgent,
        row.metadata ? JSON.stringify(row.metadata) : '',
      ].map(csvCell);
    });
    return [header.map(csvCell), ...lines].map((cells) => cells.join(',')).join('\r\n');
  }

  catalog() {
    return {
      categories: Object.entries(AUDIT_CATEGORY_LABELS).map(([value, label]) => ({ value, label })),
      actions: Object.entries(AUDIT_ACTIONS).map(([value, definition]) => ({
        value,
        label: definition.label,
        category: definition.category,
      })),
      actorRoles: Object.entries(ACTOR_ROLE_LABELS).map(([value, label]) => ({ value, label })),
    };
  }

  private where(query: AuditLogQueryDto): Prisma.AuditLogWhereInput {
    const and: Prisma.AuditLogWhereInput[] = [];
    if (query.category) and.push({ category: query.category });
    if (query.action) and.push({ action: query.action });
    if (query.actorRole) and.push({ actorRole: query.actorRole });
    if (query.actorId) and.push({ actorId: query.actorId });
    if (query.targetType) and.push({ targetType: query.targetType });
    if (query.targetId) and.push({ targetId: query.targetId });
    if (query.streamId) and.push({ streamId: query.streamId });
    if (query.userId) {
      and.push({ OR: [{ actorId: query.userId }, { targetType: 'USER', targetId: query.userId }] });
    }
    if (query.from || query.to) {
      and.push({
        createdAt: {
          ...(query.from ? { gte: new Date(query.from) } : {}),
          ...(query.to ? { lte: new Date(query.to) } : {}),
        },
      });
    }
    const q = query.q?.trim();
    if (q) {
      const needle = q.toLowerCase();
      const matchingActions = Object.entries(AUDIT_ACTIONS)
        .filter(([, definition]) => definition.label.toLowerCase().includes(needle))
        .map(([action]) => action);
      and.push({
        OR: [
          { actorLabel: { contains: q, mode: 'insensitive' } },
          { targetLabel: { contains: q, mode: 'insensitive' } },
          { reason: { contains: q, mode: 'insensitive' } },
          { action: { contains: q, mode: 'insensitive' } },
          ...(matchingActions.length > 0 ? [{ action: { in: matchingActions } }] : []),
          { ip: { startsWith: q } },
          { actorId: q },
          { targetId: q },
          { streamId: q },
        ],
      });
    }
    return and.length > 0 ? { AND: and } : {};
  }
}

type AuditRow = Prisma.AuditLogGetPayload<object>;

function toView(row: AuditRow) {
  const definition = (
    AUDIT_ACTIONS as Record<string, { category: string; label: string } | undefined>
  )[row.action];
  return {
    ...row,
    actionLabel: definition?.label ?? row.action,
    categoryLabel: AUDIT_CATEGORY_LABELS[row.category],
  };
}

function resolveActorRole(
  entry: AuditEntry,
  actor: { platformRole: PlatformRole } | null,
  context: RequestContextStore | undefined,
): AuditActorRole {
  if (!actor) return AuditActorRole.SYSTEM;
  if (context?.surface === 'admin' && actor.platformRole !== PlatformRole.USER) {
    return actor.platformRole === PlatformRole.SUPER_ADMIN
      ? AuditActorRole.SUPER_ADMIN
      : AuditActorRole.PLATFORM_MODERATOR;
  }
  if (entry.hostId)
    return entry.actorId === entry.hostId ? AuditActorRole.HOST : AuditActorRole.MODERATOR;
  return AuditActorRole.USER;
}

function truncate(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// Quoted, and a leading formula character neutralised (CSV injection).
function csvCell(value: string | null | undefined): string {
  const text = value ?? '';
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}
