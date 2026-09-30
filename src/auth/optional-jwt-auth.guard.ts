import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AccessTokenClaims } from './auth.types';
import { extractBearerToken } from './extract-bearer-token';

/**
 * Like JwtAuthGuard, but for routes anyone can call. `request.user` is set
 * when a valid token is sent, and left undefined otherwise - it never
 * rejects the request. Public profiles/discovery are more useful to a
 * signed-in caller (follow state, "who am I") without requiring a session
 * just to browse them.
 */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = extractBearerToken(request);
    if (!token) return true;
    try {
      const claims = await this.jwtService.verifyAsync<AccessTokenClaims>(token, {
        secret: this.config.get<string>('JWT_ACCESS_SECRET'),
      });
      request.user = {
        id: claims.sub,
        username: claims.username,
        platformRole: claims.platformRole,
        sessionId: claims.sid,
      };
    } catch {
      // An invalid/expired token on an optional route just means "browse signed out".
    }
    return true;
  }
}
