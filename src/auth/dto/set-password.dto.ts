import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class SetPasswordDto {
  @IsString()
  @MinLength(8, { message: 'Use at least 8 characters for your password' })
  @MaxLength(72) // argon2-safe upper bound
  newPassword!: string;

  @IsOptional()
  @IsString()
  @MaxLength(72)
  currentPassword?: string;

  // A fresh Google sign-in instead of the current password.
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  idToken?: string;
}
