import { ArrayMaxSize, ArrayNotEmpty, ArrayUnique, IsArray, IsUUID } from 'class-validator';

/** "Send to friends" (plan §6.12) - friends or anyone else; the service re-checks blocks and who may watch. */
export class SendInvitesDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  userIds!: string[];
}
