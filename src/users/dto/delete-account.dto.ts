import { IsOptional, IsString, MaxLength } from 'class-validator';

export class DeleteAccountDto {
  @IsOptional()
  @IsString()
  @MaxLength(72)
  currentPassword?: string;

  // A fresh Google sign-in instead of the password.
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  idToken?: string;
}
