import { IsUUID } from 'class-validator';

/** The host invites someone on stage - the reverse direction of a guest request (plan §6.5). */
export class InviteGuestDto {
  @IsUUID()
  userId!: string;
}
