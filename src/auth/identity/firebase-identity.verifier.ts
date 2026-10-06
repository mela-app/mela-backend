import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { App, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { identityFromFirebaseClaims, VerifiedIdentity } from './verified-identity';

/** Turns a sign-in identity token from the app or the web player into who it proves someone is. */
export abstract class IdentityVerifier {
  abstract verify(idToken: string): Promise<VerifiedIdentity>;
}

// Its own app, apart from push notifications' credentialed one: checking a token needs only the project id.
const APP_NAME = 'mela-identity';

/**
 * Firebase Authentication as the verifier only: it confirms Google accounts
 * and emailed links (and later, phone numbers); Mela keeps the accounts,
 * passwords and sessions. Checks the token's signature, audience (this
 * project), issuer and expiry against Google's public keys.
 */
@Injectable()
export class FirebaseIdentityVerifier extends IdentityVerifier {
  private app?: App;

  constructor(private readonly config: ConfigService) {
    super();
  }

  async verify(idToken: string): Promise<VerifiedIdentity> {
    let claims;
    try {
      claims = await getAuth(this.firebase()).verifyIdToken(idToken);
    } catch {
      throw new UnauthorizedException({
        message: 'That sign-in has expired. Please try again.',
        code: 'INVALID_IDENTITY',
      });
    }
    return identityFromFirebaseClaims(claims);
  }

  private firebase(): App {
    this.app ??=
      getApps().find((app) => app.name === APP_NAME) ??
      initializeApp({ projectId: this.config.getOrThrow<string>('FIREBASE_PROJECT_ID') }, APP_NAME);
    return this.app;
  }
}
