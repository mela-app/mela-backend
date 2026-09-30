/** Someone a chat message mentions, as `@username` in its text. */
export interface ChatMention {
  id: string;
  username: string;
}

/** Finds the account a typed `@name` means, if any. */
export type MentionLookup = (username: string) => ChatMention | undefined;

/** Past this, further `@names` in one message are plain text. */
export const MAX_MENTIONS_PER_MESSAGE = 10;

// Usernames are letters, digits and underscores; not glued to a word before it, so an email isn't one.
const MENTION = /(?<![A-Za-z0-9_@])@([A-Za-z0-9_]{1,30})/g;

/** The usernames [text] mentions, in order, each once (case-insensitively). */
export function mentionedUsernames(text: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const match of text.matchAll(MENTION)) {
    const key = match[1].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(match[1]);
    if (names.length === MAX_MENTIONS_PER_MESSAGE) break;
  }
  return names;
}

/** Case-insensitive, but an exact match wins where two usernames differ only in case. */
export function mentionLookup(accounts: readonly ChatMention[]): MentionLookup {
  const exact = new Map(accounts.map((account) => [account.username, account]));
  const folded = new Map<string, ChatMention>();
  for (const account of accounts) {
    const key = account.username.toLowerCase();
    if (!folded.has(key)) folded.set(key, account);
  }
  return (name) => exact.get(name) ?? folded.get(name.toLowerCase());
}

/** The accounts [text] mentions, in order, each once. */
export function resolveMentions(text: string, lookup: MentionLookup): ChatMention[] {
  const found = new Map<string, ChatMention>();
  for (const name of mentionedUsernames(text)) {
    const mention = lookup(name);
    if (mention && !found.has(mention.id)) found.set(mention.id, mention);
  }
  return [...found.values()];
}
