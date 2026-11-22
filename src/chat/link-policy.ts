// Link policy (plan §6.3, step 4): raw URLs are a common vector for
// scam/gambling spam, so they're blocked by default - only the platform's own
// domains (CHAT_LINK_DOMAINS) and Mela's own store pages are let through.
// See docs/features/moderation.md.
const URL_PATTERN =
  /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/[^\s]*)?\b/gi;

const PLAY_STORE_HOST = 'play.google.com';
const PLAY_STORE_LISTING = '/store/apps/details';

/** What may be linked to: Mela's domains, and Mela's own app on the stores. */
export interface AllowedLinks {
  // Bare lowercase hosts; their subdomains pass too.
  domains: readonly string[];
  // Play's listing of this app (`play.google.com/store/apps/details?id=<package>`).
  androidPackage?: string | null;
  // Exact pages, whatever their query: the configured install links.
  pages?: readonly string[];
}

/** CHAT_LINK_DOMAINS ("mela.example, share.mela.example") as bare lowercase hosts. */
export function parseLinkDomains(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The allowed links from the API's settings: CHAT_LINK_DOMAINS, plus the
 * app's own store pages - Play's listing of ANDROID_APP_PACKAGE_NAME, and
 * ANDROID_INSTALL_URL / IOS_INSTALL_URL - so people can share where to get Mela.
 */
export function allowedLinksFrom(setting: (key: string) => string | undefined): AllowedLinks {
  return {
    domains: parseLinkDomains(setting('CHAT_LINK_DOMAINS')),
    androidPackage: setting('ANDROID_APP_PACKAGE_NAME')?.trim() || null,
    pages: [setting('ANDROID_INSTALL_URL'), setting('IOS_INSTALL_URL')]
      .map((page) => page?.trim())
      .filter((page): page is string => Boolean(page)),
  };
}

function urlOf(candidate: string): URL | null {
  try {
    return new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
  } catch {
    return null;
  }
}

function samePage(url: URL, page: string): boolean {
  const target = urlOf(page);
  return (
    target !== null &&
    url.hostname.toLowerCase() === target.hostname.toLowerCase() &&
    url.pathname.replace(/\/+$/, '') === target.pathname.replace(/\/+$/, '')
  );
}

function isAllowed(url: URL, allowed: AllowedLinks): boolean {
  const host = url.hostname.toLowerCase();
  if (allowed.domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    return true;
  }
  if (
    allowed.androidPackage &&
    host === PLAY_STORE_HOST &&
    url.pathname.replace(/\/+$/, '') === PLAY_STORE_LISTING &&
    url.searchParams.get('id') === allowed.androidPackage
  ) {
    return true;
  }
  return (allowed.pages ?? []).some((page) => samePage(url, page));
}

/** True if `text` contains a URL that isn't `allowed` (a list is just domains). */
export function hasDisallowedLink(
  text: string,
  allowed: AllowedLinks | readonly string[],
): boolean {
  const matches = text.match(URL_PATTERN);
  if (!matches) return false;
  const links: AllowedLinks = Array.isArray(allowed)
    ? { domains: allowed as readonly string[] }
    : (allowed as AllowedLinks);
  return matches.some((match) => {
    const url = urlOf(match);
    return !url || !isAllowed(url, links);
  });
}
