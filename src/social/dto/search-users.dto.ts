import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Prefix match on username/display name, paged by the last username seen. */
export class SearchUsersQueryDto {
  @IsString()
  @MaxLength(50)
  q!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 20;
}
