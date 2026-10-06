import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IdentityProvider, PlatformRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { AccountPasswordSetPayload, DomainEvents } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuthService } from './auth.service';
import { AuthenticatedUser } from './auth.types';
import { IdentityVerifier } from './identity/firebase-identity.verifier';

/** How an account signs in - for its own settings screen only. */
export interface SignInMethods {
  email: string;
  hasPassword: boolean;
  /** The Google account linked to it, if any. */
  google: { email: string | null } | null;
  /** Staff passwords follow the console's stricter rules and change only there. */
  managedByConsole: boolean;
}

export interface NewPassword {
  newPassword: string;
  currentPassword?: string;
  /** A fresh Google sign-in to the account's linked Google account. */
  idToken?: string;
}

/**
 * Adding or changing an account's own password (docs/features/auth.md).
 * Whoever asks proves it's them right now: with the current password, or by
 * confirming with the linked Google account - the only way for an account
 * made with Google, and the way back for anyone who forgot theirs.
 */
@Injectable()
export class AccountPasswordService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly verifier: IdentityVerifier,
    private readonly auth: AuthService,
    private readonly events: EventEmitter2,
  ) {}

  async signInMethods(userId: string): Promise<SignInMethods> {
    const account = await this.findAccount(userId);
    const google = account.identities[0];
    return {
      email: account.email,
      hasPassword: account.passwordHash !== null,
      google: google ? { email: google.email } : null,
      managedByConsole: account.platformRole !== PlatformRole.USER,
    };
  }

  async setPassword(user: AuthenticatedUser, request: NewPassword): Promise<SignInMethods> {
    const account = await this.findAccount(user.id);
    if (account.platformRole !== PlatformRole.USER) {
      throw new ForbiddenException({
        message: 'Change a staff account password in the admin console.',
        code: 'STAFF_ACCOUNT',
      });
    }

    let confirmedWith: AccountPasswordSetPayload['confirmedWith'];
    if (request.idToken) {
      const identity = await this.verifier.verify(request.idToken).catch((error: unknown) => {
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
      confirmedWith = 'google';
    } else if (account.passwordHash && request.currentPassword) {
      if (!(await argon2.verify(account.passwordHash, request.currentPassword))) {
        throw new BadRequestException({
          message: 'Your current password is incorrect.',
          code: 'WRONG_PASSWORD',
        });
      }
      confirmedWith = 'password';
    } else {
      throw new BadRequestException(
        account.passwordHash
          ? { message: 'Enter your current password.', code: 'CURRENT_PASSWORD_REQUIRED' }
          : { message: 'Confirm with Google first.', code: 'GOOGLE_CONFIRMATION_REQUIRED' },
      );
    }

    const previousHash = account.passwordHash;
    if (previousHash && (await argon2.verify(previousHash, request.newPassword))) {
      throw new BadRequestException({
        message: 'Choose a password different from your current one.',
        code: 'SAME_PASSWORD',
      });
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await argon2.hash(request.newPassword) },
    });
    // A new password ends every other device; the first one, added to a Google account, doesn't.
    if (previousHash) {
      if (user.sessionId) await this.auth.revokeOtherSessions(user.id, user.sessionId);
      else await this.auth.revokeAllSessions(user.id);
    }
    this.events.emit(
      previousHash ? DomainEvents.AccountPasswordChanged : DomainEvents.AccountPasswordAdded,
      { userId: user.id, confirmedWith } satisfies AccountPasswordSetPayload,
    );
    return this.signInMethods(user.id);
  }

  private async findAccount(userId: string) {
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        passwordHash: true,
        platformRole: true,
        identities: {
          where: { provider: IdentityProvider.GOOGLE },
          select: { subject: true, email: true },
        },
      },
    });
    if (!account) throw new NotFoundException('Account not found');
    return account;
  }
}
