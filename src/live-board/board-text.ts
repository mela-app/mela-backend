/** At most this many characters (an emoji counts once) on the board. */
export const BOARD_MAX_LENGTH = 120;

/** At most this many lines. */
export const BOARD_MAX_LINES = 4;

// Control characters, plus the bidi overrides that can make text display as something else.
const HIDDEN_CONTROLS =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩]/g;
const SPACE_RUNS = /[^\S\n]+/g;
// "!!!!!!!!!!!!" and emoji walls: at most 5 of the same character in a row.
const FLOODS = /(.)\1{5,}/gu;

export type BoardTextError = 'BOARD_EMPTY' | 'BOARD_TOO_LONG';

/**
 * Tidy board text: a few short lines - spaces within a line collapsed,
 * blank lines dropped - or why there's none. Like live chat's, but lines
 * are kept: a board reads as a small sign ("Bingo at 8 · Round 3").
 */
export function cleanBoardText(raw: string): { text: string } | { error: BoardTextError } {
  const lines = raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(HIDDEN_CONTROLS, '')
    .replace(FLOODS, (_run, char: string) => char.repeat(5))
    .split('\n')
    .map((line) => line.replace(SPACE_RUNS, ' ').trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return { error: 'BOARD_EMPTY' };
  const text = lines.join('\n');
  if (lines.length > BOARD_MAX_LINES || [...text].length > BOARD_MAX_LENGTH) {
    return { error: 'BOARD_TOO_LONG' };
  }
  return { text };
}

/** A position on the stage, 0 to 1 across and down. */
export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}
