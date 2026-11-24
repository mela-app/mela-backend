import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { AppCrashKind } from '@prisma/client';

/** One thing that went wrong on the phone (docs/features/app-crashes.md). */
export class CrashReportDto {
  @IsIn(Object.values(AppCrashKind))
  kind!: AppCrashKind;

  @IsBoolean()
  fatal!: boolean;

  // Longer text is cut, not refused: a crash report should never bounce.
  @IsString()
  @MaxLength(20_000)
  message!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200_000)
  stack?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  breadcrumbs?: string[];

  // When it happened on the phone; a crash is reported on the next launch.
  @IsOptional()
  @IsDateString()
  occurredAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceModel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  osVersion?: string;
}

export class CrashReportsDto {
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CrashReportDto)
  reports!: CrashReportDto[];
}
