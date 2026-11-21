import { randomUUID } from 'crypto';
import { CHAT_IMAGE_TYPES, ChatImageType } from '../chat/chat-images';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * Where a photo [senderId] is about to send privately is stored - one fresh,
 * unguessable key per upload (the same JPEG/PNG types as live chat photos).
 */
export function directMessageImageKey(senderId: string, contentType: ChatImageType): string {
  return `dm-images/${senderId}/${randomUUID()}.${CHAT_IMAGE_TYPES[contentType]}`;
}

/**
 * Only keys this API handed out to [senderId] pass: a message can't point at
 * someone else's upload, a live's photo, or anywhere else.
 */
export function isDirectMessageImageKey(key: string, senderId: string): boolean {
  const prefix = `dm-images/${senderId}/`;
  return (
    key.startsWith(prefix) && new RegExp(`^${UUID}\\.(jpg|png)$`).test(key.slice(prefix.length))
  );
}

/** A message as one line (a push, the inbox): a photo reads as one. */
export function directMessagePreview(text: string, imageUrl: string | null): string {
  if (!imageUrl) return text;
  return text ? `📷 ${text}` : '📷 Photo';
}
