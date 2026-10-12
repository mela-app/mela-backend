import { StreamLayout, StreamVisibility } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateStreamDto {
  // Not asked any more (client request, 2026-10) - older apps still send it.
  // A live from a scheduled live takes that one's title.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  title?: string;

  // Not asked any more either; older apps still send it.
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
