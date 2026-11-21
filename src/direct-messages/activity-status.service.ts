import { Injectable } from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { SocialService } from '../social/social.service';

/**
 * Online, last seen and typing in private messages (docs/features/messages.md).
 * Whether someone is online is the realtime gateway's to know (their open,
 * foreground app); this decides who may know it, and keeps when they were
 * last seen.
 */
@Injectable()
export class ActivityStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly social: SocialService,
  ) {}

  /**
   * What [viewerId] may know of [userId]'s activity, or null when it's hidden:
   * either of them turned activity status off (as on WhatsApp, someone who
   * hides theirs sees nobody's), a block either way, or an account that isn't active.
   */
  async visibleTo(viewerId: string, userId: string): Promise<{ lastSeenAt: Date | null } | null> {
    if (viewerId === userId) return null;
    const [people, blocked] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: [viewerId, userId] } },
        select: { id: true, status: true, showActivityStatus: true, lastSeenAt: true },
      }),
      this.social.isBlockedEitherWay(viewerId, userId),
    ]);
    const viewer = people.find((person) => person.id === viewerId);
    const user = people.find((person) => person.id === userId);
    if (blocked || !viewer?.showActivityStatus || !user?.showActivityStatus) return null;
    if (user.status !== UserStatus.ACTIVE) return null;
    return { lastSeenAt: user.lastSeenAt };
  }

  /** Whether [senderId]'s typing may reach [recipientId] - a block either way keeps it quiet. */
  async canSignalTyping(senderId: string, recipientId: string): Promise<boolean> {
    if (senderId === recipientId) return false;
    return !(await this.social.isBlockedEitherWay(senderId, recipientId));
  }

  /** The app was open just now: kept as when they were last seen. */
  async markSeen(userId: string, at = new Date()): Promise<Date> {
    await this.prisma.user.updateMany({ where: { id: userId }, data: { lastSeenAt: at } });
    return at;
  }
}
