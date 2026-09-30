import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export const CONVERSATION_HISTORY_DEFAULT_LIMIT = 50;

/** No cursor: the latest messages. `before`: older ones, for scrolling up. Oldest first either way. */
export class ConversationHistoryQueryDto {
  @IsOptional()
  @IsUUID()
  before?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = CONVERSATION_HISTORY_DEFAULT_LIMIT;
}
