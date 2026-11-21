import { Prisma } from '@prisma/client';

/** A value as the audit log keeps it: plain JSON (dates as ISO text). */
export type AuditValue = Prisma.InputJsonValue | null;
export type AuditSnapshot = Record<string, AuditValue>;

/**
 * What an action changed, for the audit log (docs/features/admin.md, "Before
 * and after"): for a change, only the fields that differ, on each side; for
 * something created, `after` alone; for something removed, `before` alone.
 */
export interface AuditChanges {
  before?: AuditSnapshot;
  after?: AuditSnapshot;
}

function toAuditValue(value: unknown): AuditValue {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Prisma.Decimal.isDecimal(value)) return value.toString();
  if (Array.isArray(value)) return value.map(toAuditValue) as Prisma.InputJsonArray;
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
        key,
        toAuditValue(inner),
      ]),
    ) as Prisma.InputJsonObject;
  }
  return value as Prisma.InputJsonValue;
}

/** [record]'s [keys] (all of them when omitted), as the audit log keeps them. */
export function snapshotOf(
  record: object | null | undefined,
  keys?: readonly string[],
): AuditSnapshot {
  if (!record) return {};
  const fields = record as Record<string, unknown>;
  const picked = keys ?? Object.keys(fields);
  return Object.fromEntries(picked.map((key) => [key, toAuditValue(fields[key])]));
}

/**
 * The fields of [keys] (by default every field of either) whose values
 * differ between [before] and [after] - undefined when nothing did.
 */
export function changesBetween(
  before: object | null | undefined,
  after: object | null | undefined,
  keys?: readonly string[],
): AuditChanges | undefined {
  const left = snapshotOf(before, keys ?? Object.keys({ ...before, ...after }));
  const right = snapshotOf(after, keys ?? Object.keys({ ...before, ...after }));
  const changed = Object.keys(left).filter(
    (key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]),
  );
  if (changed.length === 0) return undefined;
  return {
    before: Object.fromEntries(changed.map((key) => [key, left[key]])),
    after: Object.fromEntries(changed.map((key) => [key, right[key]])),
  };
}

/** Something new: what it is. */
export function created(record: object | null | undefined, keys?: readonly string[]): AuditChanges {
  return { after: snapshotOf(record, keys) };
}

/** Something gone: what it was. */
export function removed(record: object | null | undefined, keys?: readonly string[]): AuditChanges {
  return { before: snapshotOf(record, keys) };
}
