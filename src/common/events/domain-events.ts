import type {
  AdminPermission,
  AlertScope,
  AlertSeverity,
  AppPlatform,
  BannedPhraseSeverity,
  GuestRequestInitiator,
  IdentityProvider,
  ModeratorCapability,
  NotificationType,
  PlatformRole,
  RoomBanScope,
  SessionPlatform,
  StreamEndReason,
  StreamLayout,
  VideoProviderKind,
} from '@prisma/client';

/**
 * Internal, in-process domain event names + payload contracts, carried by
 * @nestjs/event-emitter (registered globally via EventEmitterModule.forRoot()
 * in app.module.ts). Additive-only: never repurpose an existing event's
 * payload shape - add a new event instead. See docs/features/events.md.
 */
export const DomainEvents = {
  UserRegistered: 'user.registered',
  UserSuspended: 'user.suspended',
  UserReinstated: 'user.reinstated',
  UserFollowed: 'user.followed',
  StreamEnded: 'stream.ended',
  StreamLayoutChanged: 'stream.layout_changed',
  // Phase 4: moderation, block & delegated moderators (plan §6.4, §6.9).
  ModeratorGranted: 'moderator.granted',
  ModeratorUpdated: 'moderator.updated',
  ModeratorRevoked: 'moderator.revoked',
  RoomBanCreated: 'room_ban.created',
  ChatMessageDeleted: 'chat_message.deleted',
  ChatMessagePinned: 'chat_message.pinned',
  ChatMessageUnpinned: 'chat_message.unpinned',
  // Phase 5: notifications & sharing (plan §6.11).
  StreamStarted: 'stream.started',
  NotificationCreated: 'notification.created',
  StreamInviteSent: 'stream.invite_sent',
  // Phase 6: guest management (plan §6.5, §6.6).
  GuestRequestCreated: 'guest_request.created',
  GuestRequestAccepted: 'guest_request.accepted',
  GuestRequestRejected: 'guest_request.rejected',
  GuestRequestCancelled: 'guest_request.cancelled',
  GuestJoined: 'guest.joined',
  GuestRemoved: 'guest.removed',
  // Phase 7: mute suite (plan §6.7).
  RoomChatMuteChanged: 'room_chat_mute.changed',
  GuestMicForceMuteChanged: 'guest.mic_force_mute_changed',
  // The host lets a viewer record their live, or takes that back (docs/features/streams.md).
  RecordingPermissionChanged: 'recording_permission.changed',
  // Phase 8: admin console and the audit trail (plan §6.8).
  UserLoggedIn: 'user.logged_in',
  UserLoggedOut: 'user.logged_out',
  UserProfileUpdated: 'user.profile_updated',
  UserBlocked: 'user.blocked',
  UserUnblocked: 'user.unblocked',
  UserRoleChanged: 'user.role_changed',
  UserAdminPermissionsChanged: 'user.admin_permissions_changed',
  UserSessionsRevoked: 'user.sessions_revoked',
  AccountPasswordChanged: 'account.password_changed',
  // The first password of an account made with Google (docs/features/auth.md).
  AccountPasswordAdded: 'account.password_added',
  AccountEmailChanged: 'account.email_changed',
  // Someone proved an existing account's email with Google (docs/features/auth.md).
  AccountIdentityLinked: 'account.identity_linked',
  AdminSignedIn: 'admin.signed_in',
  AdminSignInFailed: 'admin.sign_in_failed',
  AdminSignedOut: 'admin.signed_out',
  StaffAccountCreated: 'admin.staff_created',
  StreamLocked: 'stream.locked',
  StreamUnlocked: 'stream.unlocked',
  RoomBanLifted: 'room_ban.lifted',
  AdminAlertSent: 'admin_alert.sent',
  BannedPhraseCreated: 'banned_phrase.created',
  BannedPhraseUpdated: 'banned_phrase.updated',
  BannedPhraseDeleted: 'banned_phrase.deleted',
  UserUnfollowed: 'user.unfollowed',
  UserProfileModerated: 'user.profile_moderated',
  // Direct messages between friends (docs/features/messages.md).
  DirectMessageSent: 'direct_message.sent',
  DirectMessagesRead: 'direct_message.read',
  // A block between a running live's host and someone in it (plan §6.4).
  LiveAccessRevoked: 'live.access_revoked',
  // A guest's tile was moved or resized on the stage, or put back in line.
  GuestPlacementChanged: 'guest.placement_changed',
  // A guest was put on the full stage (the host in a tile), or the host got it back.
  GuestSpotlightChanged: 'guest.spotlight_changed',
  // An app update was published, changed or withdrawn (docs/features/app-updates.md).
  AppReleaseChanged: 'app_release.changed',
} as const;

