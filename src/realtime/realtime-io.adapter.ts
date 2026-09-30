import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';

/**
 * Socket.IO with the same allowed browser origins as HTTP (CORS_ORIGIN).
 * Gateway decorator options are read when the class loads, before .env is.
 */
export class RealtimeIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly corsOrigin: string[] | boolean,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, { ...options, cors: { origin: this.corsOrigin } });
  }
}
