import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { VideoControlService } from './video-control.service';

// Each API instance picks up a switch made on another this often.
const SYNC_EVERY_MS = 15_000;
const METER_EVERY_MS = 60_000;
// Agora's usage report: exact minutes for the days it has counted.
const AGORA_REPORT_EVERY_MS = 30 * 60_000;

/** The timers behind VideoControlService: following a switch, counting Agora's minutes, Agora's own report. */
@Injectable()
export class VideoControlJobs {
  constructor(private readonly video: VideoControlService) {}

  @Interval(SYNC_EVERY_MS)
  sync(): Promise<void> {
    return this.video.sync();
  }

  @Interval(METER_EVERY_MS)
  meter(): Promise<void> {
    return this.video.meter();
  }

  @Interval(AGORA_REPORT_EVERY_MS)
  agoraReport(): Promise<void> {
    return this.video.reportFromAgora();
  }
}
