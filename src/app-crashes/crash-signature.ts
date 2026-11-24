import { createHash } from 'crypto';
import { AppCrashKind } from '@prisma/client';

// What differs between phones for the same crash: addresses, ids, numbers, quoted values.
const NOISE: Array<[RegExp, string]> = [
  [/0x[0-9a-f]+/gi, '#'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '#'],
  [/\d+/g, '#'],
  [/'[^']*'|"[^"]*"/g, "'…'"],
  [/\s+/g, ' '],
];

function normalized(text: string): string {
  return NOISE.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text)
    .trim()
    .slice(0, 300);
}

// The first lines that say where: Dart frames (#0 ... (package:...)), Java frames (at ...), native (#00 pc ...).
function topFrames(stack: string | null | undefined, count = 4): string[] {
  if (!stack) return [];
  return stack
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) => /^(#\d+|at\s)/.test(line) || line.includes('package:') || line.includes('.so'),
    )
    .slice(0, count)
    .map(normalized);
}

/**
 * One crash, the same on every phone (docs/features/app-crashes.md): its
 * kind, its message and the top of its stack, without what varies from phone
 * to phone - so the console counts how often each one happens.
 */
export function crashSignature(
  kind: AppCrashKind,
  message: string,
  stack: string | null | undefined,
): string {
  const parts = [kind, normalized(message), ...topFrames(stack)];
  return createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 16);
}
