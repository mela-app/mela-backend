import { SessionPlatform } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { USERNAME_PATTERN, USERNAME_RULE } from '../identity/usernames';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** A Firebase ID token: from Google sign-in, or an email whose link was tapped. */
export class IdentityTokenDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  idToken!: string;

  @IsOptional()
  @IsEnum(SessionPlatform)
  platform?: SessionPlatform;
}

export class IdentitySignupDto extends IdentityTokenDto {
  @IsString()
  @Matches(USERNAME_PATTERN, { message: USERNAME_RULE })
  username!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Enter your name' })
  @MaxLength(50)
  displayName!: string;

  // An email sign-up's own password; an account made with Google has none.
  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'Use at least 8 characters for your password' })
  @MaxLength(72) // argon2-safe upper bound
  password?: string;
}

export class UsernameQueryDto {
  @IsString()
  @Matches(USERNAME_PATTERN, { message: USERNAME_RULE })
  username!: string;
}
