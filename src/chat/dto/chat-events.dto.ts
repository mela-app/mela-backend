import { IsInt, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator';
import { StreamRoomDto } from '../../realtime/dto/stream-room.dto';

/** One batch of likes: the app sends the taps of about a second at once. */
export const MAX_LIKES_PER_BATCH = 30;

export class ChatSendDto extends StreamRoomDto {
  // A generous cap on the raw text; the cleaned message is held to CHAT_MAX_LENGTH.
  // With a photo it's the caption, and may be left out.
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  text?: string;

  // Set by the app per message, so a resend after a lost answer isn't posted twice.
  @IsOptional()
  @IsString()
  @Length(1, 64)
  clientId?: string;

  // The host's photo, uploaded first (POST /streams/:id/chat/image-upload-url).
  @IsOptional()
  @IsString()
  @MaxLength(200)
  imageKey?: string;
}

export class LikeSendDto extends StreamRoomDto {
  @IsInt()
  @Min(1)
  @Max(MAX_LIKES_PER_BATCH)
  count!: number;
}

export class ChatDeleteDto extends StreamRoomDto {
  @IsUUID()
  messageId!: string;
}
