import { StreamLayout } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class UpdateStreamLayoutDto {
  @IsEnum(StreamLayout)
  layout!: StreamLayout;
}
