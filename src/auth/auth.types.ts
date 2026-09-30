import { PlatformRole } from '@prisma/client';

export interface AuthenticatedUser {
  id: string;
  username: string;
  platformRole: PlatformRole;
  // Absent on access tokens issued before per-device sessions existed.
  sessionId?: string;
}

export interface AccessTokenClaims {
  sub: string;
  username: string;
  platformRole: PlatformRole;
  sid?: string;
}

export interface RefreshTokenClaims extends AccessTokenClaims {
  jti: string;
}
