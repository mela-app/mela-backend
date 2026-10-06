import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { identityFromFirebaseClaims } from './verified-identity';
import { usernameCandidates } from './usernames';

describe('identityFromFirebaseClaims', () => {
  const google = (overrides: Record<string, unknown> = {}) => ({
    email: ' Abebe.K@Gmail.com ',
    email_verified: true,
    name: ' Abebe Kebede ',
    firebase: { sign_in_provider: 'google.com', identities: { 'google.com': ['1098765'] } },
    ...overrides,
  });

  it("reads a Google account: Google's own id, and the email it vouched for", () => {
    expect(identityFromFirebaseClaims(google())).toEqual({
      method: 'google',
      subject: '1098765',
      email: 'abebe.k@gmail.com',
      name: 'Abebe Kebede',
    });
    expect(identityFromFirebaseClaims(google({ name: '  ' }))).toMatchObject({ name: null });
  });

  it("won't take a Google token missing its account id or a verified email", () => {
    expect(() =>
      identityFromFirebaseClaims(google({ firebase: { sign_in_provider: 'google.com' } })),
    ).toThrow(BadRequestException);
    expect(() => identityFromFirebaseClaims(google({ email_verified: false }))).toThrow(
      BadRequestException,
    );
  });

  it('takes an email and password only once its owner tapped the emailed link', () => {
    const password = { email: 'Ana@Example.com', firebase: { sign_in_provider: 'password' } };
    expect(identityFromFirebaseClaims({ ...password, email_verified: true })).toEqual({
      method: 'email',
      email: 'ana@example.com',
    });
    expect(() => identityFromFirebaseClaims({ ...password, email_verified: false })).toThrow(
      ForbiddenException,
    );
  });

  it('turns away ways of signing in that are not supported yet', () => {
    for (const provider of ['phone', 'anonymous', 'custom']) {
      expect(() =>
        identityFromFirebaseClaims({
          phone_number: '+251911000000',
          firebase: { sign_in_provider: provider },
        } as never),
      ).toThrow(BadRequestException);
    }
  });
});

describe('usernameCandidates', () => {
  const fixed = () => 0.4271;

  it('starts from their name, then the same with a few digits', () => {
    expect(usernameCandidates(['Abebe Kebede', 'ak99'], 0, fixed)).toEqual([
      'abebe_kebede',
      'abebe_kebede_42',
      'abebe_kebede_42',
      'abebe_kebede_42',
      'abebe_kebede_42',
    ]);
    expect(usernameCandidates(['Abebe Kebede'], 1, fixed)).toEqual(
      Array(4).fill('abebe_kebede_427'),
    );
  });

  it("falls back to the email's name when theirs has no usable letters", () => {
    expect(usernameCandidates(['አበበ', 'abebe.k99'], 0, fixed)[0]).toBe('abebe_k99');
    expect(usernameCandidates(['😀', '..'], 0, fixed)[0]).toBe('mela');
  });

  it('always fits the username rule', () => {
    const long = 'Bartholomew Maximilian Montgomery-Smythe';
    for (let round = 0; round < 3; round++) {
      for (const candidate of usernameCandidates([long], round)) {
        expect(candidate).toMatch(/^[a-z0-9_]{3,24}$/);
      }
    }
  });
});
