import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminPermission } from '@prisma/client';
import { AuditLogQueryDto } from '../../audit/audit-log-query.dto';
import { AuditService } from '../../audit/audit.service';
import {
  ADMIN_API_THROTTLE,
  AdminGuard,
  AdminPrincipal,
  CurrentAdmin,
  RequirePermission,
} from '../admin.guard';

@Controller('admin/audit-logs')
@UseGuards(AdminGuard)
@Throttle(ADMIN_API_THROTTLE)
@RequirePermission(AdminPermission.VIEW_AUDIT_LOG)
export class AdminAuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query() query: AuditLogQueryDto) {
    return this.audit.list(query);
  }

  @Get('catalog')
  catalog() {
    return this.audit.catalog();
  }

  // Exporting is itself on the record: it's how data leaves the console.
  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="audit-log.csv"')
  @Header('Cache-Control', 'no-store')
  async export(@CurrentAdmin() admin: AdminPrincipal, @Query() query: AuditLogQueryDto) {
    const csv = await this.audit.exportCsv(query);
    await this.audit.record({
      action: 'admin.audit_exported',
      actorId: admin.id,
      metadata: { filters: { ...query } },
    });
    // A BOM so spreadsheet apps read it as UTF-8.
    return `\uFEFF${csv}`;
  }
}
