import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { ServerOptions } from 'socket.io';

/**
 * Socket.IO with the same allowed browser origins as HTTP (CORS_ORIGIN).
 * Gateway decorator options are read when the class loads, before .env is.
 *
 * Rooms span every API instance through Redis pub/sub (the Redis adapter):
 * an event for a live's room or a person's `user:{id}` room reaches sockets
 * on all instances, so the API can run as several replicas. The apps connect
 * over WebSocket only (no long-polling), so a load balancer needs no sticky
 * sessions. See docs/features/realtime.md.
 */
export class RealtimeIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RealtimeIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private readonly clients: Redis[] = [];

  constructor(
    app: INestApplicationContext,
    private readonly corsOrigin: string[] | boolean,
  ) {
    super(app);
  }

  /** Opens the pub/sub connections; call once before the gateway starts. */
  async connectToRedis(redisUrl: string): Promise<void> {
    const pub = new Redis(redisUrl, { lazyConnect: true });
    const sub = pub.duplicate();
    for (const client of [pub, sub]) {
      client.on('error', (error) => this.logger.error('Realtime Redis connection error', error));
    }
    await Promise.all([pub.connect(), sub.connect()]);
    this.clients.push(pub, sub);
    this.adapterConstructor = createAdapter(pub, sub);
  }

  override createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, { ...options, cors: { origin: this.corsOrigin } });
    if (this.adapterConstructor) server.adapter(this.adapterConstructor);
    return server;
  }

  override async dispose(): Promise<void> {
    await super.dispose();
    await Promise.all(this.clients.map((client) => client.quit().catch(() => undefined)));
  }
}
