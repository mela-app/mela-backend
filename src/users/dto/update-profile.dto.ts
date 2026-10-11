import { ProfileSharing, ProfileVisibility } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { USERNAME_PATTERN, USERNAME_RULE } from '../../auth/identity/usernames';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class UpdateProfileDto {
  // Once in 30 days (USERNAME_CHANGE_DAYS).
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(USERNAME_PATTERN, { message: USERNAME_RULE })
  username?: string;

  // Once in 7 days (DISPLAY_NAME_CHANGE_DAYS).
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Enter your name' })
  @MaxLength(50)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  bio?: string;

  @IsOptional()
  // require_tld: false - dev avatar URLs point at localhost (S3Mock), which has no TLD.
  @IsUrl({ require_tld: false })
  avatarUrl?: string;

  @IsOptional()
  @IsEnum(ProfileVisibility)
  profileVisibility?: ProfileVisibility;

  @IsOptional()
  @IsEnum(ProfileSharing)
  profileSharing?: ProfileSharing;

  // Whether followers hear when you join someone's live.
  @IsOptional()
  @IsBoolean()
  shareLiveJoins?: boolean;
}
