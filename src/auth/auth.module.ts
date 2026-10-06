import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AccountController } from './account.controller';
import { AccountPasswordService } from './account-password.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { FirebaseIdentityVerifier, IdentityVerifier } from './identity/firebase-identity.verifier';
import { IdentitySignInService } from './identity/identity-sign-in.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
import { WatchTicketService } from './watch-ticket.service';
import { WebAuthController } from './web-auth.controller';

@Module({
  imports: [JwtModule.register({})], // secret/expiresIn passed per-call - see auth.service.ts
  controllers: [AuthController, WebAuthController, AccountController],
  providers: [
    AuthService,
    AccountPasswordService,
    IdentitySignInService,
    { provide: IdentityVerifier, useClass: FirebaseIdentityVerifier },
    JwtAuthGuard,
    OptionalJwtAuthGuard,
    WatchTicketService,
  ],
  // Re-export JwtModule too, not just the guards, so any module that imports
  // AuthModule can also construct them in its own injector scope.
  exports: [JwtAuthGuard, OptionalJwtAuthGuard, JwtModule, AuthService, WatchTicketService],
})
export class AuthModule {}
