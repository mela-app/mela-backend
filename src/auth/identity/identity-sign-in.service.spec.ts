import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  IdentityProvider,
  PlatformRole,
  Prisma,
  SessionPlatform,
  UserStatus,
} from '@prisma/client';
import * as argon2 from 'argon2';
import { DomainEvents } from '../../common/events/domain-events';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthService } from '../auth.service';
import { IdentityVerifier } from './firebase-identity.verifier';
import { IdentitySignInService } from './identity-sign-in.service';
import { VerifiedIdentity } from './verified-identity';
import { LEGAL_VERSION } from '../../legal/legal-rules';

// Old enough, and the Terms/Privacy in force agreed to.
const legal = { birthDate: '1995-04-20', acceptedLegalVersion: LEGAL_VERSION };

describe('IdentitySignInService', () => {
  const prisma = {
    user: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    userIdentity: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
    userSession: { deleteMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const verifier = { verify: jest.fn<Promise<VerifiedIdentity>, [string]>() };
  const auth = { startSessionFor: jest.fn() };
  const events = { emit: jest.fn() };
  const tokens = { accessToken: 'access', refreshToken: 'refresh' };

  const google: VerifiedIdentity = {
    method: 'google',
    subject: 'google-sub-1',
    email: 'abebe@gmail.com',
    name: 'Abebe Kebede',
  };
  const emailed: VerifiedIdentity = { method: 'email', email: 'ana@example.com' };
  const account = (overrides: Record<string, unknown> = {}) => ({
    id: 'u1',
    username: 'abebe',
    email: 'Abebe@Gmail.com',
    platformRole: PlatformRole.USER,
    status: UserStatus.ACTIVE,
    passwordHash: 'old-hash',
    emailVerifiedAt: null,
    ...overrides,
  });

  const service = () =>
    new IdentitySignInService(
      prisma as unknown as PrismaService,
      verifier as unknown as IdentityVerifier,
      auth as unknown as AuthService,
      events as unknown as EventEmitter2,
    );

  const uniqueViolation = (target: string[]) =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target },
    });

  beforeEach(() => {
    jest.clearAllMocks();
    verifier.verify.mockResolvedValue(google);
    prisma.userIdentity.findUnique.mockResolvedValue(null);
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.update.mockImplementation(({ data }) => Promise.resolve({ ...account(), ...data }));
    prisma.user.create.mockImplementation(({ data }) => Promise.resolve({ id: 'new', ...data }));
    prisma.userSession.deleteMany.mockResolvedValue({ count: 2 });
    prisma.$transaction.mockImplementation((run: (tx: typeof prisma) => unknown) => run(prisma));
    auth.startSessionFor.mockResolvedValue(tokens);
  });

  describe('continuing with Google', () => {
    it('signs in the account their Google account is linked to', async () => {
      const user = account({ emailVerifiedAt: new Date() });
      prisma.userIdentity.findUnique.mockResolvedValue({ id: 'i1', user });

      await expect(service().continueWith('token', SessionPlatform.ANDROID)).resolves.toEqual({
        status: 'SIGNED_IN',
        tokens,
      });
      expect(prisma.userIdentity.findUnique).toHaveBeenCalledWith({
        where: {
          provider_subject: { provider: IdentityProvider.GOOGLE, subject: 'google-sub-1' },
        },
        include: { user: true },
      });
      expect(auth.startSessionFor).toHaveBeenCalledWith(user, SessionPlatform.ANDROID);
      expect(events.emit).toHaveBeenCalledWith(DomainEvents.UserLoggedIn, {
        userId: 'u1',
        platform: SessionPlatform.ANDROID,
        method: 'google',
      });
    });

    it('offers someone new a start - their Google name and a free username', async () => {
      prisma.user.findMany.mockResolvedValue([{ username: 'Abebe_Kebede' }]);

      const outcome = await service().continueWith('token');

      expect(outcome).toEqual({
        status: 'NEEDS_ACCOUNT',
        profile: {
          email: 'abebe@gmail.com',
          displayName: 'Abebe Kebede',
          suggestedUsername: expect.stringMatching(/^abebe_kebede_\d{2}$/),
        },
      });
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(auth.startSessionFor).not.toHaveBeenCalled();
    });

    it('links an account whose email was already proven, keeping its password and devices', async () => {
      const verifiedAt = new Date('2026-10-01');
      prisma.user.findFirst.mockResolvedValue(account({ emailVerifiedAt: verifiedAt }));

      await expect(service().continueWith('token')).resolves.toMatchObject({ status: 'SIGNED_IN' });

      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { email: { equals: 'abebe@gmail.com', mode: 'insensitive' } },
      });
      expect(prisma.userIdentity.create).toHaveBeenCalledWith({
        data: {
          userId: 'u1',
          provider: IdentityProvider.GOOGLE,
          subject: 'google-sub-1',
          email: 'abebe@gmail.com',
        },
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { emailVerifiedAt: verifiedAt },
      });
      expect(prisma.userSession.deleteMany).not.toHaveBeenCalled();
      expect(events.emit).toHaveBeenCalledWith(DomainEvents.AccountIdentityLinked, {
        userId: 'u1',
        provider: IdentityProvider.GOOGLE,
        passwordRemoved: false,
      });
    });

    it('takes over an account made with their email but never proven: its password and devices stop working', async () => {
      prisma.user.findFirst.mockResolvedValue(account());

      await expect(service().continueWith('token')).resolves.toMatchObject({ status: 'SIGNED_IN' });

      expect(prisma.userSession.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { emailVerifiedAt: expect.any(Date), passwordHash: null },
      });
      // The new device's session starts after the old ones end.
      expect(prisma.userSession.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
        auth.startSessionFor.mock.invocationCallOrder[0],
      );
      expect(events.emit).toHaveBeenCalledWith(
        DomainEvents.AccountIdentityLinked,
        expect.objectContaining({ passwordRemoved: true }),
      );
    });

    it('refuses an account already linked to a different Google account', async () => {
      prisma.user.findFirst.mockResolvedValue(account({ emailVerifiedAt: new Date() }));
      prisma.userIdentity.create.mockRejectedValue(uniqueViolation(['userId', 'provider']));

      await expect(service().continueWith('token')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'GOOGLE_ACCOUNT_MISMATCH' }),
      });
      expect(auth.startSessionFor).not.toHaveBeenCalled();
    });

    it('leaves staff and suspended accounts alone', async () => {
      prisma.user.findFirst.mockResolvedValue(account({ platformRole: PlatformRole.SUPER_ADMIN }));
      await expect(service().continueWith('token')).rejects.toThrow(ForbiddenException);

      prisma.userIdentity.findUnique.mockResolvedValue({
        id: 'i1',
        user: account({ status: UserStatus.SUSPENDED }),
      });
      await expect(service().continueWith('token')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'ACCOUNT_SUSPENDED' }),
      });

      expect(prisma.userIdentity.create).not.toHaveBeenCalled();
      expect(auth.startSessionFor).not.toHaveBeenCalled();
    });
  });

  describe('a confirmed email', () => {
    beforeEach(() => verifier.verify.mockResolvedValue(emailed));

    it('only ever starts a new account - never signs into one', async () => {
      await expect(service().continueWith('token')).resolves.toMatchObject({
        status: 'NEEDS_ACCOUNT',
        profile: { email: 'ana@example.com', suggestedUsername: 'ana' },
      });

      prisma.user.findFirst.mockResolvedValue(account());
      await expect(service().continueWith('token')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'EMAIL_TAKEN' }),
      });
      expect(auth.startSessionFor).not.toHaveBeenCalled();
    });

    it('creates the account with its own password, the email marked proven', async () => {
      await expect(
        service().createAccount({
          idToken: 'token',
          username: 'ana',
          displayName: 'Ana',
          password: 'a-good-password',
          platform: SessionPlatform.IOS,
          ...legal,
        }),
      ).resolves.toEqual(tokens);

      const { data } = prisma.user.create.mock.calls[0][0];
      expect(data).toMatchObject({
        username: 'ana',
        displayName: 'Ana',
        email: 'ana@example.com',
        emailVerifiedAt: expect.any(Date),
        birthDate: new Date('1995-04-20T00:00:00Z'),
        legalVersion: LEGAL_VERSION,
        legalAcceptedAt: expect.any(Date),
        legalAcceptances: { create: { version: LEGAL_VERSION, platform: SessionPlatform.IOS } },
      });
      expect(data).not.toHaveProperty('identities');
      expect(await argon2.verify(data.passwordHash, 'a-good-password')).toBe(true);
      expect(events.emit).toHaveBeenCalledWith(DomainEvents.UserRegistered, {
        userId: 'new',
        username: 'ana',
        method: 'email',
      });
      expect(auth.startSessionFor).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'new' }),
        SessionPlatform.IOS,
      );
    });

    it('needs a password', async () => {
      await expect(
        service().createAccount({
          idToken: 'token',
          username: 'ana',
          displayName: 'Ana',
          ...legal,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });
  });

  describe('creating an account with Google', () => {
    const newAccount = { idToken: 'token', username: 'abebe', displayName: 'Abebe', ...legal };

    it('links the Google account and has no password', async () => {
      await expect(service().createAccount(newAccount)).resolves.toEqual(tokens);

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: {
          username: 'abebe',
          displayName: 'Abebe',
          email: 'abebe@gmail.com',
          passwordHash: null,
          emailVerifiedAt: expect.any(Date),
          birthDate: new Date('1995-04-20T00:00:00Z'),
          legalVersion: LEGAL_VERSION,
          legalAcceptedAt: expect.any(Date),
          legalAcceptances: {
            create: { version: LEGAL_VERSION, platform: SessionPlatform.UNKNOWN },
          },
          identities: {
            create: {
              provider: IdentityProvider.GOOGLE,
              subject: 'google-sub-1',
              email: 'abebe@gmail.com',
            },
          },
        },
      });
      expect(events.emit).toHaveBeenCalledWith(
        DomainEvents.UserRegistered,
        expect.objectContaining({ method: 'google' }),
      );
    });

    it('refuses a password, and anything already taken', async () => {
      await expect(
        service().createAccount({ ...newAccount, password: 'a-good-password' }),
      ).rejects.toThrow(BadRequestException);

      prisma.userIdentity.findUnique.mockResolvedValueOnce({ id: 'i1', user: account() });
      await expect(service().createAccount(newAccount)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'ACCOUNT_EXISTS' }),
      });

      prisma.user.findFirst.mockResolvedValueOnce(account());
      await expect(service().createAccount(newAccount)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'EMAIL_TAKEN' }),
      });

      // The email is free; the username, whatever its case, isn't.
      prisma.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'u2' });
      await expect(service().createAccount(newAccount)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'USERNAME_TAKEN' }),
      });
      expect(prisma.user.findFirst).toHaveBeenLastCalledWith({
        where: { username: { equals: 'abebe', mode: 'insensitive' } },
        select: { id: true },
      });
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    describe('the age check and the Terms', () => {
      const now = new Date('2026-10-12T10:00:00Z');

      it('only for people 18 or older - checked before anything else', async () => {
        await expect(
          service().createAccount({ ...newAccount, birthDate: '2008-10-13' }, now),
        ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'UNDER_AGE' }) });
        expect(verifier.verify).not.toHaveBeenCalled();

        // 18 today.
        await expect(
          service().createAccount({ ...newAccount, birthDate: '2008-10-12' }, now),
        ).resolves.toEqual(tokens);
      });

      it('needs a real date of birth', async () => {
        for (const birthDate of ['2001-02-30', '12/04/1995', '2027-01-01', '1899-12-31']) {
          await expect(
            service().createAccount({ ...newAccount, birthDate }, now),
          ).rejects.toMatchObject({
            response: expect.objectContaining({ code: 'INVALID_BIRTH_DATE' }),
          });
        }
      });

      it('needs the Terms and Privacy Policy in force accepted', async () => {
        await expect(
          service().createAccount({ ...newAccount, acceptedLegalVersion: '2020-01-01' }, now),
        ).rejects.toMatchObject({
          response: expect.objectContaining({
            code: 'LEGAL_VERSION_OUTDATED',
            version: LEGAL_VERSION,
          }),
        });
      });

      it('tells an app from before the age check to update', async () => {
        await expect(
          service().createAccount(
            { idToken: 'token', username: 'abebe', displayName: 'Abebe' },
            now,
          ),
        ).rejects.toMatchObject({
          response: expect.objectContaining({ code: 'APP_UPDATE_REQUIRED' }),
        });
      });
    });

    it('says which field someone else took in the meantime', async () => {
      prisma.user.create.mockRejectedValueOnce(uniqueViolation(['username']));
      await expect(service().createAccount(newAccount)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'USERNAME_TAKEN' }),
      });

      prisma.user.create.mockRejectedValueOnce(uniqueViolation(['email']));
      await expect(service().createAccount(newAccount)).rejects.toThrow(ConflictException);
      expect(auth.startSessionFor).not.toHaveBeenCalled();
    });
  });
});