export type DomainEventName = (typeof DomainEvents)[keyof typeof DomainEvents];

export interface UserRegisteredPayload {
  userId: string;
  username: string;
  // How the new account's email was proven.
  method?: SignUpMethod;
}

export interface UserSuspendedPayload {
  userId: string;
  suspendedBy: string;
  reason?: string;
}

export interface UserReinstatedPayload {
  userId: string;
  reinstatedBy: string;
}

// Consumed by Phase 5 notifications (per-host go-live fan-out uses followerId lookups, not this).
export interface UserFollowedPayload {
  followerId: string;
  followeeId: string;
}

export interface StreamEndedPayload {
  streamId: string;
  reason: StreamEndReason;
  // Phase 8: why an admin locked it - shown to everyone in the live.
  message?: string;
}

export interface StreamLayoutChangedPayload {
  streamId: string;
  layout: StreamLayout;
}

// Scoped to the one stream a grant was made for (plan §6.9, revised
// 2026-09-26) - hostId is kept for audit context, streamId is what a
// listener actually filters on (LiveRoom on mobile, e.g.).
export interface ModeratorGrantedPayload {
  hostId: string;
  streamId: string;
  userId: string;
  capabilities: ModeratorCapability[];
}

export interface ModeratorUpdatedPayload {
  streamId: string;
  userId: string;
  capabilities: ModeratorCapability[];
}

export interface ModeratorRevokedPayload {
  streamId: string;
  userId: string;
}

export interface RoomBanCreatedPayload {
  hostId: string;
  bannedUserId: string;
  // Null for a HOST_PERMANENT ban (not scoped to any one running live).
  streamId: string | null;
  scope: RoomBanScope;
  // Phase 8: the host or the moderator who banned (audit).
  actorId?: string;
}

export interface RoomBanLiftedPayload {
  hostId: string;
  bannedUserId: string;
  streamId: string | null;
  actorId: string;
}

// Audit attribution (plan §6.9): actorId is who actually acted - the host,
// or the specific moderator - never merged into "the host".
export interface ChatMessageDeletedPayload {
  streamId: string;
  messageId: string;
  actorId: string;
}

export interface ChatMessagePinnedPayload {
  streamId: string;
  messageId: string;
  actorId: string;
  // Included so a client that doesn't already have this message loaded
  // locally (e.g. it was pinned before they joined) can still render the
  // pinned banner without a dedicated fetch.
  text: string;
  senderName: string;
}

export interface ChatMessageUnpinnedPayload {
  streamId: string;
  actorId: string;
}

export interface StreamStartedPayload {
  streamId: string;
  hostId: string;
  title: string;
}

// Already filtered to friends, under the cap, and past the rate limit by
// ShareService by the time this fires - NotificationsService just fans out.
export interface StreamInviteSentPayload {
  streamId: string;
  senderId: string;
  recipientIds: string[];
}

// Emitted once per recipient by NotificationsService, after the row is
// written - RealtimeGateway relays it as `notification:new` (the notification
// itself) and `notification:unread_count` (a +1 delta, not a recomputed
// total - a fresh notification is always unread, and this avoids an extra
// COUNT query per recipient on a fan-out that can reach hundreds of
// followers; `GET /me/notifications/unread-count` stays the source of
// truth a client re-syncs against on open/foreground).
export interface NotificationCreatedPayload {
  recipientId: string;
  notification: {
    id: string;
    type: NotificationType;
    actorId: string | null;
    streamId: string | null;
    createdAt: Date;
    // Hydrated once by the emitter (already fetched for the push text) so a
    // client can render "X is live"/"X started following you" immediately,
    // without a fetch-by-id round trip.
    actor: { id: string; username: string; displayName: string; avatarUrl: string | null } | null;
    streamTitle: string | null;
  };
}

