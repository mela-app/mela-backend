import { readFileSync } from 'fs';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import { PushMessage, PushProvider } from './push-provider.interface';

/**
 * Real FCM delivery via the Firebase Admin SDK - selected by
 * `PUSH_PROVIDER=fcm`. Needs a Firebase project (plan §6.11 - "needed from
 * the project owner", same as the Agora keys): set
 * `FIREBASE_SERVICE_ACCOUNT_JSON` to either the raw service-account JSON or
 * a path to that file. Constructing this without it throws at boot, same as
 * `VIDEO_PROVIDER=livekit` without LiveKit credentials - fail fast, not on
 * the first push.
 */
@Injectable()
export class FcmPushProvider implements PushProvider {
  private readonly logger = new Logger(FcmPushProvider.name);
  private readonly app: admin.app.App;

  constructor(config: ConfigService) {
    const raw = config.get<string>('FIREBASE_SERVICE_ACCOUNT_JSON');
    if (!raw) {
      throw new Error(
        'PUSH_PROVIDER=fcm needs FIREBASE_SERVICE_ACCOUNT_JSON (a service account JSON string, or a path to one).',
      );
    }
    const credential = admin.credential.cert(parseServiceAccount(raw));
    this.app = admin.apps.length > 0 && admin.apps[0] ? admin.apps[0] : admin.initializeApp({ credential });
  }

  async send(tokens: string[], message: PushMessage): Promise<{ invalidTokens: string[] }> {
    if (tokens.length === 0) return { invalidTokens: [] };
    const response = await admin
      .messaging(this.app)
      .sendEachForMulticast({
        tokens,
        notification: { title: message.title, body: message.body },
        data: message.data,
      })
      .catch((error: unknown) => {
        this.logger.error(`FCM send failed: ${error}`);
        return null;
      });
    if (!response) return { invalidTokens: [] };

    const invalidTokens: string[] = [];
    response.responses.forEach((result, index) => {
      if (!result.success && isInvalidTokenError(result.error?.code)) invalidTokens.push(tokens[index]);
    });
    return { invalidTokens };
  }
}

function isInvalidTokenError(code: string | undefined): boolean {
  return code === 'messaging/invalid-registration-token' || code === 'messaging/registration-token-not-registered';
}

function parseServiceAccount(raw: string): admin.ServiceAccount {
  const jsonText = raw.trim().startsWith('{') ? raw : readFileSync(raw, 'utf8');
  return JSON.parse(jsonText) as admin.ServiceAccount;
}
