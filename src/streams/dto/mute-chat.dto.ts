import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class MuteChatDto {
  // Omitted: until the live ends (plan §6.7). A minute to a day otherwise.
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(24 * 60 * 60)
  durationSeconds?: number;
}
