import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { CampaignsService } from './campaigns.service';

/** Scheduled campaigns go out within 30 s of their time (kept apart: @nestjs/schedule doesn't load under Jest). */
@Injectable()
export class CampaignsJobs {
  constructor(private readonly campaigns: CampaignsService) {}

  @Interval(30_000)
  sendDue(): Promise<void> {
    return this.campaigns.sendDue();
  }
}
