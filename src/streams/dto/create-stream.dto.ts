import { StreamLayout } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateStreamDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;

  // Omitted → the column default (FULL).
  @IsOptional()
  @IsEnum(StreamLayout)
  layout?: StreamLayout;
}
