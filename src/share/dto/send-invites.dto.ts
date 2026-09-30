import { ArrayMaxSize, ArrayNotEmpty, ArrayUnique, IsArray, IsUUID } from 'class-validator';

/** "Send to friends" (plan §6.12) - the service still re-checks friendship server-side. */
export class SendInvitesDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  userIds!: string[];
}
