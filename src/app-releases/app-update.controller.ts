import { Controller, Get, Query } from '@nestjs/common';
import { AppUpdateQueryDto } from './app-update.dto';
import { AppReleasesService } from './app-releases.service';

@Controller('app')
export class AppUpdateController {
  constructor(private readonly releases: AppReleasesService) {}

  // Asked by every app on launch and when it comes back - signed in or not.
  @Get('update')
  check(@Query() query: AppUpdateQueryDto) {
    return this.releases.check(query.platform, query.build);
  }
}
