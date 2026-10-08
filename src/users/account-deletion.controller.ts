import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AccountDeletionService } from './account-deletion.service';
import { DeleteAccountDto } from './dto/delete-account.dto';

/** The signed-in account deleting itself (docs/features/auth.md). */
@Controller('me')
@UseGuards(JwtAuthGuard)
export class AccountDeletionController {
  constructor(private readonly deletion: AccountDeletionService) {}

  // POST, not DELETE: some networks drop a DELETE's body, and this one carries the proof.
  @Post('account/delete')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  delete(@CurrentUser() user: AuthenticatedUser, @Body() dto: DeleteAccountDto) {
    return this.deletion.deleteOwn(user.id, dto);
  }
}
