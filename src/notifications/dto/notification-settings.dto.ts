import { IsBoolean, IsOptional } from 'class-validator';

/** Per-type push toggle (plan §6.11) - in-app delivery is never optional, only push is. */
export class UpdateNotificationSettingsDto {
  @IsOptional()
  @IsBoolean()
  pushStreamStarted?: boolean;

  @IsOptional()
  @IsBoolean()
  pushNewFollower?: boolean;

  @IsOptional()
  @IsBoolean()
  pushStreamInvite?: boolean;

  @IsOptional()
  @IsBoolean()
  pushModeratorGranted?: boolean;

  @IsOptional()
  @IsBoolean()
  pushGuestInvite?: boolean;
}
