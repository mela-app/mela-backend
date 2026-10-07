import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IdentityProvider, PlatformRole, StreamStatus } from '@prisma/client';
import { DELETED_ACCOUNT_LABEL } from '../audit/audit-catalog';
import { AccountProof, proveAccount } from '../auth/account-proof';
import { IdentityVerifier } from '../auth/identity/firebase-identity.verifier';
import { AccountDeletedPayload, DomainEvents } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { STORAGE_PROVIDER, StorageProvider } from '../common/storage/storage-provider.interface';
import { StreamsService } from '../streams/streams.service';

/**
 * Deleting an account for good (docs/features/auth.md) - what both app stores
 * require an app with sign-up to offer. Everything it made goes with it: its
 * lives and their chat, its messages, follows, notifications, and the
 * pictures and photos it uploaded. What stays is anonymous: the audit log's
 * entries about it (renamed "Deleted account", without its IP addresses) and
 * the reports it sent or that were made about it, for the safety team.
 */
@Injectable()
export class AccountDeletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly verifier: IdentityVerifier,
    private readonly streams: StreamsService,
    private readonly events: EventEmitter2,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  /** The app's "Delete account", proven again with the password or Google. */
  async deleteOwn(userId: string, proof: AccountProof): Promise<{ ok: true }> {
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        passwordHash: true,
        platformRole: true,
        identities: { where: { provider: IdentityProvider.GOOGLE }, select: { subject: true } },
      },
    });
    if (!account) throw new NotFoundException('Account not found');
    if (account.platformRole !== PlatformRole.USER) {
      throw new ForbiddenException({
        message: 'A staff account is removed by a super admin, in the admin console.',
        code: 'STAFF_ACCOUNT',
      });
    }
    await proveAccount(account, proof, this.verifier);
    await this.erase(userId);
    this.events.emit(DomainEvents.AccountDeleted, {
      userId,
      actorId: null,
      reason: null,
    } satisfies AccountDeletedPayload);
    return { ok: true };
  }

  /** The console's, for someone who asked without the app. Staff are made app users first. */
  async deleteByStaff(actorId: string, userId: string, reason: string): Promise<{ ok: true }> {
    if (actorId === userId) throw new BadRequestException("You can't delete your own account here");
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { platformRole: true },
    });
    if (!account) throw new NotFoundException('User not found');
    if (account.platformRole !== PlatformRole.USER) {
      throw new ConflictException('Make them an app user first, then delete the account');
    }
    await this.erase(userId);
    this.events.emit(DomainEvents.AccountDeleted, {
      userId,
      actorId,
      reason,
    } satisfies AccountDeletedPayload);
    return { ok: true };
  }

  private async erase(userId: string): Promise<void> {
    // Ended the usual way first, so nobody is left watching a live that's gone.
    const running = await this.prisma.stream.findMany({
      where: { hostId: userId, status: StreamStatus.LIVE },
      select: { id: true },
    });
    for (const live of running) {
      await this.streams.end(live.id, userId).catch(() => undefined);
    }
    const [user, photos] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { avatarUrl: true } }),
      this.prisma.chatMessage.findMany({
        where: { stream: { hostId: userId }, imageUrl: { not: null } },
        select: { imageUrl: true },
      }),
    ]);
    await this.prisma.$transaction([
      this.prisma.auditLog.updateMany({
        where: { actorId: userId },
        data: { actorLabel: DELETED_ACCOUNT_LABEL, ip: null, userAgent: null },
      }),
      this.prisma.auditLog.updateMany({
        where: { targetType: 'USER', targetId: userId },
        data: { targetLabel: DELETED_ACCOUNT_LABEL },
      }),
      // A live can't outlast its host; the rest goes with the account.
      this.prisma.stream.deleteMany({ where: { hostId: userId } }),
      this.prisma.user.delete({ where: { id: userId } }),
    ]);
    const files = [user?.avatarUrl ?? [], ...photos.map((photo) => photo.imageUrl ?? [])].flat();
    if (files.length > 0) void this.storage.deleteUrls(files);
  }
}
