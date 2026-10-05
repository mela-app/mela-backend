import { AppPlatform } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { VERSION_PATTERN } from '../../app-releases/app-release.rules';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const LINK = { protocols: ['https', 'http'], require_protocol: true, require_tld: false };
const LINK_MESSAGE = { message: 'Give a full link, starting with https://' };

export class PublishReleaseDto {
  @IsEnum(AppPlatform)
  platform!: AppPlatform;

  @Transform(trim)
  @IsString()
  @Matches(VERSION_PATTERN, { message: 'Write the version as three numbers, like 1.2.0' })
  version!: string;

  // The number after + in pubspec.yaml.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_000_000_000)
  build!: number;

  // What's new, one change per line.
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: "Say what's new in at least 3 characters" })
  @MaxLength(1000)
  notes!: string;

  @Transform(trim)
  @IsUrl(LINK, LINK_MESSAGE)
  @MaxLength(500)
  downloadUrl!: string;

  @IsOptional()
  @IsBoolean()
  required?: boolean;
}

/** The version and build stay as published; a wrong one is withdrawn and published again. */
export class UpdateReleaseDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: "Say what's new in at least 3 characters" })
  @MaxLength(1000)
  notes?: string;

  @IsOptional()
  @Transform(trim)
  @IsUrl(LINK, LINK_MESSAGE)
  @MaxLength(500)
  downloadUrl?: string;

  @IsOptional()
  @IsBoolean()
  required?: boolean;
}
