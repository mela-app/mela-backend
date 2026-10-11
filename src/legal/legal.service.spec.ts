import { SessionPlatform, UserStatus } from '@prisma/client';
import { DomainEvents } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { renderPrivacyPage, renderTermsPage } from './legal-pages';
import { ageOn, LEGAL_VERSION, parseBirthDate, UNDER_AGE_REASON } from './legal-rules';
import { LegalService } from './legal.service';

const now = new Date('2026-10-12T10:00:00Z');

describe('the age rules', () => {
  it('counts whole years, 18 from the birthday itself', () => {
    expect(ageOn(new Date('2008-10-12T00:00:00Z'), now)).toBe(18);
    expect(ageOn(new Date('2008-10-13T00:00:00Z'), now)).toBe(17);
    expect(ageOn(new Date('2000-02-29T00:00:00Z'), new Date('2018-02-28T12:00:00Z'))).toBe(17);
    expect(ageOn(new Date('2000-02-29T00:00:00Z'), new Date('2018-03-01T12:00:00Z'))).toBe(18);
  });

  it('takes only real dates of birth', () => {
    expect(parseBirthDate('1995-04-20', now)).toEqual(new Date('1995-04-20T00:00:00Z'));
    expect(parseBirthDate('2001-02-30', now)).toBeNull();
    expect(parseBirthDate('1995-4-20', now)).toBeNull();
    expect(parseBirthDate('2026-10-13', now)).toBeNull();
    expect(parseBirthDate('1899-12-31', now)).toBeNull();
  });
});

describe('LegalService', () => {
  const prisma = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    legalAcceptance: { create: jest.fn() },
    $transaction: jest.fn((operations: unknown[]) => Promise.all(operations)),
  };
  const events = { emit: jest.fn() };
  const service = () => new LegalService(prisma as unknown as PrismaService, events as never);

  const account = (fields: object) =>
    prisma.user.findUnique.mockResolvedValue({
      legalVersion: null,
      birthDate: null,
      status: UserStatus.ACTIVE,
      ...fields,
    });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('asks an account made before the age check for both', async () => {
    account({});

    await expect(service().status('u1')).resolves.toMatchObject({
      version: LEGAL_VERSION,
      minimumAge: 18,
      termsPath: '/terms',
      privacyPath: '/privacy',
      acceptedVersion: null,
      needsAcceptance: true,
      needsBirthDate: true,
    });
  });

  it('asks again once the documents change, but not for the date of birth', async () => {
    account({ legalVersion: '2020-01-01', birthDate: new Date('1990-01-01') });

    await expect(service().status('u1')).resolves.toMatchObject({
      needsAcceptance: true,
      needsBirthDate: false,
    });
  });

  it('records the acceptance and the date of birth', async () => {
    account({});

    await service().accept(
      'u1',
      { version: LEGAL_VERSION, birthDate: '1995-04-20' },
      SessionPlatform.ANDROID,
      now,
    );

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: {
        legalVersion: LEGAL_VERSION,
        legalAcceptedAt: now,
        birthDate: new Date('1995-04-20T00:00:00Z'),
      },
    });
    expect(prisma.legalAcceptance.create).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        version: LEGAL_VERSION,
        platform: SessionPlatform.ANDROID,
        acceptedAt: now,
      },
    });
  });

  it('never changes a date of birth already given', async () => {
    account({ birthDate: new Date('1990-01-01T00:00:00Z') });

    await service().accept(
      'u1',
      { version: LEGAL_VERSION, birthDate: '2015-01-01' },
      undefined,
      now,
    );

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { legalVersion: LEGAL_VERSION, legalAcceptedAt: now } }),
    );
  });

  it('needs the date of birth, and the version in force', async () => {
    account({});
    await expect(
      service().accept('u1', { version: LEGAL_VERSION }, undefined, now),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'INVALID_BIRTH_DATE' }) });

    await expect(
      service().accept('u1', { version: '2020-01-01', birthDate: '1995-04-20' }, undefined, now),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'LEGAL_VERSION_OUTDATED' }),
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('suspends an account that says it is under 18 - signed out everywhere, as staff would', async () => {
    account({});

    await expect(
      service().accept('u1', { version: LEGAL_VERSION, birthDate: '2010-05-01' }, undefined, now),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'UNDER_AGE' }) });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { status: UserStatus.SUSPENDED, suspendedAt: now, suspensionReason: UNDER_AGE_REASON },
    });
    expect(events.emit).toHaveBeenCalledWith(DomainEvents.UserSuspended, {
      userId: 'u1',
      suspendedBy: 'u1',
      reason: UNDER_AGE_REASON,
    });
    expect(prisma.legalAcceptance.create).not.toHaveBeenCalled();
  });
});

describe('the Terms and Privacy pages', () => {
  it('name who runs Mela, the version, the age, and how to reach us - safely', () => {
    const terms = renderTermsPage({ operator: 'Mela Live PLC', supportEmail: 'help@mela.example' });
    const privacy = renderPrivacyPage({
      operator: 'Mela Live PLC',
      supportEmail: 'help@mela.example',
    });

    for (const html of [terms, privacy]) {
      expect(html).toContain('Mela Live PLC');
      expect(html).toContain(`Version ${LEGAL_VERSION}`);
      expect(html).toContain('18');
      expect(html).toContain('href="mailto:help@mela.example"');
      expect(html).toContain('href="/delete-account"');
    }
    expect(terms).toContain('<h1>Terms of Service</h1>');
    expect(privacy).toContain('<h1>Privacy Policy</h1>');
    expect(renderTermsPage({ operator: '<script>', supportEmail: '"><script>' })).not.toContain(
      '<script>',
    );
  });
});
