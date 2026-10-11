import { IsOptional, IsString, Matches, MinLength } from 'class-validator';

export class PushTokenDto {
  @IsString()
  @MinLength(10)
  token!: string;

  // The app install (random per install): every account signed in on it
  // shares the token. Older apps don't send it.
  @IsOptional()
  @Matches(/^[A-Za-z0-9-]{16,64}$/)
  installationId?: string;
}
