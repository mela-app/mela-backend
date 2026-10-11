import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AcceptLegalDto } from './dto/accept-legal.dto';
import { LegalService } from './legal.service';

/** `GET /v1/legal` - the Terms/Privacy version in force and where, for the sign-up form. */
@Controller('legal')
export class LegalController {
  constructor(private readonly legal: LegalService) {}

  @Get()
  info() {
    return this.legal.info();
  }
}

/** This account's acceptance - `GET` whether it's needed, `POST` to accept (docs/features/legal.md). */
@Controller('me/legal')
@UseGuards(JwtAuthGuard)
export class MyLegalController {
  constructor(private readonly legal: LegalService) {}

  @Get()
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.legal.status(user.id);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  accept(@CurrentUser() user: AuthenticatedUser, @Body() dto: AcceptLegalDto) {
    return this.legal.accept(user.id, dto, dto.platform);
  }
}
