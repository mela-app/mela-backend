import { BadRequestException, ForbiddenException } from '@nestjs/common';

/**
 * Someone a sign-in provider vouched for - what an identity token proves.
 * Firebase verifies it today; a phone number is the next method (it needs no
 * new endpoint, only a case here and in IdentitySignInService).
 */
export type VerifiedIdentity =
  | {
      method: 'google';
      /** Google's own id for the account; it never changes, unlike the email. */
      subject: string;
      email: string;
      name: string | null;
    }
  | {
      /** An email and password, after its owner tapped the link Firebase emailed. */
      method: 'email';
      email: string;
    };

/** The claims of a verified Firebase ID token this cares about. */
export interface FirebaseTokenClaims {
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  firebase: { sign_in_provider: string; identities?: Record<string, unknown> };
}

/** What a verified Firebase ID token proves, or why it isn't enough to sign in with. */
export function identityFromFirebaseClaims(claims: FirebaseTokenClaims): VerifiedIdentity {
  const email = typeof claims.email === 'string' ? normalizeEmail(claims.email) : '';
  const emailVerified = claims.email_verified === true;
  switch (claims.firebase.sign_in_provider) {
    case 'google.com': {
      const ids = claims.firebase.identities?.['google.com'];
      const subject = Array.isArray(ids) && typeof ids[0] === 'string' ? ids[0] : '';
      if (!subject || !email || !emailVerified) throw unsupported();
      const name =
        typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : null;
      return { method: 'google', subject, email, name };
    }
    case 'password':
      if (!email) throw unsupported();
      if (!emailVerified) {
        throw new ForbiddenException({
          message: 'Confirm your email first - tap the link we sent you.',
          code: 'EMAIL_NOT_VERIFIED',
        });
      }
      return { method: 'email', email };
    default:
      throw unsupported();
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function unsupported(): BadRequestException {
  return new BadRequestException({
    message: "This way of signing in isn't supported.",
    code: 'UNSUPPORTED_IDENTITY',
  });
}
