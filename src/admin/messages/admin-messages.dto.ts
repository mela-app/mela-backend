import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PageQueryDto } from '../../common/pagination/page-query.dto';

/** The console always names the stretch of time it looks at - a day, today unless picked. */
export class AdminConversationsQueryDto extends PageQueryDto {
  @IsISO8601()
  from!: string;

  @IsISO8601()
  to!: string;

  // Either person, by username or display name.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  userId?: string;
}

export class AdminTranscriptQueryDto {
  @IsISO8601()
  from!: string;

  @IsISO8601()
  to!: string;

  // The last message already shown; the next page starts after it.
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 100;
}
