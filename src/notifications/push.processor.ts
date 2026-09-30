import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../common/prisma/prisma.service';
import { PUSH_PROVIDER, PushProvider } from '../common/push/push-provider.interface';
import { PUSH_QUEUE, PushJobData } from './push-queue.service';

/**
 * Runs each queued push job: sends to every device of the recipient that
 * has a token and prunes tokens the vendor reports as invalid. Sent even
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
    const { recipientId, title, body, data } = job.data;
    const sessions = await this.prisma.userSession.findMany({
      where: { userId: recipientId, pushToken: { not: null } },
      select: { pushToken: true },
    });
    const tokens = sessions.map((session) => session.pushToken).filter((token): token is string => Boolean(token));
    if (tokens.length === 0) return;

    const { invalidTokens } = await this.pushProvider.send(tokens, { title, body, data });
    if (invalidTokens.length > 0) {
      await this.prisma.userSession.updateMany({
        where: { pushToken: { in: invalidTokens } },
        data: { pushToken: null },
      });
      this.logger.debug(`Pruned ${invalidTokens.length} invalid push token(s)`);
    }
  }
}
