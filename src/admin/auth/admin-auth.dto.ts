import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class AdminSignInDto {
  @Transform(trim)
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(1, { message: 'Enter your password' })
  @MaxLength(128)
  password!: string;
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(1, { message: 'Enter your current password' })
  @MaxLength(128)
  currentPassword!: string;

  // The full policy is checked in the service, with messages worth showing.
  @IsString()
  @MaxLength(128)
  newPassword!: string;
}

export class ChangeEmailDto {
  @Transform(trim)
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(1, { message: 'Enter your current password' })
  @MaxLength(128)
  currentPassword!: string;
}

export class UpdateAdminProfileDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Enter a display name' })
  @MaxLength(50)
  displayName!: string;
}
