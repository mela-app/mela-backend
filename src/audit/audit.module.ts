import { Module } from '@nestjs/common';
import { AuditEventsListener } from './audit-events.listener';
import { AuditService } from './audit.service';

// Nothing imports this to record: every entry comes from a domain event.
@Module({
  providers: [AuditService, AuditEventsListener],
  exports: [AuditService],
})
export class AuditModule {}
