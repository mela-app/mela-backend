import { ModeratorCapability } from '@prisma/client';
import { ArrayMinSize, ArrayUnique, IsArray, IsEnum } from 'class-validator';

export class UpdateModeratorCapabilitiesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsEnum(ModeratorCapability, { each: true })
  capabilities!: ModeratorCapability[];
}
