/** major.minor.patch, as people see it - 1.2.0. */
export const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/** Below zero when [a] is older than [b]; both match VERSION_PATTERN. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let part = 0; part < 3; part++) {
    const difference = (left[part] ?? 0) - (right[part] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const THIS_MACHINE = new Set(['localhost', '127.0.0.1']);

/**
 * Why phones shouldn't download the update from [url], or null when they
 * can: an https link, or plain http to this machine while developing.
 */
export function downloadUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Give a full link, starting with https://';
  }
  if (parsed.protocol === 'https:') return null;
  if (parsed.protocol === 'http:' && THIS_MACHINE.has(parsed.hostname)) return null;
  return 'Use an https:// link, so nobody can swap the download on its way to the phone';
}
