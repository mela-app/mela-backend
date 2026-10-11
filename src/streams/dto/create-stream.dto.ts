import { StreamLayout, StreamVisibility } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateStreamDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;

  // Omitted → the column default (FULL).
  @IsOptional()
  @IsEnum(StreamLayout)
  layout?: StreamLayout;

  // Who may watch (docs/features/streams.md). Omitted → everyone (PUBLIC).
  @IsOptional()
  @IsEnum(StreamVisibility)
  visibility?: StreamVisibility;

  // Going live from one of the host's scheduled lives: its reminders turn
  // into "live now" notifications (docs/features/streams.md).
  @IsOptional()
  @IsUUID()
  scheduledLiveId?: string;
}
