import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { AppCrashKind } from '@prisma/client';
import { PageQueryDto } from '../../common/pagination/page-query.dto';

/** The Crashes page's filters: the last [days], and optionally one kind, version or only fatal ones. */
export class CrashGroupsQueryDto extends PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days: number = 7;

  @IsOptional()
  @IsIn(Object.values(AppCrashKind))
  kind?: AppCrashKind;

  @IsOptional()
  @IsString()
  @Matches(/^\d{1,4}(\.\d{1,4}){0,3}$/)
  appVersion?: string;

  // Only what closed the app.
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  fatal?: boolean;
}

/** An export: the page's filters, or one crash ([signature]). */
export class CrashExportQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days: number = 7;

  @IsOptional()
  @IsIn(Object.values(AppCrashKind))
  kind?: AppCrashKind;

  @IsOptional()
  @IsString()
  @Matches(/^\d{1,4}(\.\d{1,4}){0,3}$/)
  appVersion?: string;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  fatal?: boolean;

  @IsOptional()
  @Matches(/^[0-9a-f]{16}$/)
  signature?: string;
}

export class CrashReportsQueryDto extends PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days: number = 7;
}
