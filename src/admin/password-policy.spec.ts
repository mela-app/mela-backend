import {
  adminPasswordProblem,
  generateTemporaryPassword,
  MIN_ADMIN_PASSWORD_LENGTH,
} from './password-policy';

describe('admin password policy', () => {
  it('accepts a long password with letters and numbers', () => {
    expect(adminPasswordProblem('correct horse 42 battery', 'ana@example.com')).toBeNull();
  });

  it(`asks for at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`, () => {
    expect(adminPasswordProblem('short12', 'ana@example.com')).toBe(
      `Use at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`,
    );
  });

  it('asks for both letters and numbers', () => {
    expect(adminPasswordProblem('onlyletterslonger', 'ana@example.com')).toBe(
      'Use both letters and numbers',
    );
    expect(adminPasswordProblem('1234567890123', 'ana@example.com')).toBe(
      'Use both letters and numbers',
    );
  });

  it('refuses a password built on the email address', () => {
    expect(adminPasswordProblem('Abebekebede2026', 'abebekebede@example.com')).toMatch(/email/);
  });

  it('makes temporary passwords that are easy to read out and pass the policy', () => {
    for (let i = 0; i < 50; i++) {
      const password = generateTemporaryPassword();
      expect(password).toHaveLength(16);
      expect(password).not.toMatch(/[0O1lI]/);
      expect(adminPasswordProblem(password, 'staff@example.com')).toBeNull();
    }
  });
});
