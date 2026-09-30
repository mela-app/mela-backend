import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/** Who's watching right now - cursor is the last user id seen (plan §6.13). */
export class ViewersQueryDto {
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 30;
}
