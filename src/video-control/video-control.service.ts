import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { StreamGuestStatus, StreamStatus, VideoProviderKind } from '@prisma/client';
import {
  DomainEvents,
  VideoProviderSwitchedPayload,
  VideoSettingsChangedPayload,
} from '../common/events/domain-events';
import { LivePresenceService } from '../common/presence/live-presence.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { VideoProviderRegistry } from '../common/video-provider/video-provider.registry';
import { AgoraUsageClient, AgoraUsageError } from './agora-usage.client';
import {
  DEFAULT_AGORA_FREE_MINUTES,
  DEFAULT_AUTO_SWITCH_BELOW,
  dayKey,
  dayStartOf,
  nextPeriodStart,
  periodStartOf,
  periodUsage,
  quotaView,
} from './video-quota';

const SETTINGS_ID = 1;

// One fetch of Agora's report at a time, across instances.
const REPORT_LOCK_SECONDS = 60;

export interface Settings {
  activeProvider: VideoProviderKind;
  agoraFreeMinutes: number;
  autoSwitch: boolean;
  autoSwitchBelowMinutes: number;
  switchBackOnReset: boolean;
  autoSwitchedAt: Date | null;
  agoraReportedAt: Date | null;
  agoraReportError: string | null;
}

export interface SettingsInput {
  agoraFreeMinutes?: number;
  autoSwitch?: boolean;
  autoSwitchBelowMinutes?: number;
  switchBackOnReset?: boolean;
}

export interface StaffActor {
  id: string;
}

/**
 * Where new lives go, and Agora's free minutes (docs/features/video-provider.md).
 *
 * Staff switch the provider from the console - saved, so every API instance
 * and every restart follows it (VIDEO_PROVIDER is only the default). A live
 * that's running keeps the provider it started on: switching never cuts a
 * host off; a host with the preview open is moved over by the app when they
 * go live.
 *
 * Agora bills by the participant-minute past its free monthly allowance. Its
 * own usage report (AgoraUsageClient, every 30 min) gives the exact minutes
 * for the days it has finished; for today - not reported yet - Mela counts
 * them itself: each minute, everyone connected to a live on Agora (host,
 * guests on stage, viewers). Optionally, new lives move to LiveKit by
 * themselves when the free minutes run low, and back when the month restarts.
 */
