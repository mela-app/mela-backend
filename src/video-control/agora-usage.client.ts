import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const API = 'https://api.agora.io';
const TIMEOUT_MS = 15_000;

interface ProjectsResponse {
  projects?: Array<{ id: string }>;
}

interface UsageResponse {
  // date: a UTC day - a Unix timestamp or an ISO string, depending on the doc version.
  usages?: Array<{ date: number | string; usage?: Record<string, unknown> }>;
}

/** A failed request to Agora, worded for the console. */
export class AgoraUsageError extends Error {}

/**
 * Agora's own usage report (its Console RESTful API: GET /dev/v1/projects,
 * GET /dev/v3/usage), signed in with the account's Customer ID and Secret
 * (Agora console > RESTful API) - what Agora bills, not Mela's estimate.
 */
@Injectable()
export class AgoraUsageClient {
  private readonly authorization: string | null;

  constructor(config: ConfigService) {
    const id = config.get<string>('AGORA_CUSTOMER_ID')?.trim();
    const secret = config.get<string>('AGORA_CUSTOMER_SECRET')?.trim();
    this.authorization =
      id && secret ? `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` : null;
  }

  get isConfigured(): boolean {
    return this.authorization !== null;
  }

  /**
   * Minutes used each UTC day from [from] to [to] (YYYY-MM-DD, both
   * included), audio and video, summed over every project of the account -
   * the free minutes are the account's, not a project's.
   */
  async dailyMinutes(from: string, to: string): Promise<Map<string, number>> {
    const { projects = [] } = await this.get<ProjectsResponse>('/dev/v1/projects');
    const seconds = new Map<string, number>();
    for (const project of projects) {
      const query = new URLSearchParams({
        project_id: project.id,
        from_date: from,
        to_date: to,
        business: 'default',
      });
      const { usages = [] } = await this.get<UsageResponse>(`/dev/v3/usage?${query}`);
      for (const entry of usages) {
        const day = dayOf(entry.date);
        if (!day) continue;
        let total = 0;
        for (const value of Object.values(entry.usage ?? {})) {
          if (typeof value === 'number' && Number.isFinite(value)) total += value;
        }
        seconds.set(day, (seconds.get(day) ?? 0) + total);
      }
    }
    return new Map([...seconds].map(([day, total]) => [day, Math.round(total / 60)]));
  }

  private async get<T>(path: string): Promise<T> {
    if (!this.authorization) throw new AgoraUsageError('AGORA_CUSTOMER_ID / SECRET are not set.');
    let response: Response;
    try {
      response = await fetch(`${API}${path}`, {
        headers: { Authorization: this.authorization, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new AgoraUsageError(`Couldn't reach Agora (${(error as Error).message}).`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new AgoraUsageError(
        'Agora refused the Customer ID / Secret - check them in Agora console > RESTful API.',
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AgoraUsageError(
        `Agora answered ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}.`,
      );
    }
    return (await response.json()) as T;
  }
}

/** YYYY-MM-DD (UTC) of Agora's date: seconds or milliseconds since 1970, or an ISO string. */
export function dayOf(date: number | string): string | null {
  const at = typeof date === 'number' ? new Date(date < 1e12 ? date * 1000 : date) : new Date(date);
  return Number.isNaN(at.getTime()) ? null : at.toISOString().slice(0, 10);
}
