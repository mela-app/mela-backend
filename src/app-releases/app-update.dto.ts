import { AppPlatform } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { VERSION_PATTERN } from './app-release.rules';

export class AppUpdateQueryDto {
  @IsEnum(AppPlatform)
  platform!: AppPlatform;

  // The installed version (1.2.0) - what releases are compared with.
  @IsOptional()
  @Matches(VERSION_PATTERN)
  version?: string;

  // The installed build: the number after + in pubspec.yaml. Only apps from
  // before versions were compared send nothing else.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  build?: number;
}
