import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LegalController, MyLegalController } from './legal.controller';
import { LegalPagesController } from './legal-pages.controller';
import { LegalService } from './legal.service';

/**
 * The 18+ age check and the Terms/Privacy acceptance (docs/features/legal.md).
 * Sign-up checks both itself (legal-rules.ts, used by AuthModule); this
 * module serves the documents and catches up accounts made before them.
 */
@Module({
  // AuthModule: the JWT guard.
  imports: [AuthModule],
  controllers: [LegalController, MyLegalController, LegalPagesController],
  providers: [LegalService],
})
export class LegalModule {}
