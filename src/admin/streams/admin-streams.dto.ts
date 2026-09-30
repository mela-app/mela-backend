import { ChatModerationStatus, StreamStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PageQueryDto } from '../../common/pagination/page-query.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class AdminStreamsQueryDto extends PageQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsEnum(StreamStatus)
  status?: StreamStatus;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  hostId?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @IsIn(['startedAt', 'peakViewerCount', 'likeCount'])
  sort?: 'startedAt' | 'peakViewerCount' | 'likeCount';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';
}

export class AdminChatLogQueryDto {
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @IsOptional()
  @IsEnum(ChatModerationStatus)
  status?: ChatModerationStatus;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;
}

export class LockStreamDto {
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: 'Give a reason of at least 3 characters' })
  @MaxLength(300)
  reason!: string;
}
