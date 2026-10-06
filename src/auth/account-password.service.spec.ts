import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PlatformRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { DomainEvents } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { AccountPasswordService } from './account-password.service';
import { AuthService } from './auth.service';
import { AuthenticatedUser } from './auth.types';
import { IdentityVerifier } from './identity/firebase-identity.verifier';
import { VerifiedIdentity } from './identity/verified-identity';

describe('AccountPasswordService', () => {
  const prisma = { user: { findUnique: jest.fn(), update: jest.fn() } };
  const verifier = { verify: jest.fn<Promise<VerifiedIdentity>, [string]>() };
  const auth = { revokeOtherSessions: jest.fn(), revokeAllSessions: jest.fn() };
  const events = { emit: jest.fn() };

  const me: AuthenticatedUser = {
    id: 'u1',
    username: 'abebe',
    platformRole: PlatformRole.USER,
    sessionId: 's1',
  };
  const google: VerifiedIdentity = {
    method: 'google',
    subject: 'google-sub-1',
    email: 'abebe@gmail.com',
    name: 'Abebe',
  };
  const linkedGoogle = { subject: 'google-sub-1', email: 'abebe@gmail.com' };
  let currentHash: string;
  // The stored account: a Google sign-up without a password unless a test says otherwise.
  let stored: {
    email: string;
    passwordHash: string | null;
    platformRole: PlatformRole;
    identities: { subject: string; email: string | null }[];
  };

  const service = () =>
    new AccountPasswordService(
      prisma as unknown as PrismaService,
      verifier as unknown as IdentityVerifier,
      auth as unknown as AuthService,
      events as unknown as EventEmitter2,
    );

  beforeAll(async () => {
    currentHash = await argon2.hash('current-password');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    stored = {
      email: 'abebe@gmail.com',
      passwordHash: null,
      platformRole: PlatformRole.USER,
      identities: [linkedGoogle],
    };
    prisma.user.findUnique.mockImplementation(() => Promise.resolve({ ...stored }));
    prisma.user.update.mockImplementation(({ data }: { data: { passwordHash: string } }) => {
      stored.passwordHash = data.passwordHash;
      return Promise.resolve({});
    });
    verifier.verify.mockResolvedValue(google);
  });

  const newHash = () => prisma.user.update.mock.calls[0][0].data.passwordHash as string;
  const rejection = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error('expected a rejection');
      },
      (error: { getResponse(): unknown }) => error.getResponse(),
    );

  describe('signInMethods', () => {
    it('describes a Google account with no password', async () => {
      await expect(service().signInMethods('u1')).resolves.toEqual({
        email: 'abebe@gmail.com',
        hasPassword: false,
        google: { email: 'abebe@gmail.com' },
        managedByConsole: false,
      });
      expect(prisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'u1' } }),
      );
    });

    it('describes an email account, and leaves a staff one to the console', async () => {
      stored = {
        ...stored,
        passwordHash: currentHash,
        identities: [],
        platformRole: PlatformRole.SUPER_ADMIN,
      };
      await expect(service().signInMethods('u1')).resolves.toMatchObject({
        hasPassword: true,
        google: null,
        managedByConsole: true,
      });
    });
  });

  describe('adding the first password', () => {
    it('confirms with the linked Google account and keeps every device signed in', async () => {
      const result = await service().setPassword(me, {
        newPassword: 'brand-new-pass',
        idToken: 'google-token',
      });

      expect(verifier.verify).toHaveBeenCalledWith('google-token');
      expect(await argon2.verify(newHash(), 'brand-new-pass')).toBe(true);
      expect(auth.revokeOtherSessions).not.toHaveBeenCalled();
      expect(auth.revokeAllSessions).not.toHaveBeenCalled();
      expect(events.emit).toHaveBeenCalledWith(DomainEvents.AccountPasswordAdded, {
        userId: 'u1',
        confirmedWith: 'google',
      });
      expect(result).toMatchObject({ hasPassword: true });
    });

    it('needs a Google confirmation', async () => {
      await expect(
        rejection(service().setPassword(me, { newPassword: 'brand-new-pass' })),
      ).resolves.toMatchObject({ code: 'GOOGLE_CONFIRMATION_REQUIRED' });
      // A current password means nothing for an account that has none.
      await expect(
        rejection(
          service().setPassword(me, { newPassword: 'brand-new-pass', currentPassword: 'guess' }),
        ),
      ).resolves.toMatchObject({ code: 'GOOGLE_CONFIRMATION_REQUIRED' });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses a different Google account', async () => {
      verifier.verify.mockResolvedValue({ ...google, subject: 'someone-else' });
      const attempt = service().setPassword(me, { newPassword: 'brand-new-pass', idToken: 't' });

      await expect(attempt).rejects.toThrow(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses a confirmed email in place of Google', async () => {
      verifier.verify.mockResolvedValue({ method: 'email', email: 'abebe@gmail.com' });

      await expect(
        rejection(service().setPassword(me, { newPassword: 'brand-new-pass', idToken: 't' })),
      ).resolves.toMatchObject({ code: 'GOOGLE_ACCOUNT_MISMATCH' });
    });

    it('reports an expired Google sign-in without ending the session', async () => {
      verifier.verify.mockRejectedValue(
        new UnauthorizedException({ message: 'Expired.', code: 'INVALID_IDENTITY' }),
      );
      const attempt = service().setPassword(me, { newPassword: 'brand-new-pass', idToken: 't' });

      await expect(attempt).rejects.toThrow(BadRequestException);
      await expect(
        rejection(service().setPassword(me, { newPassword: 'brand-new-pass', idToken: 't' })),
      ).resolves.toEqual({ message: 'Expired.', code: 'INVALID_IDENTITY' });
    });

    it('refuses Google for an account with no Google sign-in', async () => {
      stored.identities = [];

      await expect(
        rejection(service().setPassword(me, { newPassword: 'brand-new-pass', idToken: 't' })),
      ).resolves.toMatchObject({ code: 'GOOGLE_ACCOUNT_MISMATCH' });
    });
  });

  describe('changing the password', () => {
    beforeEach(() => {
      stored.passwordHash = currentHash;
    });

    it('checks the current one and signs out every other device', async () => {
      await service().setPassword(me, {
        newPassword: 'brand-new-pass',
        currentPassword: 'current-password',
      });

      expect(verifier.verify).not.toHaveBeenCalled();
      expect(await argon2.verify(newHash(), 'brand-new-pass')).toBe(true);
      expect(auth.revokeOtherSessions).toHaveBeenCalledWith('u1', 's1');
      expect(events.emit).toHaveBeenCalledWith(DomainEvents.AccountPasswordChanged, {
        userId: 'u1',
        confirmedWith: 'password',
      });
    });

    it('signs out everywhere when the token predates per-device sessions', async () => {
      await service().setPassword(
        { ...me, sessionId: undefined },
        { newPassword: 'brand-new-pass', currentPassword: 'current-password' },
      );

      expect(auth.revokeAllSessions).toHaveBeenCalledWith('u1');
      expect(auth.revokeOtherSessions).not.toHaveBeenCalled();
    });

    it('resets a forgotten one with the linked Google account', async () => {
      await service().setPassword(me, { newPassword: 'brand-new-pass', idToken: 't' });

      expect(auth.revokeOtherSessions).toHaveBeenCalledWith('u1', 's1');
      expect(events.emit).toHaveBeenCalledWith(DomainEvents.AccountPasswordChanged, {
        userId: 'u1',
        confirmedWith: 'google',
      });
    });

    it('needs the current password', async () => {
      await expect(
        rejection(service().setPassword(me, { newPassword: 'brand-new-pass' })),
      ).resolves.toMatchObject({ code: 'CURRENT_PASSWORD_REQUIRED' });
    });

    it('refuses a wrong current password', async () => {
      const attempt = service().setPassword(me, {
        newPassword: 'brand-new-pass',
        currentPassword: 'wrong-password',
      });

      await expect(rejection(attempt)).resolves.toMatchObject({ code: 'WRONG_PASSWORD' });
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(auth.revokeOtherSessions).not.toHaveBeenCalled();
    });

    it('refuses the same password again', async () => {
      const attempt = service().setPassword(me, {
        newPassword: 'current-password',
        currentPassword: 'current-password',
      });

      await expect(rejection(attempt)).resolves.toMatchObject({ code: 'SAME_PASSWORD' });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  it('leaves staff passwords to the admin console', async () => {
    stored = {
      ...stored,
      passwordHash: currentHash,
      platformRole: PlatformRole.PLATFORM_MODERATOR,
    };

    await expect(
      rejection(
        service().setPassword(
          { ...me, platformRole: PlatformRole.PLATFORM_MODERATOR },
          { newPassword: 'brand-new-pass', currentPassword: 'current-password' },
        ),
      ),
    ).resolves.toMatchObject({ code: 'STAFF_ACCOUNT' });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
