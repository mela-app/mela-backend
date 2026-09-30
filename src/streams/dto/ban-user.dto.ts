import { RoomBanScope } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class BanUserDto {
  @IsEnum(RoomBanScope)
  scope!: RoomBanScope;
}
