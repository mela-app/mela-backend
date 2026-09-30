import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AccessTokenClaims } from './auth.types';
import { extractBearerToken } from './extract-bearer-token';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = extractBearerToken(request);

    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let claims: AccessTokenClaims;
    try {
      claims = await this.jwtService.verifyAsync<AccessTokenClaims>(token, {
        secret: this.config.get<string>('JWT_ACCESS_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    // A suspension or "sign out everywhere" must stop the access token too, not just the refresh.
    if (!claims.sid || !(await this.auth.isSessionActive(claims.sid, claims.sub))) {
      throw new UnauthorizedException('This session has ended');
    }
    request.user = {
      id: claims.sub,
      username: claims.username,
      platformRole: claims.platformRole,
      sessionId: claims.sid,
    };
    return true;
  }
}
