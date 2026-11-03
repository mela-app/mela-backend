import { ReportCaseStatus, ReportTargetType } from '@prisma/client';
import { IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PageQueryDto } from '../../common/pagination/page-query.dto';

export class AdminReportsQueryDto extends PageQueryDto {
  // ALL: every status - for one person's reports on their user page.
  @IsOptional()
  @IsIn([...Object.values(ReportCaseStatus), 'ALL'])
  status: ReportCaseStatus | 'ALL' = ReportCaseStatus.OPEN;

  // Cases about this account (it, its lives or its messages).
  @IsOptional()
  @IsUUID()
  reportedUserId?: string;

  // Cases this account reported.
  @IsOptional()
  @IsUUID()
  reporterId?: string;

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
