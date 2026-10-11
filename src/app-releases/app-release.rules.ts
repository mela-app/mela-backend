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
