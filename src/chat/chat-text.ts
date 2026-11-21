export const CHAT_MAX_LENGTH = 200;
// Live chat stays a stream of short messages: a sixth line joins the fifth.
export const CHAT_MAX_LINES = 5;

// Control characters, plus the bidi overrides that can make text display as something else (Trojan Source).
const HIDDEN_CONTROLS =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩]/g;
const LINE_BREAKS = /\r\n?/g;
// Any whitespace but a line break: spaces, tabs, Unicode spaces.
const SPACE_RUNS = /[^\S\n]+/g;
const SPACES_AROUND_BREAKS = / ?\n ?/g;
// At most one empty line in a row.
const BLANK_LINES = /\n{3,}/g;
// "!!!!!!!!!!!!" and emoji walls: at most 5 of the same character in a row.
const FLOODS = /(.)\1{5,}/gu;

export type ChatTextError = 'MESSAGE_EMPTY' | 'MESSAGE_TOO_LONG';

/**
 * The first step of the chat pipeline (plan §6.3): tidy text, or why there's
 * none. Line breaks stay (the app's Enter key) - at most one empty line in a
 * row and [maxLines] lines, the rest joined onto the last. Direct messages
 * allow longer ones than live chat.
 */
export function cleanChatText(
  raw: string,
  maxLength = CHAT_MAX_LENGTH,
  maxLines = CHAT_MAX_LINES,
): { text: string } | { error: ChatTextError } {
  let text = raw
    .normalize('NFC')
    .replace(LINE_BREAKS, '\n')
    .replace(HIDDEN_CONTROLS, '')
    .replace(SPACE_RUNS, ' ')
    .replace(SPACES_AROUND_BREAKS, '\n')
    .replace(BLANK_LINES, '\n\n')
    .replace(FLOODS, (_run, char: string) => char.repeat(5))
    .trim();
  const lines = text.split('\n');
  if (lines.length > maxLines) {
    const rest = lines.slice(maxLines - 1).filter((line) => line.length > 0);
    text = [...lines.slice(0, maxLines - 1), rest.join(' ')].join('\n');
  }
  if (text.length === 0) return { error: 'MESSAGE_EMPTY' };
  // Code points, so an emoji counts once, not as two UTF-16 halves.
  if ([...text].length > maxLength) return { error: 'MESSAGE_TOO_LONG' };
  return { text };
}
