import { AlertScope, AlertSeverity, BannedPhraseSeverity } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
// One space between words, lower case: how the filter compares anyway.
const normalizePhrase = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : value;

export class SendAlertDto {
  @IsEnum(AlertScope)
  scope!: AlertScope;

  @ValidateIf((dto: SendAlertDto) => dto.scope === AlertScope.STREAM)
  @IsUUID('all', { message: 'Pick the live to send it to' })
  streamId?: string;

  @Transform(trim)
  @IsString()
  @MinLength(3, { message: 'Write at least 3 characters' })
  @MaxLength(280)
  message!: string;

  @IsEnum(AlertSeverity)
  severity!: AlertSeverity;
}

export class BannedPhraseDto {
  @Transform(normalizePhrase)
  @IsString()
  @MinLength(2, { message: 'Use at least 2 characters' })
  @MaxLength(100)
  phrase!: string;

  @IsEnum(BannedPhraseSeverity)
  severity!: BannedPhraseSeverity;
}

export class UpdateBannedPhraseDto {
  @IsOptional()
  @Transform(normalizePhrase)
  @IsString()
  @MinLength(2, { message: 'Use at least 2 characters' })
  @MaxLength(100)
  phrase?: string;

  @IsOptional()
  @IsEnum(BannedPhraseSeverity)
  severity?: BannedPhraseSeverity;
}

export class TestPhraseDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  text!: string;
}
