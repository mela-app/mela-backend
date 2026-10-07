import { ReportReason, ReportTargetType } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateReportDto {
  @IsEnum(ReportTargetType)
  targetType!: ReportTargetType;

  @IsUUID('all')
  targetId!: string;

  @IsEnum(ReportReason)
  reason!: ReportReason;

  // Required for OTHER.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  details?: string;

  // Block whoever it's about at the same time.
  @IsOptional()
  @IsBoolean()
  block?: boolean;
}