@Injectable()
export class VideoControlService implements OnModuleInit {
  private readonly logger = new Logger(VideoControlService.name);
  private metering = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: VideoProviderRegistry,
    private readonly presence: LivePresenceService,
    private readonly redis: RedisService,
    private readonly events: EventEmitter2,
    private readonly agoraUsage: AgoraUsageClient,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.sync();
  }

  /** The saved choice onto this instance's registry - set by another instance, or before a restart. */
  async sync(): Promise<void> {
    try {
      const saved = await this.prisma.videoSettings.findUnique({
        where: { id: SETTINGS_ID },
        select: { activeProvider: true },
      });
      const kind = saved?.activeProvider;
      if (kind && kind !== this.registry.activeProvider) {
        if (this.registry.isConfigured(kind)) this.registry.setActive(kind);
        else
          this.logger.warn(
            `Saved provider ${kind} isn't set up here - new lives stay on ${this.registry.activeProvider}`,
          );
      }
    } catch (error) {
      this.logger.warn(`Could not read the video settings: ${error}`);
    }
  }

  async settings(): Promise<Settings> {
    const saved = await this.prisma.videoSettings.findUnique({ where: { id: SETTINGS_ID } });
    return (
      saved ?? {
        activeProvider: this.registry.activeProvider,
        agoraFreeMinutes: DEFAULT_AGORA_FREE_MINUTES,
        autoSwitch: false,
        autoSwitchBelowMinutes: DEFAULT_AUTO_SWITCH_BELOW,
        switchBackOnReset: true,
        autoSwitchedAt: null,
        agoraReportedAt: null,
        agoraReportError: null,
      }
    );
  }

  /** Everything the console's Video page shows. */
  async overview(now: Date = new Date()) {
    const settings = await this.settings();
    const periodStart = periodStartOf(now);
    const resetsAt = nextPeriodStart(now);
    const [usage, live, burn, switches] = await Promise.all([
      this.agoraUsageIn(periodStart),
      this.prisma.stream.groupBy({
        by: ['videoProvider'],
        where: { status: StreamStatus.LIVE },
        _count: { _all: true },
      }),
      this.participantsOn(VideoProviderKind.AGORA),
      this.prisma.videoProviderSwitch.findMany({
        orderBy: { createdAt: 'desc' },
        take: 15,
        select: {
          id: true,
          from: true,
          to: true,
          reason: true,
          createdAt: true,
          actor: { select: { id: true, username: true, displayName: true } },
        },
      }),
    ]);
    const liveOn = (kind: VideoProviderKind) =>
      live.find((group) => group.videoProvider === kind)?._count._all ?? 0;
    return {
      activeProvider: this.registry.activeProvider,
      providers: Object.values(VideoProviderKind).map((kind) => ({
        kind,
        configured: this.registry.isConfigured(kind),
        liveNow: liveOn(kind),
      })),
      agora: {
        ...quotaView(settings.agoraFreeMinutes, usage.usedMinutes, burn, now, resetsAt),
        reportedMinutes: usage.reportedMinutes,
        pendingMinutes: usage.pendingMinutes,
        reportedThrough: usage.reportedThrough,
        report: {
          configured: this.agoraUsage.isConfigured,
          fetchedAt: settings.agoraReportedAt,
          error: settings.agoraReportError,
        },
        periodStart,
        resetsAt,
      },
      settings: {
        agoraFreeMinutes: settings.agoraFreeMinutes,
        autoSwitch: settings.autoSwitch,
        autoSwitchBelowMinutes: settings.autoSwitchBelowMinutes,
        switchBackOnReset: settings.switchBackOnReset,
        autoSwitchedAt: settings.autoSwitchedAt,
      },
      switches,
    };
  }

  /**
   * New lives go to [to] from now on. Running lives stay where they are; the
   * other instances follow within 15 s (VideoControlJobs). [staff] null: automatic.
   */
  async switchTo(staff: StaffActor | null, to: VideoProviderKind, reason: string): Promise<void> {
    if (!this.registry.isConfigured(to)) {
      throw new BadRequestException(
        `${providerName(to)} isn't set up on the server - its credentials are missing.`,
      );
    }
    const from = this.registry.activeProvider;
    if (from === to) throw new BadRequestException(`New lives already go to ${providerName(to)}.`);
    const settings = await this.settings();
    // Remembered only when the automatic switch leaves Agora - so the reset brings it back.
    const autoSwitchedAt = !staff && to === VideoProviderKind.LIVEKIT ? new Date() : null;
    await this.prisma.$transaction([
      this.prisma.videoSettings.upsert({
        where: { id: SETTINGS_ID },
        create: {
          ...this.createFrom(settings),
          activeProvider: to,
          autoSwitchedAt,
          updatedById: staff?.id ?? null,
        },
        update: { activeProvider: to, autoSwitchedAt, updatedById: staff?.id ?? null },
      }),
      this.prisma.videoProviderSwitch.create({
        data: { from, to, actorId: staff?.id ?? null, reason },
      }),
    ]);
    this.registry.setActive(to);
    this.events.emit(DomainEvents.VideoProviderSwitched, {
      from,
      to,
      actorId: staff?.id ?? null,
      reason,
    } satisfies VideoProviderSwitchedPayload);
  }

  async updateSettings(staff: StaffActor, input: SettingsInput) {
    const fields = Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key);
    if (fields.length === 0) return this.overview();
    const settings = await this.settings();
    await this.prisma.videoSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { ...this.createFrom(settings), ...input, updatedById: staff.id },
      update: { ...input, updatedById: staff.id },
    });
    this.events.emit(DomainEvents.VideoSettingsChanged, {
      actorId: staff.id,
      fields,
    } satisfies VideoSettingsChangedPayload);
    return this.overview();
  }

  /**
   * Agora's own usage report for this month (days it has counted so far),
   * saved per day. Every 30 min (VideoControlJobs) on one instance, and on
   * the console's Refresh. Does nothing without AGORA_CUSTOMER_ID/SECRET;
   * a failure is kept for the console and Mela's count carries on.
   */
  async reportFromAgora(now: Date = new Date()): Promise<void> {
    if (!this.agoraUsage.isConfigured) return;
    const free = await this.redis
      .getClient()
      .set('video-usage:agora-report', '1', 'EX', REPORT_LOCK_SECONDS, 'NX');
    if (free !== 'OK') return;
    let error: string | null = null;
    try {
      const daily = await this.agoraUsage.dailyMinutes(
        dayKey(periodStartOf(now)),
        dayKey(dayStartOf(now)),
      );
      await this.prisma.$transaction(
        [...daily].map(([day, minutes]) => {
          const at = new Date(`${day}T00:00:00Z`);
          return this.prisma.videoUsageDay.upsert({
            where: { provider_day: { provider: VideoProviderKind.AGORA, day: at } },
            create: {
              provider: VideoProviderKind.AGORA,
              day: at,
              reportedMinutes: minutes,
              reportedAt: now,
            },
            update: { reportedMinutes: minutes, reportedAt: now },
          });
        }),
      );
    } catch (failure) {
      error =
        failure instanceof AgoraUsageError
          ? failure.message
          : "Agora's usage report could not be saved.";
      this.logger.warn(`Agora usage report: ${failure}`);
    } finally {
      await this.redis.getClient().del('video-usage:agora-report');
    }
    const settings = await this.settings();
    await this.prisma.videoSettings.upsert({
      where: { id: SETTINGS_ID },
      create: {
        ...this.createFrom(settings),
        agoraReportedAt: error ? settings.agoraReportedAt : now,
        agoraReportError: error,
      },
      update: error
        ? { agoraReportError: error }
        : { agoraReportedAt: now, agoraReportError: null },
    });
  }

  /**
   * Once a minute, on one instance only (a key per minute): adds everyone
   * connected to a live on Agora to today's count - then switches new lives
   * automatically if the settings say so.
   */
  async meter(now: Date = new Date()): Promise<void> {
    if (this.metering) return;
    this.metering = true;
    try {
      const minute = Math.floor(now.getTime() / 60_000);
      const first = await this.redis
        .getClient()
        .set(`video-usage:minute:${minute}`, '1', 'EX', 180, 'NX');
      if (first !== 'OK') return;
      const settings = await this.settings();
      const periodStart = periodStartOf(now);
      const participants = await this.participantsOn(VideoProviderKind.AGORA);
      let used: number | null = null;
      if (participants > 0) {
        const day = dayStartOf(now);
        await this.prisma.videoUsageDay.upsert({
          where: { provider_day: { provider: VideoProviderKind.AGORA, day } },
          create: { provider: VideoProviderKind.AGORA, day, countedMinutes: participants },
          update: { countedMinutes: { increment: participants } },
        });
        used = (await this.agoraUsageIn(periodStart)).usedMinutes;
      }
      await this.autoSwitch(settings, periodStart, used);
    } catch (error) {
      this.logger.warn(`Video usage could not be counted: ${error}`);
    } finally {
      this.metering = false;
    }
  }

  private async autoSwitch(
    settings: Settings,
    periodStart: Date,
    used: number | null,
  ): Promise<void> {
    const active = this.registry.activeProvider;
    // A new month: back to Agora, if it was the automatic switch that left it.
    if (
      settings.switchBackOnReset &&
      settings.autoSwitchedAt &&
      settings.autoSwitchedAt.getTime() < periodStart.getTime() &&
      active === VideoProviderKind.LIVEKIT &&
      this.registry.isConfigured(VideoProviderKind.AGORA)
    ) {
      await this.switchTo(null, VideoProviderKind.AGORA, "Agora's free minutes restarted");
      return;
    }
    if (
      settings.autoSwitch &&
      used !== null &&
      active === VideoProviderKind.AGORA &&
      settings.agoraFreeMinutes - used <= settings.autoSwitchBelowMinutes &&
      this.registry.isConfigured(VideoProviderKind.LIVEKIT)
    ) {
      await this.switchTo(
        null,
        VideoProviderKind.LIVEKIT,
        `Agora's free minutes ran low (${Math.max(0, settings.agoraFreeMinutes - used)} left)`,
      );
    }
  }

  private async agoraUsageIn(periodStart: Date) {
    const days = await this.prisma.videoUsageDay.findMany({
      where: { provider: VideoProviderKind.AGORA, day: { gte: periodStart } },
      select: { day: true, countedMinutes: true, reportedMinutes: true, reportedAt: true },
    });
    return periodUsage(days);
  }

  /** Everyone connected to a live on [kind] right now: hosts, guests on stage, viewers. */
  private async participantsOn(kind: VideoProviderKind): Promise<number> {
    const lives = await this.prisma.stream.findMany({
      where: { status: StreamStatus.LIVE, videoProvider: kind },
      select: { id: true },
    });
    if (lives.length === 0) return 0;
    const ids = lives.map((live) => live.id);
    const [viewers, guests] = await Promise.all([
      this.presence.viewerCounts(ids).catch(() => new Map<string, number>()),
      this.prisma.streamGuest.count({
        where: { streamId: { in: ids }, status: StreamGuestStatus.ACTIVE },
      }),
    ]);
    let viewing = 0;
    for (const count of viewers.values()) viewing += count;
    return lives.length + guests + viewing;
  }

  private createFrom(settings: Settings) {
    return {
      id: SETTINGS_ID,
      activeProvider: settings.activeProvider,
      agoraFreeMinutes: settings.agoraFreeMinutes,
      autoSwitch: settings.autoSwitch,
      autoSwitchBelowMinutes: settings.autoSwitchBelowMinutes,
      switchBackOnReset: settings.switchBackOnReset,
    };
  }
}

export function providerName(kind: VideoProviderKind): string {
  return kind === VideoProviderKind.AGORA ? 'Agora' : 'LiveKit';
}
