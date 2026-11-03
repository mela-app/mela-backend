import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { AuthenticatedUser } from '../auth/auth.types';
import { ActivityService, appClientOf } from './activity.service';

/**
 * Notes that a signed-in account used Mela today, once the auth guard let
 * the request through - not awaited, so no request waits on it. Only app
 * and web-player requests: the console's guard sets `request.admin`.
 */
@Injectable()
export class ActivityInterceptor implements NestInterceptor {
  constructor(private readonly activity: ActivityService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const request = context.switchToHttp().getRequest<{
        user?: AuthenticatedUser;
        headers: Record<string, unknown>;
      }>();
      const user = request.user;
      if (user?.sessionId) {
        void this.activity.touch(user.id, user.sessionId, appClientOf(request.headers));
      }
    }
    return next.handle();
  }
}
