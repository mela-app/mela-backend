import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  IdentityProvider,
  PlatformRole,
  Prisma,
  SessionPlatform,
  User,
  UserStatus,
} from '@prisma/client';
import * as argon2 from 'argon2';
import {
  AccountIdentityLinkedPayload,
  DomainEvents,
  UserLoggedInPayload,
  UserRegisteredPayload,
} from '../../common/events/domain-events';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthService, TokenPair } from '../auth.service';
import { IdentityVerifier } from './firebase-identity.verifier';
import { usernameCandidates } from './usernames';
import { VerifiedIdentity } from './verified-identity';

type GoogleIdentity = Extract<VerifiedIdentity, { method: 'google' }>;

/** What a new account starts with, offered before it's created. */
export interface NewAccountProfile {
  email: string;
  displayName: string;
  suggestedUsername: string;
}

export type IdentityOutcome =
  | { status: 'SIGNED_IN'; tokens: TokenPair }
  | { status: 'NEEDS_ACCOUNT'; profile: NewAccountProfile };

export interface NewAccount {
  idToken: string;
  username: string;
  displayName: string;
  /** Required for an email sign-up, refused for Google. */
  password?: string;
  platform?: SessionPlatform;
}

/**
 * Signing up only with a proven identity (docs/features/auth.md): a Google
 * account, or an email whose owner tapped Firebase's link. The identity
 * token is checked by [IdentityVerifier]; accounts, passwords and sessions
 * stay Mela's own.
 */
