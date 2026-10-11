import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../common/prisma/prisma.service';
import { PUSH_PROVIDER, PushProvider } from '../common/push/push-provider.interface';
import { PUSH_QUEUE, PushJobData } from './push-queue.service';

/**
 * Runs each queued push job: sends to every device of the recipient that
 * has a token and prunes tokens the vendor reports as invalid. A phone
 * signed in to several accounts gets each one's pushes (docs/features/auth.md):
 * every push says whose it is (`data.recipientId`, so a tap switches to that
 * account), and on such a phone its title starts with the account's @username.
 * Collapse keys are per account, so two accounts' conversations never replace
 * each other. Sent even
 * when the recipient has a live socket - that socket survives a while with
 * the app in the background, where only the push is seen; in the
 * foreground the app shows the realtime banner and FCM displays nothing.
 * See docs/features/notifications.md.
 */
@Processor(PUSH_QUEUE)
export class PushProcessor extends WorkerHost {
  private readonly logger = new Logger(PushProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PUSH_PROVIDER) private readonly pushProvider: PushProvider,
  ) {
    super();
  }

  async process(job: Job<PushJobData>): Promise<void> {
    const { recipientId, title, body, data, collapseKey } = job.data;
    const sessions = await this.prisma.userSession.findMany({
      where: { userId: recipientId, pushToken: { not: null } },
      select: { pushToken: true },
    });
    const tokens = [
      ...new Set(
        sessions
          .map((session) => session.pushToken)
          .filter((token): token is string => Boolean(token)),
      ),
    ];
    if (tokens.length === 0) return;

    // Phones where someone else is signed in too.
    const sharedRows = await this.prisma.userSession.findMany({
      where: { pushToken: { in: tokens }, userId: { not: recipientId } },
      select: { pushToken: true },
      distinct: ['pushToken'],
    });
    const shared = new Set(sharedRows.map((row) => row.pushToken));
    const own = tokens.filter((token) => !shared.has(token));
    const message = {
      title,
      body,
      data: { ...data, recipientId },
      collapseKey: collapseKey ? `${recipientId}:${collapseKey}` : undefined,
    };

    const invalidTokens: string[] = [];
    if (own.length > 0) {
      invalidTokens.push(...(await this.pushProvider.send(own, message)).invalidTokens);
    }
    if (shared.size > 0) {
      const recipient = await this.prisma.user.findUnique({
        where: { id: recipientId },
        select: { username: true },
      });
      const labelled = recipient
        ? { ...message, title: `@${recipient.username} · ${title}` }
        : message;
      invalidTokens.push(
        ...(await this.pushProvider.send([...shared] as string[], labelled)).invalidTokens,
      );
    }
    if (invalidTokens.length > 0) {
      await this.prisma.userSession.updateMany({
        where: { pushToken: { in: invalidTokens } },
        data: { pushToken: null },
      });
      this.logger.debug(`Pruned ${invalidTokens.length} invalid push token(s)`);
    }
  }
}
