import { Controller, Get, ServiceUnavailableException, VERSION_NEUTRAL } from '@nestjs/common';
import { PrismaService } from './common/prisma/prisma.service';
import { RedisService } from './common/redis/redis.service';

// ioredis queues commands while reconnecting, so an unanswered check must time out.
const CHECK_TIMEOUT_MS = 2000;

type CheckResult = 'up' | 'down';

@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // 503 when a dependency is down, so a load balancer stops sending traffic here.
  @Get()
  async check() {
    const [database, redis] = await Promise.all([
      probe(this.prisma.$queryRaw`SELECT 1`),
      probe(this.redis.getClient().ping()),
    ]);
    const body = {
      status: database === 'up' && redis === 'up' ? 'ok' : 'error',
      checks: { database, redis },
    };
    if (body.status !== 'ok') throw new ServiceUnavailableException(body);
    return { ...body, timestamp: new Date().toISOString() };
  }
}

function probe(check: Promise<unknown>): Promise<CheckResult> {
  const timeout = new Promise<CheckResult>((resolve) =>
    setTimeout(() => resolve('down'), CHECK_TIMEOUT_MS).unref(),
  );
  return Promise.race([
    check.then(
      (): CheckResult => 'up',
      (): CheckResult => 'down',
    ),
    timeout,
  ]);
}