@Injectable()
export class IdentitySignInService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly verifier: IdentityVerifier,
    private readonly auth: AuthService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Signs in whoever the token proves, when they have an account - found by
   * their Google account, or by the email Google vouched for, which links
   * the two. Otherwise: what their new account would start with.
   */
  async continueWith(idToken: string, platform?: SessionPlatform): Promise<IdentityOutcome> {
    const identity = await this.verifier.verify(idToken);
    if (identity.method === 'email') {
      // A confirmed email creates an account; it never signs into one.
      if (await this.findByEmail(identity.email)) throw emailTaken();
      return { status: 'NEEDS_ACCOUNT', profile: await this.newAccountProfile(identity) };
    }

    const linked = await this.findGoogleIdentity(identity.subject);
    if (linked) {
      assertMayUseGoogle(linked.user);
      await this.prisma.userIdentity.update({
        where: { id: linked.id },
        data: { lastUsedAt: new Date() },
      });
      return { status: 'SIGNED_IN', tokens: await this.signIn(linked.user, platform) };
    }

    const account = await this.findByEmail(identity.email);
    if (!account) {
      return { status: 'NEEDS_ACCOUNT', profile: await this.newAccountProfile(identity) };
    }
    const user = await this.linkGoogle(account, identity);
    return { status: 'SIGNED_IN', tokens: await this.signIn(user, platform) };
  }

  async createAccount(account: NewAccount): Promise<TokenPair> {
    const identity = await this.verifier.verify(account.idToken);
    if (identity.method === 'email' && !account.password) {
      throw new BadRequestException({
        message: 'Choose a password for your account.',
        code: 'PASSWORD_REQUIRED',
      });
    }
    if (identity.method === 'google' && account.password) {
      throw new BadRequestException({
        message: 'An account made with Google signs in with Google - it needs no password.',
        code: 'PASSWORD_NOT_ALLOWED',
      });
    }
    if (identity.method === 'google' && (await this.findGoogleIdentity(identity.subject))) {
      throw accountExists();
    }
    if (await this.findByEmail(identity.email)) throw emailTaken();
    if (!(await this.isUsernameAvailable(account.username))) throw usernameTaken();

    let user: User;
    try {
      user = await this.prisma.user.create({
        data: {
          username: account.username,
          displayName: account.displayName,
          email: identity.email,
          passwordHash: account.password ? await argon2.hash(account.password) : null,
          emailVerifiedAt: new Date(),
          ...(identity.method === 'google' && {
            identities: {
              create: {
                provider: IdentityProvider.GOOGLE,
                subject: identity.subject,
                email: identity.email,
              },
            },
          }),
        },
      });
    } catch (error) {
      // Someone else got there between the checks above and this.
      const fields = uniqueViolation(error);
      if (!fields) throw error;
      if (fields.includes('username')) throw usernameTaken();
      if (fields.includes('email')) throw emailTaken();
      throw accountExists();
    }

    this.events.emit(DomainEvents.UserRegistered, {
      userId: user.id,
      username: user.username,
      method: identity.method,
    } satisfies UserRegisteredPayload);
    return this.auth.startSessionFor(user, account.platform ?? SessionPlatform.UNKNOWN);
  }

  /** Free whatever its case, so nobody can pass for someone else. */
  async isUsernameAvailable(username: string): Promise<boolean> {
    const taken = await this.prisma.user.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
      select: { id: true },
    });
    return taken === null;
  }

  private async newAccountProfile(identity: VerifiedIdentity): Promise<NewAccountProfile> {
    const localPart = identity.email.split('@')[0] ?? '';
    const name = identity.method === 'google' ? identity.name : null;
    return {
      email: identity.email,
      displayName: (name ?? localPart).slice(0, 50),
      suggestedUsername: await this.suggestUsername([name ?? '', localPart]),
    };
  }

  private async suggestUsername(seeds: string[]): Promise<string> {
    for (let round = 0; round < 3; round++) {
      const candidates = usernameCandidates(seeds, round);
      const taken = await this.prisma.user.findMany({
        where: { username: { in: candidates, mode: 'insensitive' } },
        select: { username: true },
      });
      const takenNames = new Set(taken.map(({ username }) => username.toLowerCase()));
      const free = candidates.find((candidate) => !takenNames.has(candidate.toLowerCase()));
      if (free) return free;
    }
    // Practically never reached; the person can still pick their own.
    return usernameCandidates([], 4)[0];
  }

  /**
   * The person proved they own this account's email with Google. If that
   * email was never proven before, whoever made the account may not own it:
   * its password stops working and its other devices are signed out.
   */
  private async linkGoogle(user: User, identity: GoogleIdentity): Promise<User> {
    assertMayUseGoogle(user);
    const takeOver = user.emailVerifiedAt === null;
    let linked: User;
    try {
      linked = await this.prisma.$transaction(async (tx) => {
        await tx.userIdentity.create({
          data: {
            userId: user.id,
            provider: IdentityProvider.GOOGLE,
            subject: identity.subject,
            email: identity.email,
          },
        });
        if (takeOver) await tx.userSession.deleteMany({ where: { userId: user.id } });
        return tx.user.update({
          where: { id: user.id },
          data: {
            emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
            ...(takeOver && { passwordHash: null }),
          },
        });
      });
    } catch (error) {
      const fields = uniqueViolation(error);
      if (!fields) throw error;
      throw new ConflictException(
        fields.includes('userId')
          ? {
              message: "This email's Mela account is linked to a different Google account.",
              code: 'GOOGLE_ACCOUNT_MISMATCH',
            }
          : { message: 'Please try again.', code: 'TRY_AGAIN' },
      );
    }

    this.events.emit(DomainEvents.AccountIdentityLinked, {
      userId: user.id,
      provider: IdentityProvider.GOOGLE,
      passwordRemoved: takeOver,
    } satisfies AccountIdentityLinkedPayload);
    return linked;
  }

  private async signIn(
    user: User,
    platform: SessionPlatform = SessionPlatform.UNKNOWN,
  ): Promise<TokenPair> {
    const tokens = await this.auth.startSessionFor(user, platform);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    this.events.emit(DomainEvents.UserLoggedIn, {
      userId: user.id,
      platform,
      method: 'google',
    } satisfies UserLoggedInPayload);
    return tokens;
  }

  private findGoogleIdentity(subject: string) {
    return this.prisma.userIdentity.findUnique({
      where: { provider_subject: { provider: IdentityProvider.GOOGLE, subject } },
      include: { user: true },
    });
  }

  private findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
  }
}

// Staff sign in with a password the console can check, so a mistyped staff email can't be claimed with Google.
function assertMayUseGoogle(user: User): void {
  if (user.platformRole !== PlatformRole.USER) {
    throw new ForbiddenException({
      message: 'Staff accounts sign in with their password.',
      code: 'PASSWORD_SIGN_IN_REQUIRED',
    });
  }
  if (user.status === UserStatus.SUSPENDED) {
    throw new ForbiddenException({
      message: 'This account has been suspended',
      code: 'ACCOUNT_SUSPENDED',
    });
  }
}

// The unique fields a create ran into, or null for any other error.
function uniqueViolation(error: unknown): string[] | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return null;
  }
  const target = error.meta?.target;
  return Array.isArray(target) ? target.map(String) : [String(target ?? '')];
}

function emailTaken(): ConflictException {
  return new ConflictException({
    message: 'This email already has a Mela account. Log in instead.',
    code: 'EMAIL_TAKEN',
  });
}

function usernameTaken(): ConflictException {
  return new ConflictException({
    message: 'That username is taken. Try another.',
    code: 'USERNAME_TAKEN',
  });
}

function accountExists(): ConflictException {
  return new ConflictException({
    message: 'You already have a Mela account - use Continue with Google to sign in.',
    code: 'ACCOUNT_EXISTS',
  });
}
