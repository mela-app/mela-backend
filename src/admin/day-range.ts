import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The longest stretch one request looks at. */
export const MAX_RANGE_DAYS = 31;

/**
 * The stretch of time a console page looks at - a day in the admin's own
 * time zone, which the console sends as its first and last instant.
 */
export function rangeOf(query: { from: string; to: string }): { gte: Date; lte: Date } {
  const from = new Date(query.from);
  const to = new Date(query.to);
  if (to < from) throw new BadRequestException('The end of the range is before its start');
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    throw new BadRequestException(`Look at ${MAX_RANGE_DAYS} days at most at a time`);
  }
  return { gte: from, lte: to };
}

/** Someone by username or display name. */
export function nameMatches(q: string): Prisma.UserWhereInput {
  return {
    OR: [
      { username: { contains: q, mode: 'insensitive' } },
      { displayName: { contains: q, mode: 'insensitive' } },
    ],
  };
}
