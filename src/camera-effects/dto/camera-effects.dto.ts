import { CameraEffectKind, MakeupAudience } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { CAMERA_EFFECT_UPLOADS, CameraEffectUploadType } from '../camera-effects.rules';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CameraEffectUploadUrlDto {
  @IsIn(Object.keys(CAMERA_EFFECT_UPLOADS))
  contentType!: CameraEffectUploadType;
}

export class ListCameraEffectsQueryDto {
  @IsOptional()
  @IsEnum(CameraEffectKind)
  kind?: CameraEffectKind;
}

export class UpdateCameraEffectDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  name?: string;

  // EFFECT: its tab in the app.
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  categoryId?: string | null;

  // MAKEUP: Female, Male, or both tabs.
  @IsOptional()
  @IsEnum(MakeupAudience)
  audience?: MakeupAudience;

  // The keys handed out by upload-url.
  @IsOptional()
  @IsString()
  @MaxLength(120)
  fileKey?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(200 * 1024 * 1024)
  fileSize?: number;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(120)
  thumbnailKey?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  imageKey?: string;

  // BEAUTY: the sliders (see camera-effects.rules.ts, BeautyControl).
  @IsOptional()
  @IsArray()
  controls?: unknown[];

  // EFFECT: shown under Trending.
  @IsOptional()
  @IsBoolean()
  featured?: boolean;

  @IsOptional()
  @IsBoolean()
  published?: boolean;

  @IsOptional()
  @IsInt()
  @Min(-1000)
  @Max(1000)
  sortOrder?: number;
}

export class CreateCameraEffectDto extends UpdateCameraEffectDto {
  @IsEnum(CameraEffectKind)
  kind!: CameraEffectKind;

  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Give it a name' })
  @MaxLength(40)
  declare name: string;
}

export class SaveCategoryDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(24)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(-1000)
  @Max(1000)
  sortOrder?: number;
}
