import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export const CHAT_HISTORY_DEFAULT_LIMIT = 50;

/**
 * No cursor: the latest messages. `before`: older ones, for scrolling up.
 * `after`: what came since, for a reconnect. Messages come oldest first.
 */
export class ChatHistoryQueryDto {
  @IsOptional()
  @IsUUID()
  before?: string;

  @IsOptional()
  @IsUUID()
  after?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = CHAT_HISTORY_DEFAULT_LIMIT;
}
