import { IsIn } from 'class-validator';
import { CHAT_IMAGE_TYPES, ChatImageType } from '../chat-images';

export class ChatImageUploadUrlDto {
  @IsIn(Object.keys(CHAT_IMAGE_TYPES))
  contentType!: ChatImageType;
}
