import { ModeratorCapability } from '@prisma/client';
import { ArrayMinSize, ArrayUnique, IsArray, IsEnum, IsUUID } from 'class-validator';

/** Grants a moderator for this one stream (plan §6.9) - not the host's whole channel. */
export class GrantModeratorDto {
  @IsUUID()
  userId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsEnum(ModeratorCapability, { each: true })
  capabilities!: ModeratorCapability[];
}
