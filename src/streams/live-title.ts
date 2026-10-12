/**
 * Lives have no title of their own any more (client request, 2026-10): the
 * app no longer asks for one, nor for a game type. A live started from a
 * scheduled live keeps that one's title; any other has an empty title, and
 * reads as its host's ("Abebe's live").
 */
export function liveLabel(
  title: string | null | undefined,
  hostName: string | null | undefined,
): string {
  const trimmed = title?.trim();
  if (trimmed) return trimmed;
  return hostName ? `${hostName}'s live` : 'A live';
}

/** ": <title>" after a sentence about a live, or nothing for an untitled one. */
export function titleSuffix(title: string | null | undefined): string {
  const trimmed = title?.trim();
  return trimmed ? `: ${trimmed}` : '';
}
