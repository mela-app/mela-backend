import { SessionPlatform } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

/** Accepting the Terms/Privacy in force - with a date of birth, for an account made before the age check. */
export class AcceptLegalDto {
  @IsString()
  @MaxLength(20)
  version!: string;

  // YYYY-MM-DD; checked in LegalService.
  @IsOptional()
  @IsString()
  @MaxLength(10)
  birthDate?: string;

  @IsOptional()
  @IsEnum(SessionPlatform)
  platform?: SessionPlatform;
}
