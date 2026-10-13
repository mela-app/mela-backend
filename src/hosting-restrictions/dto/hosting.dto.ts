import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PageQueryDto } from '../../common/pagination/page-query.dto';
import {
  APPEAL_IMAGE_TYPES,
  APPEAL_MAX_IMAGES,
  APPEAL_TEXT_MAX,
  AppealImageType,
  STAFF_TEXT_MAX,
} from '../hosting-rules';
import { RestrictionFilter } from '../hosting-restrictions.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

// --- The host (the app) ------------------------------------------------------

export class AppealImageUploadUrlDto {
  @IsIn(Object.keys(APPEAL_IMAGE_TYPES))
  contentType!: AppealImageType;
}

export class SendAppealDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Write your message' })
  @MaxLength(APPEAL_TEXT_MAX)
  text!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(APPEAL_MAX_IMAGES)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  imageKeys?: string[];
}

// --- Staff (the console) -----------------------------------------------------

export class SaveReasonDto {
  // The heading the host reads.
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: 'Give the reason a title of at least 3 characters' })
  @MaxLength(120)
  title!: string;

  // What the host is told, in full.
  @Transform(trim)
  @IsString()
  @MinLength(10, { message: 'Explain it to the host in at least 10 characters' })
  @MaxLength(STAFF_TEXT_MAX)
  message!: string;
}

export class UpdateReasonDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(STAFF_TEXT_MAX)
  message?: string;

  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}

export class ListReasonsQueryDto {
  // Archived ones too.
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  archived?: boolean;
}

export class RestrictHostDto extends SaveReasonDto {
  @IsString()
  @MaxLength(64)
  userId!: string;

  // The live it's about.
  @IsOptional()
  @IsUUID()
  streamId?: string;

  // The saved reason it came from (its words may have been edited for this one).
  @IsOptional()
  @IsUUID()
  reasonId?: string;

  // Staff only - the host never sees it.
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(STAFF_TEXT_MAX)
  note?: string;

  // Null or left out: until lifted. At most a year.
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(24 * 365)
  durationHours?: number | null;

  // Keep these words as a new reason to pick next time.
  @IsOptional()
  @IsBoolean()
  saveAsReason?: boolean;
}

export class LiftRestrictionDto {
  // A word to the host, shown in the conversation.
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(STAFF_TEXT_MAX)
  reply?: string;
}

export class AnswerAppealDto {
  @IsIn(['KEEP', 'ASK'])
  decision!: 'KEEP' | 'ASK';

  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Write your answer to the host' })
  @MaxLength(STAFF_TEXT_MAX)
  text!: string;
}

export class UpdateRestrictionDto {
  // Null: until lifted.
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Date)
  @IsDate()
  endsAt?: Date | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(STAFF_TEXT_MAX)
  note?: string | null;
}

export class ListRestrictionsQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(['waiting', 'active', 'ended', 'all'])
  state?: RestrictionFilter;

  @IsOptional()
  @IsUUID()
  streamId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  userId?: string;
}
