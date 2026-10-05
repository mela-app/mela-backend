import { AppPlatform } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, Max, Min } from 'class-validator';

export class AppUpdateQueryDto {
  @IsEnum(AppPlatform)
  platform!: AppPlatform;

  // The installed build: the number after + in pubspec.yaml.
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  build!: number;
}
