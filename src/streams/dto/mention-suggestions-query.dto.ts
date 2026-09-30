import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** What's been typed after an `@` in a live's chat composer. */
export class MentionSuggestionsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(30)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit: number = 8;
}
