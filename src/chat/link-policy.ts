// Link policy (plan §6.3, step 4): raw URLs are a common vector for
// scam/gambling spam, so they're blocked by default - only the platform's own
// domains (CHAT_LINK_DOMAINS) are let through. See docs/features/moderation.md.
const URL_PATTERN =
  /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/[^\s]*)?\b/gi;

/** CHAT_LINK_DOMAINS ("mela.example, share.mela.example") as bare lowercase hosts. */
export function parseLinkDomains(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

function hostOf(candidate: string): string | null {
  try {
    const withScheme = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isAllowed(host: string, allowed: readonly string[]): boolean {
  return allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** True if `text` contains a URL whose domain isn't `allowed` (or a subdomain of one). */
export function hasDisallowedLink(text: string, allowed: readonly string[]): boolean {
  const matches = text.match(URL_PATTERN);
  if (!matches) return false;
  return matches.some((match) => {
    const host = hostOf(match);
    return !host || !isAllowed(host, allowed);
  });
}
