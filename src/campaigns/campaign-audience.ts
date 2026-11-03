import { PlatformRole, Prisma, SessionPlatform, UserStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How recently someone must have gone live to count as a host. */
export const HOST_WITHIN_DAYS = 30;

/**
 * Who a push campaign is for (docs/features/campaigns.md). Every part
 * narrows it; empty is everyone with the app who takes announcements.
 */
export class CampaignAudience {
  // Phones on this platform.
  @IsOptional()
  @IsIn([SessionPlatform.ANDROID, SessionPlatform.IOS])
  platform?: SessionPlatform;

  // Phones on one of these app versions, e.g. ["1.0.3"] to ask them to update.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @Matches(/^\d{1,4}(\.\d{1,4}){0,3}$/, { each: true })
  appVersions?: string[];

  // Only people who went live in the last 30 days.
  @IsOptional()
  @IsBoolean()
  hostsOnly?: boolean;

  // Used the app within the last N days...
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  activeWithinDays?: number;

  // ...or, to win them back, not for the last N days.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  inactiveForDays?: number;
}

/**
 * The accounts [audience] picks: active app users with a phone that can get
 * a push, who didn't turn off announcements.
 */
export function audienceWhere(audience: CampaignAudience, now: Date): Prisma.UserWhereInput {
  const since = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const device: Prisma.UserSessionWhereInput = {
    pushToken: { not: null },
    ...(audience.platform ? { platform: audience.platform } : {}),
    ...(audience.appVersions?.length ? { appVersion: { in: audience.appVersions } } : {}),
  };
  const and: Prisma.UserWhereInput[] = [
    { OR: [{ notificationSettings: null }, { notificationSettings: { pushAnnouncements: true } }] },
  ];
  if (audience.hostsOnly) {
    and.push({ streams: { some: { startedAt: { gte: since(HOST_WITHIN_DAYS) } } } });
  }
  if (audience.activeWithinDays) {
    and.push({ activeDays: { some: { day: { gte: since(audience.activeWithinDays) } } } });
  }
  if (audience.inactiveForDays) {
    and.push({ activeDays: { none: { day: { gte: since(audience.inactiveForDays) } } } });
  }
  return {
    platformRole: PlatformRole.USER,
    status: UserStatus.ACTIVE,
    sessions: { some: device },
    AND: and,
  };
}

/** The audience as stored: only what was set. */
export function storedAudience(audience: CampaignAudience): Prisma.InputJsonObject {
  return Object.fromEntries(
    Object.entries(audience).filter(([, value]) =>
      Array.isArray(value) ? value.length > 0 : value !== undefined && value !== false,
    ),
  ) as Prisma.InputJsonObject;
}
