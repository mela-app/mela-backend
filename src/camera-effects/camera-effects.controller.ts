import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CameraEffectsService } from './camera-effects.service';

/**
 * `GET /v1/camera-effects` - what hosts can put on their camera: effects by
 * category, makeup, backgrounds, the beauty rig, and the AR engine's key
 * (docs/features/camera-effects.md).
 */
@Controller('camera-effects')
@UseGuards(JwtAuthGuard)
export class CameraEffectsController {
  constructor(private readonly effects: CameraEffectsService) {}

  @Get()
  catalog() {
    return this.effects.catalog();
  }
}
