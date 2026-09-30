import { IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class SendDirectMessageDto {
  // A generous cap on the raw text; the cleaned message is held to DIRECT_MESSAGE_MAX_LENGTH.
  @IsString()
  @MaxLength(4000)
  text!: string;

  // Set by the app per message, so a resend after a lost answer isn't stored twice.
  @IsOptional()
  @IsString()
  @Length(1, 64)
  clientId?: string;
}
