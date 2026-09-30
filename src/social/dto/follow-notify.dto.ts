import { IsBoolean } from 'class-validator';

export class FollowNotifyDto {
  @IsBoolean()
  notifyOnLive!: boolean;
}
