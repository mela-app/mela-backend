import { StreamVisibility } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** A live the host announces ahead - see docs/features/streams.md, "Scheduled lives". */
export class CreateScheduledLiveDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;

  // Who may see it (and its live). Omitted → everyone.
  @IsOptional()
  @IsEnum(StreamVisibility)
  visibility?: StreamVisibility;

  // An ISO date-time; at least a few minutes ahead, at most 30 days.
  @Type(() => Date)
  @IsDate()
  startsAt!: Date;
}
