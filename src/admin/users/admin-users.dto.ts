import { AdminPermission, PlatformRole, UserStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PageQueryDto } from '../../common/pagination/page-query.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class AdminUsersQueryDto extends PageQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @IsOptional()
  @IsEnum(PlatformRole)
  role?: PlatformRole;

  @IsOptional()
  @IsIn(['createdAt', 'lastLoginAt', 'username'])
  sort?: 'createdAt' | 'lastLoginAt' | 'username';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';
}

export class SuspendUserDto {
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: 'Give a reason of at least 3 characters' })
  @MaxLength(500)
  reason!: string;
}

export class ChangeRoleDto {
  @IsEnum(PlatformRole)
  platformRole!: PlatformRole;

  // Required (at least one) when the new role is PLATFORM_MODERATOR.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsEnum(AdminPermission, { each: true })
  permissions?: AdminPermission[];
}

export class ChangePermissionsDto {
  @IsArray()
  @ArrayMaxSize(20)
  @IsEnum(AdminPermission, { each: true })
  permissions!: AdminPermission[];
}

// The app's own limits (SignupDto, UpdateProfileDto), plus a reason for the audit trail.
export class EditUserProfileDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: 'Use at least 3 characters' })
  @MaxLength(24, { message: 'Use at most 24 characters' })
  @Matches(/^[a-zA-Z0-9_]+$/, { message: 'Use letters, numbers and underscores only' })
  username?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Enter a display name' })
  @MaxLength(50)
  displayName?: string;

  // An empty string clears it.
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(280)
  bio?: string;

  @IsOptional()
  @IsBoolean()
  removeAvatar?: boolean;

  @Transform(trim)
  @IsString()
  @MinLength(3, { message: 'Give a reason of at least 3 characters' })
  @MaxLength(300)
  reason!: string;
}

export class CreateStaffDto {
  @Transform(trim)
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(254)
  email!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Enter a name' })
  @MaxLength(50)
  displayName!: string;

  @IsIn([PlatformRole.PLATFORM_MODERATOR, PlatformRole.SUPER_ADMIN])
  platformRole!: PlatformRole;

  // Required (at least one) for a platform moderator; a super admin has them all.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsEnum(AdminPermission, { each: true })
  permissions?: AdminPermission[];
}
