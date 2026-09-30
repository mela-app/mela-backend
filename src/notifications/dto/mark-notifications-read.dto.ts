import { ArrayNotEmpty, IsArray, IsBoolean, IsOptional, IsUUID } from 'class-validator';

/** Exactly one of the two is expected; the service rejects neither being set. */
export class MarkNotificationsReadDto {
  @IsOptional()
  @IsBoolean()
  all?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('all', { each: true })
  ids?: string[];
}
