import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedUser } from './auth.types';

// Undefined on a route guarded by OptionalJwtAuthGuard when no valid token was sent.
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser | undefined => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
