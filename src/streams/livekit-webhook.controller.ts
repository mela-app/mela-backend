import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Req,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { VideoProviderKind } from '@prisma/client';
import type { Request } from 'express';
import { VideoProviderRegistry } from '../common/video-provider/video-provider.registry';
import { StreamsService } from './streams.service';

/**
 * Where the self-hosted LiveKit server reports its rooms (`webhook.urls` in
 * infra/livekit/livekit.yaml): `POST /v1/livekit/webhook`, signed with the
 * API key. The body arrives raw (main.ts) - the signature covers its exact
 * bytes. See docs/features/video-provider.md, "Weak networks".
 */
@Controller('livekit')
export class LiveKitWebhookController {
  constructor(
    private readonly videoProviders: VideoProviderRegistry,
    private readonly streams: StreamsService,
  ) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  // LiveKit itself, on this server: several events per second in a busy live.
  @SkipThrottle()
  async receive(@Req() request: Request, @Headers('authorization') authorization?: string) {
    const provider = this.videoProviders.get(VideoProviderKind.LIVEKIT);
    if (!provider.receiveWebhook) throw new NotFoundException();
    const body = Buffer.isBuffer(request.body) ? request.body.toString('utf8') : '';
    const event = await provider.receiveWebhook(body, authorization);
    if (event) await this.streams.onMediaRoomEvent(event);
    return { ok: true };
  }
}
