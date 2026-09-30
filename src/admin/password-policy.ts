import { randomInt } from 'crypto';

// Staff accounts guard every user's data, so the bar is higher than the app's.
export const MIN_ADMIN_PASSWORD_LENGTH = 12;

/** Why [password] isn't acceptable for this account, or null. */
export function adminPasswordProblem(password: string, email: string): string | null {
  if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > 128) return 'Use at most 128 characters';
  if (!/\p{L}/u.test(password) || !/\d/.test(password)) return 'Use both letters and numbers';
  const localPart = email.split('@')[0]?.toLowerCase() ?? '';
  if (localPart.length >= 4 && password.toLowerCase().includes(localPart)) {
    return "Don't use your email address in your password";
  }
  return null;
}

// No look-alikes (0/O, 1/l/I), so it can be read out or retyped safely.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A one-time password for a new staff account - they must replace it at first sign-in. */
export function generateTemporaryPassword(length = 16): string {
  for (;;) {
    const password = Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    if (/\d/.test(password) && /[a-z]/i.test(password)) return password;
  }
}
