import { AppPlatform } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { VERSION_PATTERN } from '../../app-releases/app-release.rules';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * A new version, as people see it in the store (pubspec.yaml's version).
 * No build number and no link: phones compare versions, and get the update
 * from Google Play or the App Store (docs/features/app-updates.md).
 */
export class PublishReleaseDto {
  @IsEnum(AppPlatform)
  platform!: AppPlatform;

  @Transform(trim)
  @IsString()
  @Matches(VERSION_PATTERN, { message: 'Write the version as three numbers, like 1.2.0' })
  version!: string;

  // What's new, one change per line.
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: "Say what's new in at least 3 characters" })
  @MaxLength(1000)
  notes!: string;

  @IsOptional()
  @IsBoolean()
  required?: boolean;
}

/** The version stays as published; a wrong one is withdrawn and published again. */
export class UpdateReleaseDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: "Say what's new in at least 3 characters" })
  @MaxLength(1000)
  notes?: string;

  @IsOptional()
  @IsBoolean()
  required?: boolean;
}
