import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ListStreamsQueryDto {
  // The public list only ever serves lives; history is admin-only (plan §6.8).
  // Still accepted so clients that send ?status=live keep working.
  @IsOptional()
  @IsIn(['live'])
  status?: 'live';

  // Lives from people the caller follows (plan §6.10) - requires auth.
  @IsOptional()
  @IsIn(['following'])
  feed?: 'following';

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() || undefined : value))
  @IsString()
  @MaxLength(40)
  category?: string;

  // Search: part of a live's title, or its host's name or username.
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() || undefined : value))
  @IsString()
  @MaxLength(60)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 20;
}
