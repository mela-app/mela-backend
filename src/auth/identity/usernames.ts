/** Every username's shape; the app and the web player check it too. */
export const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,24}$/;
export const USERNAME_RULE = 'Use 3-24 letters, numbers or underscores';

const MAX_LENGTH = 24;

/**
 * Usernames to offer someone new, best first: from the first of [seeds]
 * (their name, then their email's local part) that leaves at least 3
 * characters, alone and then with random digits - more digits each round.
 */
export function usernameCandidates(
  seeds: readonly string[],
  round: number,
  random: () => number = Math.random,
): string[] {
  const base = seeds.map(usernameBase).find((candidate) => candidate.length >= 3) ?? 'mela';
  const digits = round + 2;
  const stem = base.slice(0, MAX_LENGTH - digits - 1);
  const numbered = Array.from(
    { length: 4 },
    () =>
      `${stem}_${Math.floor(random() * 10 ** digits)
        .toString()
        .padStart(digits, '0')}`,
  );
  return round === 0 ? [base, ...numbered] : numbered;
}

// "Abebe Kebede" -> "abebe_kebede"; letters outside a-z (Amharic, emoji) drop out.
function usernameBase(seed: string): string {
  return seed
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_LENGTH)
    .replace(/_+$/, '');
}
