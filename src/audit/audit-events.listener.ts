import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AuditActorRole, GuestRequestInitiator, StreamEndReason } from '@prisma/client';
import {
  AccountCredentialChangedPayload,
  AccountDeletedPayload,
  AccountIdentityLinkedPayload,
  AccountPasswordSetPayload,
  AdminAlertSentPayload,
  AdminSignInFailedPayload,
  AdminSignedInPayload,
  AppReleaseChangedPayload,
  BannedPhraseChangedPayload,
  ChatMessageDeletedPayload,
  ChatMessagePinnedPayload,
  ChatMessageUnpinnedPayload,
  DataClearedPayload,
  DataResetPayload,
  DirectMessageErasedPayload,
  DomainEvents,
  GuestJoinedPayload,
  GuestMicForceMuteChangedPayload,
  GuestRemovedPayload,
  GuestRequestCreatedPayload,
  ModeratorGrantedPayload,
  ModeratorRevokedPayload,
  ModeratorUpdatedPayload,
  RoomBanCreatedPayload,
  RoomBanLiftedPayload,
  RoomChatMuteChangedPayload,
  ReportCaseResolvedPayload,
  StaffAccountCreatedPayload,
  StreamEndedPayload,
  StreamInviteSentPayload,
  StreamLayoutChangedPayload,
  StreamLockedPayload,
  StreamStartedPayload,
  StreamUnlockedPayload,
  UserBlockedPayload,
  UserFollowedPayload,
  UserLoggedInPayload,
  UserLoggedOutPayload,
  UserProfileModeratedPayload,
  UserProfileUpdatedPayload,
  UserReinstatedPayload,
  UserRegisteredPayload,
  UserRoleChangedPayload,
  UserAdminPermissionsChangedPayload,
  UserSessionsRevokedPayload,
  UserSuspendedPayload,
  UserUnfollowedPayload,
} from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { RequestContext } from '../common/request-context/request-context';
import { DELETED_ACCOUNT_LABEL } from './audit-catalog';
import { AuditEntry, AuditService } from './audit.service';

const EXCERPT = 80;

/**
 * Turns domain events into audit entries, so no feature module imports the
 * audit trail (plan §4.1). The request context is captured as the event
 * fires; labels are looked up afterwards, off the request's path.
 */
@Injectable()
export class AuditEventsListener {
  private readonly logger = new Logger(AuditEventsListener.name);

