import { randomUUID } from 'crypto';

/** What staff upload: the AR engine's effect files, and pictures. */
export const CAMERA_EFFECT_UPLOADS = {
  'application/octet-stream': 'deepar',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;
export type CameraEffectUploadType = keyof typeof CAMERA_EFFECT_UPLOADS;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY = new RegExp(`^camera-effects/${UUID}\\.(deepar|jpg|png|webp)$`);

/** Where a new upload goes - one fresh key each. */
export function cameraEffectKey(contentType: CameraEffectUploadType): string {
  return `camera-effects/${randomUUID()}.${CAMERA_EFFECT_UPLOADS[contentType]}`;
}

/** Only keys handed out for camera effects - never another object in the bucket. */
export function isCameraEffectKey(key: string, kind: 'file' | 'image'): boolean {
  if (!KEY.test(key)) return false;
  return kind === 'file' ? key.endsWith('.deepar') : !key.endsWith('.deepar');
}

/** "New" in the app's Effects panel: published this recently. */
export const NEW_FOR_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * One Beautify slider driving the beauty rig (docs/features/camera-effects.md):
 * the app's slider goes 0 to 1, the rig's parameter [from] to [to] - e.g. a
 * blend shape's weight 0 to 100 on the rig's MeshRenderer.
 */
export interface BeautyControl {
  // Stable id: what the app remembers the host's setting by.
  key: string;
  label: string;
  // Which group of the Beauty tab it's in.
  group: 'FACE' | 'EYES' | 'NOSE' | 'MOUTH';
  gameObject: string;
  component: string;
  parameter: string;
  from: number;
  to: number;
}

const GROUPS = ['FACE', 'EYES', 'NOSE', 'MOUTH'] as const;

/** [value] as rig controls, or a reason it can't be. */
export function parseBeautyControls(
  value: unknown,
): { controls: BeautyControl[] } | { error: string } {
  if (!Array.isArray(value)) return { error: 'Controls must be a list' };
  if (value.length > 30) return { error: 'At most 30 controls' };
  const controls: BeautyControl[] = [];
  const keys = new Set<string>();
  for (const [index, item] of value.entries()) {
    const at = `Control ${index + 1}`;
    if (typeof item !== 'object' || item === null) return { error: `${at} must be an object` };
    const raw = item as Record<string, unknown>;
    const text = (name: string, max = 80) =>
      typeof raw[name] === 'string' &&
      (raw[name] as string).trim().length > 0 &&
      (raw[name] as string).length <= max
        ? (raw[name] as string).trim()
        : null;
    const key = text('key', 40);
    const label = text('label', 30);
    const gameObject = text('gameObject');
    const component = text('component');
    const parameter = text('parameter');
    const group = GROUPS.find((each) => each === raw.group);
    const from = typeof raw.from === 'number' && Number.isFinite(raw.from) ? raw.from : 0;
    const to = typeof raw.to === 'number' && Number.isFinite(raw.to) ? raw.to : null;
    if (!key || !/^[a-z][a-z0-9_]*$/.test(key))
      return { error: `${at}: key must be like eye_size` };
    if (keys.has(key)) return { error: `${at}: key ${key} is used twice` };
    if (!label) return { error: `${at}: give it a label` };
    if (!group) return { error: `${at}: group must be one of ${GROUPS.join(', ')}` };
    if (!gameObject || !component || !parameter) {
      return { error: `${at}: gameObject, component and parameter are needed` };
    }
    if (to === null) return { error: `${at}: "to" must be a number` };
    keys.add(key);
    controls.push({ key, label, group, gameObject, component, parameter, from, to });
  }
  return { controls };
}
