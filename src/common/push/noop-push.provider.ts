import { Injectable, Logger } from '@nestjs/common';
import { PushMessage, PushProvider } from './push-provider.interface';

/**
 * The default PushProvider until a real Firebase project is provisioned
 * (plan §6.11 - "needed from the project owner", same as the Agora keys).
 * Every push is just logged, never actually sent - the rest of the app
 * (queueing, per-type settings, token pruning) runs and is fully testable
 * without one.
 */
@Injectable()
export class NoopPushProvider implements PushProvider {
  private readonly logger = new Logger(NoopPushProvider.name);
  private warned = false;

  async send(tokens: string[], message: PushMessage): Promise<{ invalidTokens: string[] }> {
    if (!this.warned) {
      this.logger.warn(
        'PUSH_PROVIDER is not set to "fcm" - pushes are logged, not sent. See docs/features/notifications.md.',
      );
      this.warned = true;
    }
    this.logger.debug(`(noop) push to ${tokens.length} device(s): ${message.title} - ${message.body}`);
    return { invalidTokens: [] };
  }
}
