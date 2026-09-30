import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
import { WatchTicketService } from './watch-ticket.service';
import { WebAuthController } from './web-auth.controller';

@Module({
  imports: [JwtModule.register({})], // secret/expiresIn passed per-call - see auth.service.ts
  controllers: [AuthController, WebAuthController],
  providers: [AuthService, JwtAuthGuard, OptionalJwtAuthGuard, WatchTicketService],
  // Re-export JwtModule too, not just the guards, so any module that imports
  // AuthModule can also construct them in its own injector scope.
  exports: [JwtAuthGuard, OptionalJwtAuthGuard, JwtModule, AuthService, WatchTicketService],
})
export class AuthModule {}
