import { randomUUID } from 'crypto';

/** The photo types the host may post; the file extension follows the type. */
export const CHAT_IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png' } as const;
export type ChatImageType = keyof typeof CHAT_IMAGE_TYPES;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Where a new photo for this live's chat is stored - one fresh key per upload. */
export function chatImageKey(streamId: string, contentType: ChatImageType): string {
  return `chat-images/${streamId}/${randomUUID()}.${CHAT_IMAGE_TYPES[contentType]}`;
}

/**
 * Only keys this API handed out for this live pass: a message can't point at
 * another live's photo, another object in the bucket, or anywhere else.
 */
export function isChatImageKey(key: string, streamId: string): boolean {
  const prefix = `chat-images/${streamId}/`;
  return (
    key.startsWith(prefix) && new RegExp(`^${UUID}\\.(jpg|png)$`).test(key.slice(prefix.length))
  );
}

/** One line for where only text fits (the pinned banner): a photo reads as one. */
export function chatPreviewText(text: string, imageUrl: string | null): string {
  if (!imageUrl) return text;
  return text ? `📷 ${text}` : '📷 Photo';
}
