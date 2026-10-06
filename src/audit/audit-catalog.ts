import { AuditCategory } from '@prisma/client';

/**
 * Every action the audit trail records, grouped for filtering. Adding one
 * here (and recording it) needs no migration - `action` is plain text.
 */
export const AUDIT_ACTIONS = {
  'auth.signed_up': { category: 'AUTH', label: 'Created an account' },
  'auth.signed_in': { category: 'AUTH', label: 'Signed in to the app' },
  'auth.signed_out': { category: 'AUTH', label: 'Signed out of the app' },
  'admin.signed_in': { category: 'AUTH', label: 'Signed in to the admin console' },
  'admin.sign_in_failed': { category: 'AUTH', label: 'Failed admin console sign-in' },
  'admin.signed_out': { category: 'AUTH', label: 'Signed out of the admin console' },

  'account.profile_updated': { category: 'ACCOUNT', label: 'Updated their profile' },
  'account.password_changed': { category: 'ACCOUNT', label: 'Changed their password' },
  'account.password_added': { category: 'ACCOUNT', label: 'Added a password' },
  'account.email_changed': { category: 'ACCOUNT', label: 'Changed their email' },
  'account.identity_linked': { category: 'ACCOUNT', label: 'Linked a sign-in method' },

  'user.suspended': { category: 'ADMIN', label: 'Suspended an account' },
  'user.reinstated': { category: 'ADMIN', label: 'Reinstated an account' },
  'user.role_changed': { category: 'ADMIN', label: 'Changed a platform role' },
  'user.permissions_changed': { category: 'ADMIN', label: "Changed a moderator's access" },
  'user.profile_edited': { category: 'ADMIN', label: "Edited a user's profile" },
  'user.sessions_revoked': { category: 'ADMIN', label: 'Signed a user out everywhere' },
  'admin.staff_created': { category: 'ADMIN', label: 'Created a staff account' },
  'admin.seeded': { category: 'ADMIN', label: 'Created the default super admin' },
  'admin.audit_exported': { category: 'ADMIN', label: 'Exported the audit log' },
  'admin.private_messages_viewed': { category: 'ADMIN', label: 'Read private messages' },

  'stream.started': { category: 'STREAM', label: 'Went live' },
  'stream.ended': { category: 'STREAM', label: 'Live ended' },
  'stream.layout_changed': { category: 'STREAM', label: 'Changed the live layout' },
  'stream.shared': { category: 'STREAM', label: 'Invited friends to a live' },
  'stream.locked': { category: 'STREAM', label: 'Locked a live' },
  'stream.unlocked': { category: 'STREAM', label: 'Unlocked a live' },

  'chat.message_deleted': { category: 'CHAT', label: 'Deleted a chat message' },
  'chat.message_pinned': { category: 'CHAT', label: 'Pinned a chat message' },
  'chat.message_unpinned': { category: 'CHAT', label: 'Unpinned a chat message' },

  'moderation.user_banned': { category: 'MODERATION', label: 'Banned someone from a live' },
  'moderation.ban_lifted': { category: 'MODERATION', label: 'Lifted a live ban' },
  'moderation.chat_muted': { category: 'MODERATION', label: 'Muted someone in chat' },
  'moderation.chat_unmuted': { category: 'MODERATION', label: 'Unmuted someone in chat' },
  'moderation.moderator_added': { category: 'MODERATION', label: 'Added a moderator' },
  'moderation.moderator_updated': {
    category: 'MODERATION',
    label: "Changed a moderator's abilities",
  },
  'moderation.moderator_removed': { category: 'MODERATION', label: 'Removed a moderator' },
  'moderation.guest_mic_locked': { category: 'MODERATION', label: "Turned off a guest's mic" },
  'moderation.guest_mic_unlocked': { category: 'MODERATION', label: "Allowed a guest's mic again" },

  'guest.requested': { category: 'GUEST', label: 'Asked to join the stage' },
  'guest.invited': { category: 'GUEST', label: 'Invited someone on stage' },
  'guest.joined': { category: 'GUEST', label: 'Joined the stage' },
  'guest.left': { category: 'GUEST', label: 'Left the stage' },
  'guest.removed': { category: 'GUEST', label: 'Removed a guest from the stage' },

  'social.followed': { category: 'SOCIAL', label: 'Followed someone' },
  'social.unfollowed': { category: 'SOCIAL', label: 'Unfollowed someone' },
  'social.blocked': { category: 'SOCIAL', label: 'Blocked someone' },
  'social.unblocked': { category: 'SOCIAL', label: 'Unblocked someone' },

  'alert.sent': { category: 'ALERT', label: 'Sent an in-app alert' },

  'phrase.added': { category: 'SETTINGS', label: 'Added a banned phrase' },
  'phrase.updated': { category: 'SETTINGS', label: 'Changed a banned phrase' },
  'phrase.removed': { category: 'SETTINGS', label: 'Removed a banned phrase' },

  'app.release_published': { category: 'SETTINGS', label: 'Published an app update' },
  'app.release_updated': { category: 'SETTINGS', label: 'Changed an app update' },
  'app.release_withdrawn': { category: 'SETTINGS', label: 'Withdrew an app update' },
} as const satisfies Record<string, { category: AuditCategory; label: string }>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

export const AUDIT_CATEGORY_LABELS: Record<AuditCategory, string> = {
  AUTH: 'Sign-in',
  ACCOUNT: 'Account',
  ADMIN: 'User management',
  STREAM: 'Lives',
  CHAT: 'Chat',
  MODERATION: 'Moderation',
  GUEST: 'Guests',
  SOCIAL: 'Social',
  ALERT: 'Alerts',
  SETTINGS: 'Settings',
};

export type AuditTargetType =
  'USER' | 'STREAM' | 'MESSAGE' | 'ALERT' | 'PHRASE' | 'CONVERSATION' | 'APP_RELEASE';

export function isAuditAction(value: string): value is AuditAction {
  return Object.prototype.hasOwnProperty.call(AUDIT_ACTIONS, value);
}
