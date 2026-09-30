import { Injectable } from '@nestjs/common';
import { ModeratorCapability } from '@prisma/client';

/** An active moderator's granted abilities, as looked up by the caller (never fetched by this service itself). */
export interface ModeratorGrant {
  capabilities: ModeratorCapability[];
}

/** Why a moderation action can't target someone - see {@link PermissionsService.moderationTargetRefusal}. */
export type ModerationTargetRefusal = 'TARGET_IS_HOST' | 'TARGET_IS_MODERATOR';

/**
 * Single source of truth for "can this user do X" across the app. Callers
 * pass plain identifiers/booleans instead of this service reaching into
 * other modules' data - keeps it a pure, easily-testable policy layer.
 * See docs/features/permissions.md before adding a new check here.
 */
@Injectable()
export class PermissionsService {
  isHost(requesterId: string, hostId: string): boolean {
    return requesterId === hostId;
  }

  /**
   * Delete/pin/mute chat, ban/kick, accept/reject/remove guests, force-mute
   * a guest (plan §6.9) - the host always passes; otherwise an active grant
   * containing `capability` does. Pass the grant looked up for this
   * requester+host pair (or `null`/`undefined` if none/not active) - this
   * service never queries the `moderators` table itself.
   */
  hasChannelCapability(
    requesterId: string,
    hostId: string,
    grant: ModeratorGrant | null | undefined,
    capability: ModeratorCapability,
  ): boolean {
    if (this.isHost(requesterId, hostId)) return true;
    return grant?.capabilities.includes(capability) ?? false;
  }

  /**
   * Whom a moderation action - deleting a message, banning, muting in chat,
   * taking off the stage, locking a mic - may target, once the requester
   * holds the capability (plan §6.9): the host anyone; a moderator neither
   * the host nor another moderator of the stream. Null means allowed; acting
   * on yourself is left to each action. [targetIsModerator]: the target holds
   * an active grant for the stream.
   */
  moderationTargetRefusal(
    requesterId: string,
    hostId: string,
    targetId: string,
    targetIsModerator: boolean,
  ): ModerationTargetRefusal | null {
    if (requesterId === targetId || this.isHost(requesterId, hostId)) return null;
    if (targetId === hostId) return 'TARGET_IS_HOST';
    return targetIsModerator ? 'TARGET_IS_MODERATOR' : null;
  }

  /**
   * A moderator on stage may turn their own mic back on after the host
   * locked it (client feedback, 2026-09-29) - whatever they were granted.
   * Locking it, or anyone else's, still takes `FORCE_MUTE_GUESTS`.
   */
  canLiftOwnMicLock(requesterId: string, targetId: string, requesterIsModerator: boolean): boolean {
    return requesterIsModerator && requesterId === targetId;
  }

  // Host-only: moderators are deliberately excluded from these (plan §6.9).
  canStartOrEndStream(requesterId: string, hostId: string): boolean {
    return this.isHost(requesterId, hostId);
  }

  canEditStreamDetails(requesterId: string, hostId: string): boolean {
    return this.isHost(requesterId, hostId);
  }

  canManageModerators(requesterId: string, hostId: string): boolean {
    return this.isHost(requesterId, hostId);
  }

  // Admin console access is per permission, not per role: see ./admin-permissions.ts.
}

