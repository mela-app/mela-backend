import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';

export const PUSH_QUEUE = 'push';

export interface PushJobData {
  recipientId: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  /** Pushes sharing it replace each other on the phone (one per conversation). */
  collapseKey?: string;
}

/** Queues a push job; PushProcessor decides (at send time) whether it's still worth sending. */
@Injectable()
export class PushQueueService {
  constructor(@InjectQueue(PUSH_QUEUE) private readonly queue: Queue<PushJobData>) {}

  async enqueue(job: PushJobData): Promise<void> {
    await this.queue.add('send', job, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: 100,
    });
  }
}