  constructor(
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  @OnEvent(DomainEvents.UserRegistered)
  onRegistered(payload: UserRegisteredPayload) {
    return this.track(async () => ({
      action: 'auth.signed_up',
      actorId: payload.userId,
      target: { type: 'USER', id: payload.userId, label: `@${payload.username}` },
      ...(payload.method && { metadata: { method: payload.method } }),
    }));
  }

  @OnEvent(DomainEvents.UserLoggedIn)
  onLoggedIn(payload: UserLoggedInPayload) {
    return this.track(async () => ({
      action: 'auth.signed_in',
      actorId: payload.userId,
      metadata: { platform: payload.platform, ...(payload.method && { method: payload.method }) },
    }));
  }

  @OnEvent(DomainEvents.UserLoggedOut)
  onLoggedOut(payload: UserLoggedOutPayload) {
    return this.track(async () => ({ action: 'auth.signed_out', actorId: payload.userId }));
  }

  @OnEvent(DomainEvents.AdminSignedIn)
  onAdminSignedIn(payload: AdminSignedInPayload) {
    return this.track(async () => ({ action: 'admin.signed_in', actorId: payload.userId }));
  }

  @OnEvent(DomainEvents.AdminSignInFailed)
  onAdminSignInFailed(payload: AdminSignInFailedPayload) {
    return this.track(async () => {
      const account = await this.prisma.user.findFirst({
        where: { email: { equals: payload.email, mode: 'insensitive' } },
        select: { id: true, username: true },
      });
      return {
        action: 'admin.sign_in_failed',
        actorRole: AuditActorRole.SYSTEM,
        actorLabel: payload.email,
        target: account ? { type: 'USER', id: account.id, label: `@${account.username}` } : null,
        metadata: { reason: payload.reason ?? 'invalid_credentials' },
      };
    });
  }

  @OnEvent(DomainEvents.AdminSignedOut)
  onAdminSignedOut(payload: AdminSignedInPayload) {
    return this.track(async () => ({ action: 'admin.signed_out', actorId: payload.userId }));
  }

  @OnEvent(DomainEvents.AccountPasswordChanged)
  onPasswordChanged(payload: AccountPasswordSetPayload) {
    return this.track(async () => ({
      action: 'account.password_changed',
      actorId: payload.userId,
      ...(payload.confirmedWith && { metadata: { confirmedWith: payload.confirmedWith } }),
    }));
  }

  @OnEvent(DomainEvents.AccountPasswordAdded)
  onPasswordAdded(payload: AccountPasswordSetPayload) {
    return this.track(async () => ({
      action: 'account.password_added',
      actorId: payload.userId,
      ...(payload.confirmedWith && { metadata: { confirmedWith: payload.confirmedWith } }),
    }));
  }

  @OnEvent(DomainEvents.AccountEmailChanged)
  onEmailChanged(payload: AccountCredentialChangedPayload) {
    return this.track(async () => ({ action: 'account.email_changed', actorId: payload.userId }));
  }

  @OnEvent(DomainEvents.AccountIdentityLinked)
  onIdentityLinked(payload: AccountIdentityLinkedPayload) {
    return this.track(async () => ({
      action: 'account.identity_linked',
      actorId: payload.userId,
      metadata: { provider: payload.provider, passwordRemoved: payload.passwordRemoved },
    }));
  }

  @OnEvent(DomainEvents.UserProfileUpdated)
  onProfileUpdated(payload: UserProfileUpdatedPayload) {
    return this.track(async () => ({
      action: 'account.profile_updated',
      actorId: payload.userId,
      metadata: { fields: payload.fields },
    }));
  }

  @OnEvent(DomainEvents.UserSuspended)
  onSuspended(payload: UserSuspendedPayload) {
    return this.track(async () => ({
      action: 'user.suspended',
      actorId: payload.suspendedBy,
      target: await this.userTarget(payload.userId),
      reason: payload.reason,
    }));
  }

  @OnEvent(DomainEvents.UserReinstated)
  onReinstated(payload: UserReinstatedPayload) {
    return this.track(async () => ({
      action: 'user.reinstated',
      actorId: payload.reinstatedBy,
      target: await this.userTarget(payload.userId),
    }));
  }

  @OnEvent(DomainEvents.UserRoleChanged)
  onRoleChanged(payload: UserRoleChangedPayload) {
    return this.track(async () => ({
      action: 'user.role_changed',
      actorId: payload.actorId,
      target: await this.userTarget(payload.userId),
      metadata: {
        from: payload.from,
        to: payload.to,
        ...(payload.permissions ? { permissions: payload.permissions } : {}),
      },
    }));
  }

  @OnEvent(DomainEvents.UserAdminPermissionsChanged)
  onAdminPermissionsChanged(payload: UserAdminPermissionsChangedPayload) {
    return this.track(async () => ({
      action: 'user.permissions_changed',
      actorId: payload.actorId,
      target: await this.userTarget(payload.userId),
      metadata: { from: payload.from, to: payload.to },
    }));
  }

  @OnEvent(DomainEvents.UserSessionsRevoked)
  onSessionsRevoked(payload: UserSessionsRevokedPayload) {
    return this.track(async () => ({
      action: 'user.sessions_revoked',
      actorId: payload.actorId,
      target: await this.userTarget(payload.userId),
    }));
  }

  @OnEvent(DomainEvents.StaffAccountCreated)
  onStaffCreated(payload: StaffAccountCreatedPayload) {
    return this.track(async () => ({
      action: 'admin.staff_created',
      actorId: payload.actorId,
      target: await this.userTarget(payload.userId),
      metadata: {
        role: payload.role,
        ...(payload.permissions.length ? { permissions: payload.permissions } : {}),
      },
    }));
  }

  @OnEvent(DomainEvents.UserProfileModerated)
  onProfileModerated(payload: UserProfileModeratedPayload) {
    return this.track(async () => ({
      action: 'user.profile_edited',
      actorId: payload.actorId,
      target: await this.userTarget(payload.userId),
      reason: payload.reason,
      metadata: { changes: payload.changes },
    }));
  }

  @OnEvent(DomainEvents.StreamStarted)
  onStreamStarted(payload: StreamStartedPayload) {
    return this.track(async () => ({
      action: 'stream.started',
      actorId: payload.hostId,
      actorRole: AuditActorRole.HOST,
      target: { type: 'STREAM', id: payload.streamId, label: payload.title || null },
      streamId: payload.streamId,
    }));
  }

  // A lock already has its own entry, by the admin who did it.
  @OnEvent(DomainEvents.StreamEnded)
  onStreamEnded(payload: StreamEndedPayload) {
    if (payload.reason === StreamEndReason.LOCKED) return Promise.resolve();
    return this.track(async () => {
      const stream = await this.prisma.stream.findUnique({
        where: { id: payload.streamId },
        select: {
          hostId: true,
          title: true,
          startedAt: true,
          endedAt: true,
          peakViewerCount: true,
        },
      });
      if (!stream) return null;
      const byHost = payload.reason !== StreamEndReason.HOST_DISCONNECTED;
      return {
        action: 'stream.ended',
        actorId: byHost ? stream.hostId : null,
        actorRole: byHost ? AuditActorRole.HOST : AuditActorRole.SYSTEM,
        target: { type: 'STREAM', id: payload.streamId, label: stream.title || null },
        streamId: payload.streamId,
        metadata: {
          reason: payload.reason,
          peakViewerCount: stream.peakViewerCount,
          durationSeconds: stream.endedAt
            ? Math.round((stream.endedAt.getTime() - stream.startedAt.getTime()) / 1000)
            : null,
        },
      };
    });
  }

  @OnEvent(DomainEvents.StreamLocked)
  onStreamLocked(payload: StreamLockedPayload) {
    return this.track(async () => ({
      action: 'stream.locked',
      actorId: payload.actorId,
      target: await this.streamTarget(payload.streamId),
      streamId: payload.streamId,
      reason: payload.reason,
      metadata: { hostId: payload.hostId },
    }));
  }

  @OnEvent(DomainEvents.StreamUnlocked)
  onStreamUnlocked(payload: StreamUnlockedPayload) {
    return this.track(async () => ({
      action: 'stream.unlocked',
      actorId: payload.actorId,
      target: await this.streamTarget(payload.streamId),
      streamId: payload.streamId,
    }));
  }

  // Only the host can change the layout.
  @OnEvent(DomainEvents.StreamLayoutChanged)
  onLayoutChanged(payload: StreamLayoutChangedPayload) {
    return this.track(async () => ({
      action: 'stream.layout_changed',
      actorId: await this.hostOf(payload.streamId),
      actorRole: AuditActorRole.HOST,
      target: await this.streamTarget(payload.streamId),
      streamId: payload.streamId,
      metadata: { layout: payload.layout },
    }));
  }

  @OnEvent(DomainEvents.StreamInviteSent)
  onStreamShared(payload: StreamInviteSentPayload) {
    return this.track(async () => ({
      action: 'stream.shared',
      actorId: payload.senderId,
      hostId: await this.hostOf(payload.streamId),
      target: await this.streamTarget(payload.streamId),
      streamId: payload.streamId,
      metadata: { recipients: payload.recipientIds.length },
    }));
  }

  @OnEvent(DomainEvents.ChatMessageDeleted)
  onMessageDeleted(payload: ChatMessageDeletedPayload) {
    return this.track(async () => {
      const message =
        payload.erased ??
        (await this.prisma.chatMessage
          .findUnique({
            where: { id: payload.messageId },
            select: {
              text: true,
              userId: true,
              user: { select: { username: true } },
              stream: { select: { hostId: true } },
            },
          })
          .then((row) =>
            row
              ? {
                  text: row.text,
                  senderId: row.userId,
                  sender: row.user.username,
                  hostId: row.stream.hostId,
                }
              : null,
          ));
      return {
        action: 'chat.message_deleted',
        actorId: payload.actorId,
        hostId: message?.hostId,
        target: {
          type: 'MESSAGE',
          id: payload.messageId,
          label: message ? excerpt(message.text) : null,
        },
        streamId: payload.streamId,
        metadata: message
          ? {
              senderId: message.senderId,
              sender: `@${message.sender}`,
              ...(payload.erased && { erased: true }),
            }
          : undefined,
      };
    });
  }

  @OnEvent(DomainEvents.ChatMessagePinned)
  onMessagePinned(payload: ChatMessagePinnedPayload) {
    return this.track(async () => ({
      action: 'chat.message_pinned',
      actorId: payload.actorId,
      hostId: await this.hostOf(payload.streamId),
      target: { type: 'MESSAGE', id: payload.messageId, label: excerpt(payload.text) },
      streamId: payload.streamId,
      metadata: { sender: payload.senderName },
    }));
  }

  @OnEvent(DomainEvents.ChatMessageUnpinned)
  onMessageUnpinned(payload: ChatMessageUnpinnedPayload) {
    return this.track(async () => ({
      action: 'chat.message_unpinned',
      actorId: payload.actorId,
      hostId: await this.hostOf(payload.streamId),
      target: await this.streamTarget(payload.streamId),
      streamId: payload.streamId,
    }));
  }

  @OnEvent(DomainEvents.RoomBanCreated)
  onRoomBan(payload: RoomBanCreatedPayload) {
    return this.track(async () => ({
      action: 'moderation.user_banned',
      actorId: payload.actorId ?? payload.hostId,
      hostId: payload.hostId,
      target: await this.userTarget(payload.bannedUserId),
      streamId: payload.streamId,
      metadata: { scope: payload.scope, hostId: payload.hostId },
    }));
  }

  @OnEvent(DomainEvents.RoomBanLifted)
  onRoomBanLifted(payload: RoomBanLiftedPayload) {
    return this.track(async () => ({
      action: 'moderation.ban_lifted',
      actorId: payload.actorId,
      hostId: payload.hostId,
      target: await this.userTarget(payload.bannedUserId),
      streamId: payload.streamId,
      metadata: { hostId: payload.hostId },
    }));
  }

  @OnEvent(DomainEvents.RoomChatMuteChanged)
  onChatMute(payload: RoomChatMuteChangedPayload) {
    return this.track(async () => ({
      action: payload.muted ? 'moderation.chat_muted' : 'moderation.chat_unmuted',
      actorId: payload.actorId,
      hostId: await this.hostOf(payload.streamId),
      target: await this.userTarget(payload.userId),
      streamId: payload.streamId,
      metadata: payload.muted
        ? { until: payload.mutedUntil?.toISOString() ?? 'end of live' }
        : undefined,
    }));
  }

  @OnEvent(DomainEvents.ModeratorGranted)
  onModeratorGranted(payload: ModeratorGrantedPayload) {
    return this.track(async () => ({
      action: 'moderation.moderator_added',
      actorId: payload.hostId,
      actorRole: AuditActorRole.HOST,
      target: await this.userTarget(payload.userId),
      streamId: payload.streamId,
      metadata: { capabilities: payload.capabilities },
    }));
  }

  // Only the host manages moderators (plan §6.9).
  @OnEvent(DomainEvents.ModeratorUpdated)
  onModeratorUpdated(payload: ModeratorUpdatedPayload) {
    return this.track(async () => ({
      action: 'moderation.moderator_updated',
      actorId: await this.hostOf(payload.streamId),
      actorRole: AuditActorRole.HOST,
      target: await this.userTarget(payload.userId),
      streamId: payload.streamId,
      metadata: { capabilities: payload.capabilities },
    }));
  }

  @OnEvent(DomainEvents.ModeratorRevoked)
  onModeratorRevoked(payload: ModeratorRevokedPayload) {
    return this.track(async () => ({
      action: 'moderation.moderator_removed',
      actorId: await this.hostOf(payload.streamId),
      actorRole: AuditActorRole.HOST,
      target: await this.userTarget(payload.userId),
      streamId: payload.streamId,
    }));
  }

  @OnEvent(DomainEvents.GuestMicForceMuteChanged)
  onGuestMic(payload: GuestMicForceMuteChangedPayload) {
    return this.track(async () => ({
      action: payload.forceMuted ? 'moderation.guest_mic_locked' : 'moderation.guest_mic_unlocked',
      actorId: payload.actorId,
      hostId: await this.hostOf(payload.streamId),
      target: await this.userTarget(payload.userId),
      streamId: payload.streamId,
    }));
  }

  // A raised hand (the viewer acts) or the host's invite (the host acts).
  @OnEvent(DomainEvents.GuestRequestCreated)
  onGuestRequest(payload: GuestRequestCreatedPayload) {
    if (payload.initiatedBy === GuestRequestInitiator.HOST) {
      return this.track(async () => ({
        action: 'guest.invited',
        actorId: await this.hostOf(payload.streamId),
        actorRole: AuditActorRole.HOST,
        target: { type: 'USER', id: payload.user.id, label: `@${payload.user.username}` },
        streamId: payload.streamId,
      }));
    }
    return this.track(async () => ({
      action: 'guest.requested',
      actorId: payload.user.id,
      actorRole: AuditActorRole.USER,
      target: await this.streamTarget(payload.streamId),
      streamId: payload.streamId,
    }));
  }

  @OnEvent(DomainEvents.GuestJoined)
  onGuestJoined(payload: GuestJoinedPayload) {
    return this.track(async () => ({
      action: 'guest.joined',
      actorId: payload.user.id,
      actorRole: AuditActorRole.USER,
      target: await this.streamTarget(payload.streamId),
      streamId: payload.streamId,
    }));
  }

  @OnEvent(DomainEvents.GuestRemoved)
  onGuestRemoved(payload: GuestRemovedPayload) {
    if (!payload.wasRemovedByHostOrModerator) {
      return this.track(async () => ({
        action: 'guest.left',
        actorId: payload.userId,
        actorRole: AuditActorRole.USER,
        target: await this.streamTarget(payload.streamId),
        streamId: payload.streamId,
      }));
    }
    return this.track(async () => ({
      action: 'guest.removed',
      actorId: payload.actorId ?? payload.hostId,
      hostId: payload.hostId,
      target: await this.userTarget(payload.userId),
      streamId: payload.streamId,
    }));
  }

  @OnEvent(DomainEvents.UserFollowed)
  onFollowed(payload: UserFollowedPayload) {
    return this.track(async () => ({
      action: 'social.followed',
      actorId: payload.followerId,
      actorRole: AuditActorRole.USER,
      target: await this.userTarget(payload.followeeId),
    }));
  }

  @OnEvent(DomainEvents.UserUnfollowed)
  onUnfollowed(payload: UserUnfollowedPayload) {
    return this.track(async () => ({
      action: 'social.unfollowed',
      actorId: payload.followerId,
      actorRole: AuditActorRole.USER,
      target: await this.userTarget(payload.followeeId),
    }));
  }

  @OnEvent(DomainEvents.UserBlocked)
  onBlocked(payload: UserBlockedPayload) {
    return this.track(async () => ({
      action: 'social.blocked',
      actorId: payload.blockerId,
      actorRole: AuditActorRole.USER,
      target: await this.userTarget(payload.blockedId),
    }));
  }

  @OnEvent(DomainEvents.UserUnblocked)
  onUnblocked(payload: UserBlockedPayload) {
    return this.track(async () => ({
      action: 'social.unblocked',
      actorId: payload.blockerId,
      actorRole: AuditActorRole.USER,
      target: await this.userTarget(payload.blockedId),
    }));
  }

  @OnEvent(DomainEvents.AdminAlertSent)
  onAlertSent(payload: AdminAlertSentPayload) {
    return this.track(async () => ({
      action: 'alert.sent',
      actorId: payload.actorId,
      target: { type: 'ALERT', id: payload.alertId, label: excerpt(payload.message) },
      streamId: payload.streamId,
      metadata: { scope: payload.scope, severity: payload.severity },
    }));
  }

  @OnEvent(DomainEvents.AppReleaseChanged)
  onAppReleaseChanged(payload: AppReleaseChangedPayload) {
    const platform = payload.platform === 'IOS' ? 'iOS' : 'Android';
    return this.track(async () => ({
      action: `app.release_${payload.change}` as const,
      actorId: payload.actorId,
      target: {
        type: 'APP_RELEASE',
        id: payload.releaseId,
        label: `${platform} ${payload.version}${payload.build === null ? '' : ` (${payload.build})`}`,
      },
      metadata: {
        platform: payload.platform,
        version: payload.version,
        build: payload.build,
        required: payload.required,
        ...(payload.fields ? { fields: payload.fields } : {}),
      },
    }));
  }

  // Recorded after the removal, so even clearing the audit log leaves this entry.
  @OnEvent(DomainEvents.DataCleared)
  onDataCleared(payload: DataClearedPayload) {
    return this.track(async () => ({
      action: 'data.cleared',
      actorId: payload.actorId,
      target: { type: 'DATA', id: payload.dataSet, label: payload.label },
      metadata: {
        removed: payload.removed,
        ...(payload.olderThanDays !== null && { olderThanDays: payload.olderThanDays }),
      },
    }));
  }

  @OnEvent(DomainEvents.DataReset)
  onDataReset(payload: DataResetPayload) {
    return this.track(async () => ({
      action: 'data.reset',
      actorId: payload.actorId,
      metadata: { kept: payload.kept, usersRemoved: payload.usersRemoved },
    }));
  }

  @OnEvent(DomainEvents.ReportCaseResolved)
  onReportResolved(payload: ReportCaseResolvedPayload) {
    return this.track(async () => ({
      action: payload.outcome === 'ACTIONED' ? 'report.actioned' : 'report.dismissed',
      actorId: payload.actorId,
      target: { type: 'REPORT', id: payload.caseId, label: payload.label },
      reason: payload.note,
      metadata: { targetType: payload.targetType, reporters: payload.reporterIds.length },
    }));
  }

  // Not what it said: the audit log is read more widely than reports.
  @OnEvent(DomainEvents.DirectMessageErased)
  onPrivateMessageErased(payload: DirectMessageErasedPayload) {
    return this.track(async () => {
      const sender = await this.prisma.user.findUnique({
        where: { id: payload.senderId },
        select: { username: true },
      });
      return {
        action: 'report.private_message_removed',
        actorId: payload.actorId,
        target: {
          type: 'MESSAGE',
          id: payload.messageId,
          label: `Private message from ${sender ? `@${sender.username}` : 'a deleted account'}`,
        },
        metadata: { senderId: payload.senderId, recipientId: payload.recipientId },
      };
    });
  }

  // The account is gone, so neither entry names it.
  @OnEvent(DomainEvents.AccountDeleted)
  onAccountDeleted(payload: AccountDeletedPayload) {
    return this.track(async () =>
      payload.actorId
        ? {
            action: 'user.deleted',
            actorId: payload.actorId,
            target: { type: 'USER', id: payload.userId, label: DELETED_ACCOUNT_LABEL },
            reason: payload.reason,
          }
        : {
            action: 'account.deleted',
            actorRole: AuditActorRole.USER,
            actorLabel: DELETED_ACCOUNT_LABEL,
            target: { type: 'USER', id: payload.userId, label: DELETED_ACCOUNT_LABEL },
          },
    );
  }

  @OnEvent(DomainEvents.BannedPhraseCreated)
  onPhraseCreated(payload: BannedPhraseChangedPayload) {
    return this.trackPhrase('phrase.added', payload);
  }

  @OnEvent(DomainEvents.BannedPhraseUpdated)
  onPhraseUpdated(payload: BannedPhraseChangedPayload) {
    return this.trackPhrase('phrase.updated', payload);
  }

  @OnEvent(DomainEvents.BannedPhraseDeleted)
  onPhraseDeleted(payload: BannedPhraseChangedPayload) {
    return this.trackPhrase('phrase.removed', payload);
  }

  private trackPhrase(
    action: 'phrase.added' | 'phrase.updated' | 'phrase.removed',
    payload: BannedPhraseChangedPayload,
  ) {
    return this.track(async () => ({
      action,
      actorId: payload.actorId,
      target: { type: 'PHRASE', id: payload.phraseId, label: payload.phrase },
      metadata: { severity: payload.severity },
    }));
  }

  // The context is read now, while still inside the request that emitted the event.
  private track(build: () => Promise<AuditEntry | null>): Promise<void> {
    const context = RequestContext.current();
    return build().then(
      (entry) => (entry ? this.audit.record({ ...entry, context }) : undefined),
      (error) => this.logger.warn(`Could not build an audit entry: ${error}`),
    );
  }

  private async userTarget(userId: string): Promise<AuditEntry['target']> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });
    return { type: 'USER', id: userId, label: user ? `@${user.username}` : null };
  }

  private async streamTarget(streamId: string): Promise<AuditEntry['target']> {
    const stream = await this.prisma.stream.findUnique({
      where: { id: streamId },
      select: { title: true },
    });
    return { type: 'STREAM', id: streamId, label: stream?.title || null };
  }

  private async hostOf(streamId: string): Promise<string | undefined> {
    const stream = await this.prisma.stream.findUnique({
      where: { id: streamId },
      select: { hostId: true },
    });
    return stream?.hostId;
  }
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT - 1)}…` : flat;
}
