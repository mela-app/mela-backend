import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';

/**
 * The Terms of Service and Privacy Policy in force (`/terms`, `/privacy`),
 * accepted together. Bump it - the date they take effect - whenever either
 * changes in a way people must agree to again: everyone is asked once more
 * in the app (`GET /v1/me/legal`). See docs/features/legal.md.
 */
export const LEGAL_VERSION = '2026-10-12';

/** Where the documents are, on the same host as the app's links (`/live/...`). */
export const LEGAL_PATHS = { terms: '/terms', privacy: '/privacy' } as const;

/** Mela is for adults only (Google Play: an 18+ app with a neutral age screen). */
export const MINIMUM_AGE = 18;

/** Why an account that said it's under 18 was suspended - staff see it, and may reinstate. */
export const UNDER_AGE_REASON = 'Under 18 - said so at the age check';

const BIRTH_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A real calendar date (YYYY-MM-DD) from 1900 to [today], at UTC midnight;
 * null otherwise - e.g. 2001-02-30, or a date still to come.
 */
export function parseBirthDate(value: string, today: Date = new Date()): Date | null {
  const match = BIRTH_DATE.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const real =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  if (!real || year < 1900 || date.getTime() > today.getTime()) return null;
  return date;
}

/** Whole years from [birthDate] to [today] (UTC) - 18 from the 18th birthday on. */
export function ageOn(birthDate: Date, today: Date): number {
  let age = today.getUTCFullYear() - birthDate.getUTCFullYear();
  const birthdayPassed =
    today.getUTCMonth() > birthDate.getUTCMonth() ||
    (today.getUTCMonth() === birthDate.getUTCMonth() &&
      today.getUTCDate() >= birthDate.getUTCDate());
  if (!birthdayPassed) age -= 1;
  return age;
}

export function underAge(): ForbiddenException {
  return new ForbiddenException({
    message: `Mela is only for people ${MINIMUM_AGE} or older.`,
    code: 'UNDER_AGE',
  });
}

/**
 * What someone signing up agreed to and said about their age, checked:
 * the documents in force, and a birth date at least [MINIMUM_AGE] years ago.
 * An app from before the age check sends neither: it's told to update.
 */
export function checkNewAccountLegal(
  input: { birthDate?: string; acceptedLegalVersion?: string },
  now: Date = new Date(),
): { birthDate: Date; version: string } {
  if (input.birthDate === undefined || input.acceptedLegalVersion === undefined) {
    throw new BadRequestException({
      message: 'Update Mela to sign up.',
      code: 'APP_UPDATE_REQUIRED',
    });
  }
  const version = checkVersion(input.acceptedLegalVersion);
  const birthDate = checkBirthDate(input.birthDate, now);
  return { birthDate, version };
}

/** The version accepted must be the one in force - documents shown before a change aren't enough. */
export function checkVersion(accepted: string): string {
  if (accepted !== LEGAL_VERSION) {
    throw new ConflictException({
      message: 'Our Terms or Privacy Policy just changed. Please read and accept them again.',
      code: 'LEGAL_VERSION_OUTDATED',
      version: LEGAL_VERSION,
    });
  }
  return accepted;
}

/** A real date of birth, of someone old enough. */
export function checkBirthDate(value: string, now: Date): Date {
  const birthDate = parseBirthDate(value, now);
  if (!birthDate) {
    throw new BadRequestException({
      message: 'Enter your date of birth.',
      code: 'INVALID_BIRTH_DATE',
    });
  }
  if (ageOn(birthDate, now) < MINIMUM_AGE) throw underAge();
  return birthDate;
}
