import { IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class SendDirectMessageDto {
  // A generous cap on the raw text; the cleaned message is held to DIRECT_MESSAGE_MAX_LENGTH.
  // With a photo, its caption - maybe empty.
  @IsString()
  @MaxLength(4000)
  text!: string;

  // Set by the app per message, so a resend after a lost answer isn't stored twice.
  @IsOptional()
  @IsString()
  @Length(1, 64)
  clientId?: string;

  // A photo, as uploaded through `image-upload-url` (sending only; an edit changes the text).
  @IsOptional()
  @IsString()
  @MaxLength(200)
  imageKey?: string;
}
