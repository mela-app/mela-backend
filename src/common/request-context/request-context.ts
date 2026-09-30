import { AsyncLocalStorage } from 'async_hooks';
import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

export interface RequestContextStore {
  ip?: string;
  userAgent?: string;
  // Which app the request came from: the admin console acts with platform powers.
  surface: 'admin' | 'app';
}

const storage = new AsyncLocalStorage<RequestContextStore>();

/**
 * Who is calling, for code far from the controller - the audit trail reads
 * it while handling a domain event emitted during the request.
 */
export const RequestContext = {
  current(): RequestContextStore | undefined {
    return storage.getStore();
  },
  run<T>(store: RequestContextStore, callback: () => T): T {
    return storage.run(store, callback);
  },
};

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    const userAgent = req.headers['user-agent'];
    RequestContext.run(
      {
        ip: req.ip,
        userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 400) : undefined,
        surface: req.originalUrl.startsWith('/v1/admin') ? 'admin' : 'app',
      },
      next,
    );
  }
}
