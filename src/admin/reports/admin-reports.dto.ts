import { ReportCaseStatus, ReportTargetType } from '@prisma/client';
import { IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PageQueryDto } from '../../common/pagination/page-query.dto';

export class AdminReportsQueryDto extends PageQueryDto {
  @IsOptional()
  @IsEnum(ReportCaseStatus)
  status: ReportCaseStatus = ReportCaseStatus.OPEN;

  @IsOptional()
  @IsEnum(ReportTargetType)
  type?: ReportTargetType;
}

export class ResolveReportDto {
  @IsIn([ReportCaseStatus.ACTIONED, ReportCaseStatus.DISMISSED])
  outcome!: 'ACTIONED' | 'DISMISSED';

  // For the team: what was done, or why nothing was. Reporters aren't shown it.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
