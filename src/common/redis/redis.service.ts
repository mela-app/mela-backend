import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

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
}
