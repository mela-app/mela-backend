import { createHash } from 'crypto';
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
    this.app =
      admin.apps.length > 0 && admin.apps[0] ? admin.apps[0] : admin.initializeApp({ credential });
  }

  async send(tokens: string[], message: PushMessage): Promise<{ invalidTokens: string[] }> {
    if (tokens.length === 0) return { invalidTokens: [] };
    const response = await admin
      .messaging(this.app)
      .sendEachForMulticast(fcmMulticast(tokens, message))
      .catch((error: unknown) => {
        this.logger.error(`FCM send failed: ${error}`);
        return null;
      });
    if (!response) return { invalidTokens: [] };

    const invalidTokens: string[] = [];
    const otherErrors = new Map<string, number>();
    response.responses.forEach((result, index) => {
      if (result.success) return;
      if (isInvalidTokenError(result.error?.code)) {
        invalidTokens.push(tokens[index]);
        return;
      }
      // Anything else is a push that never reached the phone: say so, or
      // it fails silently (as an over-long collapse key once did).
      const reason = `${result.error?.code ?? 'unknown'}: ${result.error?.message ?? ''}`.trim();
      otherErrors.set(reason, (otherErrors.get(reason) ?? 0) + 1);
    });
    for (const [reason, count] of otherErrors) {
      this.logger.warn(
        `FCM refused ${count} of ${tokens.length} push(es) (type=${message.data?.type ?? '-'}): ${reason}`,
      );
    }
    return { invalidTokens };
  }
}

/**
 * A collapse key FCM accepts on every platform: APNs refuses an
 * `apns-collapse-id` over 64 bytes - and FCM then refuses the whole message,
 * Android included. Ours (`<userId>:dm-<senderId>`, `<userId>:campaign:<id>`)
 * run to ~80, so they're hashed to 32 hex characters: the same key always
 * gives the same id, so pushes still replace each other as before.
 */
export function compactCollapseKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/** The multicast message for [tokens] (see compactCollapseKey). */
export function fcmMulticast(
  tokens: string[],
  message: PushMessage,
): admin.messaging.MulticastMessage {
  const collapse = message.collapseKey ? compactCollapseKey(message.collapseKey) : undefined;
  return {
    tokens,
    notification: { title: message.title, body: message.body },
    data: message.data,
    ...(collapse && {
      // Android shows one notification per tag; iOS groups by thread and
      // replaces by collapse id.
      android: { collapseKey: collapse, notification: { tag: collapse } },
      apns: {
        headers: { 'apns-collapse-id': collapse },
        payload: { aps: { threadId: collapse } },
      },
    }),
  };
}

function isInvalidTokenError(code: string | undefined): boolean {
  return (
    code === 'messaging/invalid-registration-token' ||
    code === 'messaging/registration-token-not-registered'
  );
}

function parseServiceAccount(raw: string): admin.ServiceAccount {
  const jsonText = raw.trim().startsWith('{') ? raw : readFileSync(raw, 'utf8');
  return JSON.parse(jsonText) as admin.ServiceAccount;
}
