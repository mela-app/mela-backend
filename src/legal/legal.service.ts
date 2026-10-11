import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SessionPlatform, UserStatus } from '@prisma/client';
import { DomainEvents, UserSuspendedPayload } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  ageOn,
  checkVersion,
  LEGAL_PATHS,
  LEGAL_VERSION,
  MINIMUM_AGE,
  parseBirthDate,
  UNDER_AGE_REASON,
  underAge,
} from './legal-rules';

export interface LegalStatus {
  version: string;
  minimumAge: number;
  termsPath: string;
  privacyPath: string;
  /** The version this account last accepted - null if never. */
  acceptedVersion: string | null;
  /** Must accept the documents in force before going on. */
  needsAcceptance: boolean;
  /** Made before the age check: must give a date of birth too. */
  needsBirthDate: boolean;
}

/**
 * The 18+ age check and the Terms/Privacy acceptance for accounts that
 * signed up before them, or before the documents last changed (sign-up
 * itself checks in `IdentitySignInService.createAccount`). See
 * docs/features/legal.md.
 */
@Injectable()
export class LegalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  /** What anyone may read before signing up: the version in force, and where. */
  info() {
    return {
      version: LEGAL_VERSION,
      minimumAge: MINIMUM_AGE,
      termsPath: LEGAL_PATHS.terms,
      privacyPath: LEGAL_PATHS.privacy,
    };
  }

  async status(userId: string): Promise<LegalStatus> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { legalVersion: true, birthDate: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return {
      ...this.info(),
      acceptedVersion: user.legalVersion,
      needsAcceptance: user.legalVersion !== LEGAL_VERSION,
      needsBirthDate: user.birthDate === null,
    };
  }

  /**
   * Accepts the documents in force - with a date of birth if the account
   * has none. Someone who says they're under 18 has their account suspended
   * as staff would (signed out everywhere, disconnected); staff may
   * reinstate it from the console if it was a mistake.
   */
  async accept(
    userId: string,
    input: { version: string; birthDate?: string },
    platform: SessionPlatform = SessionPlatform.UNKNOWN,
    now: Date = new Date(),
  ): Promise<LegalStatus> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { birthDate: true, status: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const version = checkVersion(input.version);

    let birthDate: Date | undefined;
    if (user.birthDate === null) {
      const given = input.birthDate === undefined ? null : parseBirthDate(input.birthDate, now);
      if (!given) {
        throw new BadRequestException({
          message: 'Enter your date of birth.',
          code: 'INVALID_BIRTH_DATE',
        });
      }
      if (ageOn(given, now) < MINIMUM_AGE) {
        await this.suspendUnderAge(userId, user.status, now);
        throw underAge();
      }
      birthDate = given;
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { legalVersion: version, legalAcceptedAt: now, ...(birthDate && { birthDate }) },
      }),
      this.prisma.legalAcceptance.create({ data: { userId, version, platform, acceptedAt: now } }),
    ]);
    return this.status(userId);
  }

  private async suspendUnderAge(userId: string, status: UserStatus, now: Date): Promise<void> {
    if (status === UserStatus.SUSPENDED) return;
    await this.prisma.user.update({
      where: { id: userId },
      data: { status: UserStatus.SUSPENDED, suspendedAt: now, suspensionReason: UNDER_AGE_REASON },
    });
    // Ends their sessions and sockets, and goes in the audit log - by themselves.
    this.events.emit(DomainEvents.UserSuspended, {
      userId,
      suspendedBy: userId,
      reason: UNDER_AGE_REASON,
    } satisfies UserSuspendedPayload);
  }
}
