import { Prisma } from '@prisma/client';

/**
 * A user who neither blocked [userId] nor was blocked by them (plan §6.4) -
 * as a relation filter, so whatever the query lists (a message's author, a
 * notification's actor, a conversation's other side) drops blocked people
 * in the same query.
 */
export function notBlockedEitherWayWith(userId: string): Prisma.UserWhereInput {
  return {
    blockedBy: { none: { blockerId: userId } },
    blocksMade: { none: { blockedId: userId } },
  };
}
