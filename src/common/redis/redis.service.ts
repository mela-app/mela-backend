import { randomUUID } from 'crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

// Deletes the lock only if it's still ours: one that expired and was taken
// by another instance mustn't be freed by the old holder.
const RELEASE_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client!: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const url = this.config.getOrThrow<string>('REDIS_URL');
    this.client = new Redis(url);
    this.client.on('error', (err) => this.logger.error('Redis connection error', err));
  }

  async onModuleDestroy() {
    await this.client?.quit();
  }

  getClient(): Redis {
    return this.client;
  }

  /**
   * Runs [task] on one API instance at a time: the others skip it while the
   * lock is held, rather than wait. [ttlMs] frees the lock if its holder dies
   * mid-task - keep it longer than the task takes. Answers whether it ran.
   */
  async runExclusive(name: string, ttlMs: number, task: () => Promise<void>): Promise<boolean> {
    const key = `lock:${name}`;
    const token = randomUUID();
    if ((await this.client.set(key, token, 'PX', ttlMs, 'NX')) !== 'OK') return false;
    try {
      await task();
      return true;
    } finally {
      await this.client
        .eval(RELEASE_LOCK, 1, key, token)
        .catch((error) => this.logger.warn(`Could not release lock ${name}: ${error}`));
    }
  }
}
