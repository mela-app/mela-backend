export interface PushMessage {
  title: string;
  body: string;
  /** Delivered alongside the notification, e.g. `{streamId}` - lets a tap route without a fetch. */
  data?: Record<string, string>;
}

/**
 * Everything the rest of the app knows about a push vendor. No module
 * outside common/push should import a vendor SDK directly - mirrors
 * common/video-provider's VideoProvider abstraction. See docs/features/notifications.md.
 */
export interface PushProvider {
  /**
   * Best-effort: a provider swallows and logs its own delivery failures
   * rather than throwing, so one bad token never fails a whole fan-out.
   * Returns the tokens the vendor reported as permanently invalid (uninstalled,
   * revoked), so the caller can prune them from `user_sessions`.
   */
  send(tokens: string[], message: PushMessage): Promise<{ invalidTokens: string[] }>;
}

export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');
