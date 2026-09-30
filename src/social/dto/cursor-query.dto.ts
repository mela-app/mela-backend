import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/** Followers/following/friends: newest first, paged by `Follow.id` (time-ordered). */
export class CursorQueryDto {
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 30;
}
