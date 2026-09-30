import { IsIn } from 'class-validator';

const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png'] as const;

export class AvatarUploadUrlDto {
  @IsIn(ALLOWED_CONTENT_TYPES)
  contentType!: (typeof ALLOWED_CONTENT_TYPES)[number];
}
