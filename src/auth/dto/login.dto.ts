import { SessionPlatform } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class LoginDto {
  @IsString()
  usernameOrEmail!: string;

  @IsString()
  password!: string;

  @IsOptional()
  @IsEnum(SessionPlatform)
  platform?: SessionPlatform;
}
