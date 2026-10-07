import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  DATA_SET_KEYS,
  DataSetKey,
  KEEPABLE_ON_RESET,
  KeepableOnReset,
} from './admin-data.service';

export class ClearDataDto {
  @IsIn(DATA_SET_KEYS)
  dataSet!: DataSetKey;

  // Only what's older than this many days; all of it without one.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  olderThanDays?: number;

  // The signed-in admin's own, typed again.
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}

export class ResetDataDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsIn(Object.keys(KEEPABLE_ON_RESET), { each: true })
  keep?: KeepableOnReset[];
}