// A brief profile snapshot, hydrated once by the emitter - every guest.*/
// guest_request.* payload below embeds one instead of a bare id, so a
// client can render a name/avatar immediately (same reasoning as
// NotificationCreatedPayload.notification.actor above).
export interface GuestProfileSnapshot {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

// To the host and every active MANAGE_GUEST_REQUESTS moderator's `user:{id}`
// room (plan §6.5, VIEWER-initiated) - or just the invitee's (HOST-initiated).
// The emitter (which already has to look up moderators for the permission
// check) computes `recipientIds` itself, so RealtimeGateway never needs its
// own ModeratorsService dependency just to relay this one event.
export interface GuestRequestCreatedPayload {
  streamId: string;
  requestId: string;
  initiatedBy: GuestRequestInitiator;
  user: GuestProfileSnapshot;
  recipientIds: string[];
}

// Private, to `user.id`'s own room - carries fresh publish credentials so
// their client can start broadcasting immediately, whichever vendor this
// stream is on.
export interface GuestRequestAcceptedPayload {
  streamId: string;
  requestId: string;
  userId: string;
  credentials:
    | {
        provider: typeof VideoProviderKind.AGORA;
        appId: string;
        token: string;
        uid: number;
        expiresAt: Date;
      }
    | { provider: typeof VideoProviderKind.LIVEKIT; url: string; token: string; expiresAt: Date };
}

export interface GuestRequestRejectedPayload {
  streamId: string;
  requestId: string;
  userId: string;
}

// To whichever side did NOT cancel: the host/mods if the VIEWER withdrew
// their own request, or the invitee if the HOST retracted their invite -
// same recipientIds reasoning as GuestRequestCreatedPayload above.
export interface GuestRequestCancelledPayload {
  streamId: string;
  requestId: string;
  initiatedBy: GuestRequestInitiator;
  recipientIds: string[];
}

// Public, to the stream's room - every viewer's UI adds a tile.
export interface GuestJoinedPayload {
  streamId: string;
  user: GuestProfileSnapshot;
  // Agora only (matches VideoCredentials' own uid field) - null on LiveKit,
  // whose participant identity already equals userId.
  agoraUid: number | null;
}

// Public `guest.removed` (to the stream's room, drop the tile) always fires;
// `wasRemovedByHostOrModerator` additionally tells RealtimeGateway whether to
// ALSO privately notify the removed user themselves (`you_were_removed`) -
// a self-initiated leave doesn't need to tell them what they already know.
export interface GuestRemovedPayload {
  streamId: string;
  hostId: string;
  userId: string;
  wasRemovedByHostOrModerator: boolean;
  // Phase 8: who removed them, or the guest themselves for a leave (audit).
  actorId?: string;
}

// Private, to the muted user's own `user:{id}` room only (plan §6.7) - the
// room never learns who is muted. actorId is who acted (audit, plan §6.9).
export interface RoomChatMuteChangedPayload {
  streamId: string;
  userId: string;
  actorId: string;
  muted: boolean;
  // While muted, null means until the live ends; always null once lifted.
  mutedUntil: Date | null;
}

// Public `presence:audio_state` to the stream's room (every tile shows the
// muted mic), plus a private `force_mute_audio` to the guest on mute.
export interface GuestMicForceMuteChangedPayload {
  streamId: string;
  userId: string;
  actorId: string;
  forceMuted: boolean;
}

/** Where a guest's tile sits, as fractions of the stage's guest area (docs/features/guests.md). */
export interface GuestPlacement {
  x: number;
  y: number;
  // The tile's width as a share of the area's; tiles are always 3:4 portrait.
  size: number;
}

// Public `guest:placed` to the stream's room: every stage moves the tile.
export interface GuestPlacementChangedPayload {
  streamId: string;
  userId: string;
  actorId: string;
  // Null: back in the automatic column.
  placement: GuestPlacement | null;
}

// Public `guest:spotlight` to the stream's room: every stage swaps who fills it.
export interface GuestSpotlightChangedPayload {
  streamId: string;
  // Null: the host has the full stage again.
  userId: string | null;
  actorId: string;
}

// Private, to that viewer's own `user:{id}` room: their app lets screen
// recording through for this live, or blocks it again.
export interface RecordingPermissionChangedPayload {
  streamId: string;
  userId: string;
  actorId: string;
  allowed: boolean;
}

// Phase 8 (plan §6.8, §11): what the admin console and the audit trail
// need. Every actor-driven event carries actorId.

export interface UserLoggedInPayload {
  userId: string;
  platform: SessionPlatform;
  method?: 'password' | 'google';
}

export interface UserLoggedOutPayload {
  userId: string;
}

export interface UserProfileUpdatedPayload {
  userId: string;
  fields: string[];
}

export interface UserBlockedPayload {
  blockerId: string;
  blockedId: string;
}

/** [userId] is out of the host's running live: one of them blocked the other. */
export interface LiveAccessRevokedPayload {
  streamId: string;
  hostId: string;
  userId: string;
  // The host blocked them, so they're told they were removed; someone who
  // blocked the host is leaving on their own.
  removedByHost: boolean;
}

export interface UserRoleChangedPayload {
  userId: string;
  actorId: string;
  from: PlatformRole;
  to: PlatformRole;
  // What they may do in the console, when the new role is PLATFORM_MODERATOR.
  permissions?: AdminPermission[];
}

export interface UserAdminPermissionsChangedPayload {
  userId: string;
  actorId: string;
  from: AdminPermission[];
  to: AdminPermission[];
}

// Every device of this user is signed out and disconnected.
export interface UserSessionsRevokedPayload {
  userId: string;
  actorId: string;
}

export interface AccountCredentialChangedPayload {
  userId: string;
}

export interface AccountPasswordSetPayload extends AccountCredentialChangedPayload {
  // How they proved it was them, in the app - the console always asks for the current password.
  confirmedWith?: 'password' | 'google';
}

export type SignUpMethod = 'google' | 'email';

export interface AccountIdentityLinkedPayload {
  userId: string;
  provider: IdentityProvider;
  // The account's email had never been proven, so its old password and sessions ended.
  passwordRemoved: boolean;
}

export interface AdminSignedInPayload {
  userId: string;
}

// No user id: the attempt may not match any account.
export interface AdminSignInFailedPayload {
  email: string;
  // Absent means invalid credentials.
  reason?: 'invalid_credentials' | 'rate_limited';
}

export interface StaffAccountCreatedPayload {
  userId: string;
  actorId: string;
  role: PlatformRole;
  // Empty for a super admin, who has them all.
  permissions: AdminPermission[];
}

// The room is told first (`stream:locked`), then the live ends as usual.
export interface StreamLockedPayload {
  streamId: string;
  hostId: string;
  actorId: string;
  reason: string;
}

export interface StreamUnlockedPayload {
  streamId: string;
  actorId: string;
  // The live stays over; only its host is told (`stream:unlocked`).
  hostId?: string;
}

export interface AdminAlertSentPayload {
  alertId: string;
  actorId: string;
  scope: AlertScope;
  streamId: string | null;
  message: string;
  severity: AlertSeverity;
  createdAt: Date;
}

// RealtimeGateway tells every open app (`app:update`), and each asks
// GET /v1/app/update again. The release as it is after the change.
export interface AppReleaseChangedPayload {
  change: 'published' | 'updated' | 'withdrawn';
  releaseId: string;
  actorId: string;
  platform: AppPlatform;
  version: string;
  build: number;
  required: boolean;
  // 'updated' only: which of notes, downloadUrl and required changed.
  fields?: string[];
}

export interface BannedPhraseChangedPayload {
  phraseId: string;
  actorId: string;
  phrase: string;
  severity: BannedPhraseSeverity;
}

// Only emitted when a follow actually existed.
export interface UserUnfollowedPayload {
  followerId: string;
  followeeId: string;
}

// Staff fixing an offensive name, bio or picture - with what it was before.
export interface UserProfileModeratedPayload {
  userId: string;
  actorId: string;
  reason: string;
  changes: Record<string, { from: string | null; to: string | null }>;
}

// Direct messages between friends (docs/features/messages.md). What the API
// answers with, and what `message:new` carries.
export interface DirectMessageSnapshot {
  id: string;
  senderId: string;
  recipientId: string;
  text: string;
  // The sending app's own id for it, so that app can match its pending bubble.
  clientId: string | null;
  createdAt: Date;
  // When the recipient read it; null while unread.
  readAt: Date | null;
}

/** The brief profile shown beside a conversation. */
export interface DirectMessagePerson {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

// After the message is stored. RealtimeGateway relays it as `message:new` to
// both people's own rooms - the recipient's inbox, and the sender's other
// devices - and `message:unread_count` to the recipient: a total, so a missed
// update never leaves the badge wrong.
export interface DirectMessageSentPayload {
  message: DirectMessageSnapshot;
  // Both people, so either app can put a new conversation in its inbox without a fetch.
  sender: DirectMessagePerson;
  recipient: DirectMessagePerson;
  recipientUnreadCount: number;
}

// Only when something was unread. Relayed as `message:read` to both people's
// own rooms - the partner's app shows "Seen", the reader's other devices clear
// the conversation - and `message:unread_count` (the reader's total) to the reader.
export interface DirectMessagesReadPayload {
  readerId: string;
  // Whose messages were read.
  partnerId: string;
  readAt: Date;
  readerUnreadCount: number;
}
