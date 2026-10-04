import { ModeratorCapability, PlatformRole } from '@prisma/client';
import { PermissionsService } from './permissions.service';

describe('PermissionsService', () => {
  let service: PermissionsService;
  const hostId = 'host-1';
  const viewer = { id: 'viewer-1', platformRole: PlatformRole.USER };

  beforeEach(() => {
    service = new PermissionsService();
  });

  it('lets the host do anything channel-scoped on their own channel', () => {
    expect(
      service.hasChannelCapability(hostId, hostId, null, ModeratorCapability.DELETE_MESSAGES),
    ).toBe(true);
  });

  it('lets an active moderator use only the capabilities they were granted', () => {
    const grant = { capabilities: [ModeratorCapability.DELETE_MESSAGES] };
    expect(
      service.hasChannelCapability(viewer.id, hostId, grant, ModeratorCapability.DELETE_MESSAGES),
    ).toBe(true);
    expect(
      service.hasChannelCapability(viewer.id, hostId, grant, ModeratorCapability.BAN_USERS),
    ).toBe(false);
  });

  it('refuses a random viewer with no grant at all', () => {
    expect(
      service.hasChannelCapability(viewer.id, hostId, null, ModeratorCapability.DELETE_MESSAGES),
    ).toBe(false);
    expect(
      service.hasChannelCapability(
        viewer.id,
        hostId,
        undefined,
        ModeratorCapability.DELETE_MESSAGES,
      ),
    ).toBe(false);
  });

  it('never lets a moderator start/end the stream, edit details, or manage moderators', () => {
    expect(service.canStartOrEndStream(viewer.id, hostId)).toBe(false);
    expect(service.canEditStreamDetails(viewer.id, hostId)).toBe(false);
    expect(service.canManageModerators(viewer.id, hostId)).toBe(false);
  });

  describe('moderation targets', () => {
    it('lets the host act on anyone, moderators included', () => {
      expect(service.moderationTargetRefusal(hostId, hostId, 'mod-2', true)).toBeNull();
      expect(service.moderationTargetRefusal(hostId, hostId, viewer.id, false)).toBeNull();
    });

    it('lets a moderator act on a plain viewer', () => {
      expect(service.moderationTargetRefusal('mod-1', hostId, viewer.id, false)).toBeNull();
    });

    it('never lets a moderator act on another moderator, or on the host', () => {
      expect(service.moderationTargetRefusal('mod-1', hostId, 'mod-2', true)).toBe(
        'TARGET_IS_MODERATOR',
      );
      expect(service.moderationTargetRefusal('mod-1', hostId, hostId, false)).toBe(
        'TARGET_IS_HOST',
      );
    });

    it('leaves acting on yourself to each action', () => {
      expect(service.moderationTargetRefusal('mod-1', hostId, 'mod-1', true)).toBeNull();
    });
  });

  it("lets a moderator lift the lock on their own mic, and nobody else's", () => {
    expect(service.canLiftOwnMicLock('mod-1', 'mod-1', true)).toBe(true);
    expect(service.canLiftOwnMicLock('mod-1', 'guest-1', true)).toBe(false);
    expect(service.canLiftOwnMicLock('guest-1', 'guest-1', false)).toBe(false);
  });
});
