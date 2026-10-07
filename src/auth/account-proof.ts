import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { IdentityVerifier } from './identity/firebase-identity.verifier';

/** What someone gives to prove it's them before changing or deleting their account. */
export interface AccountProof {
  currentPassword?: string;
  /** A fresh Google sign-in to the account's linked Google account. */
  idToken?: string;
}

export interface ProvableAccount {
  passwordHash: string | null;
  // Its linked Google identities: none, or one.
  identities: Array<{ subject: string }>;
}

/**
 * Checks that whoever asks is the account's owner right now (docs/features/auth.md):
 * its current password, or a fresh sign-in to its linked Google account - the
 * only way for an account made with Google, and the way back for anyone who
 * forgot their password. Says which it was; throws a worded 400 or 403 otherwise.
 */
export async function proveAccount(
  account: ProvableAccount,
  proof: AccountProof,
  verifier: IdentityVerifier,
): Promise<'password' | 'google'> {
  if (proof.idToken) {
    const identity = await verifier.verify(proof.idToken).catch((error: unknown) => {
      // A 401 on a signed-in route reads as this device's own session ending.
      throw error instanceof UnauthorizedException
        ? new BadRequestException(error.getResponse())
        : error;
    });
    const linked = account.identities[0];
    if (identity.method !== 'google' || !linked || linked.subject !== identity.subject) {
      throw new ForbiddenException({
        message: 'Confirm with the Google account linked to this Mela account.',
        code: 'GOOGLE_ACCOUNT_MISMATCH',
      });
    }
    return 'google';
  }
  if (account.passwordHash && proof.currentPassword) {
    if (!(await argon2.verify(account.passwordHash, proof.currentPassword))) {
      throw new BadRequestException({
        message: 'Your current password is incorrect.',
        code: 'WRONG_PASSWORD',
      });
    }
    return 'password';
  }
  throw new BadRequestException(
    account.passwordHash
      ? { message: 'Enter your current password.', code: 'CURRENT_PASSWORD_REQUIRED' }
      : { message: 'Confirm with Google first.', code: 'GOOGLE_CONFIRMATION_REQUIRED' },
  );
}
