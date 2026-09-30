import { AuditActorRole, AuditCategory } from '@prisma/client';
import { IsEnum, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';
import { PageQueryDto } from '../common/pagination/page-query.dto';

export class AuditLogQueryDto extends PageQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsEnum(AuditCategory)
  category?: AuditCategory;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  action?: string;

  @IsOptional()
  @IsEnum(AuditActorRole)
  actorRole?: AuditActorRole;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  actorId?: string;

  // Anything this user did, or that was done to them.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  userId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  targetType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  targetId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  streamId?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}
