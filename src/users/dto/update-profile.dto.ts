import { ProfileVisibility } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
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
}
