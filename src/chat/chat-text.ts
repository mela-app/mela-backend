export const CHAT_MAX_LENGTH = 200;

// Control characters, plus the bidi overrides that can make text display as something else (Trojan Source).
const HIDDEN_CONTROLS =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;
const WHITESPACE_RUNS = /\s+/g;
// "!!!!!!!!!!!!" and emoji walls: at most 5 of the same character in a row.
const FLOODS = /(.)\1{5,}/gu;

export type ChatTextError = 'MESSAGE_EMPTY' | 'MESSAGE_TOO_LONG';

/**
 * The first step of the chat pipeline (plan §6.3): one tidy line of text, or
 * why there's none. Direct messages allow longer ones than live chat.
 */
export function cleanChatText(
  raw: string,
  maxLength = CHAT_MAX_LENGTH,
): { text: string } | { error: ChatTextError } {
  const text = raw
    .normalize('NFC')
    .replace(HIDDEN_CONTROLS, '')
    .replace(WHITESPACE_RUNS, ' ')
    .replace(FLOODS, (_run, char: string) => char.repeat(5))
    .trim();
  if (text.length === 0) return { error: 'MESSAGE_EMPTY' };
  // Code points, so an emoji counts once, not as two UTF-16 halves.
  if ([...text].length > maxLength) return { error: 'MESSAGE_TOO_LONG' };
  return { text };
}
