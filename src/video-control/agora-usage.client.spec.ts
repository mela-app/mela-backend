import { ConfigService } from '@nestjs/config';
import { AgoraUsageClient, AgoraUsageError, dayOf } from './agora-usage.client';

const client = (values: Record<string, string> = {}) =>
  new AgoraUsageClient({ get: (key: string) => values[key] } as unknown as ConfigService);

const json = (body: unknown, status = 200) =>
  ({
    ok: status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as Response;

describe('AgoraUsageClient', () => {
  const fetchMock = jest.fn();
  const realFetch = global.fetch;

  afterAll(() => {
    global.fetch = realFetch;
  });

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('is off without both the Customer ID and Secret', () => {
    expect(client().isConfigured).toBe(false);
    expect(client({ AGORA_CUSTOMER_ID: 'id' }).isConfigured).toBe(false);
    expect(client({ AGORA_CUSTOMER_ID: 'id', AGORA_CUSTOMER_SECRET: 's' }).isConfigured).toBe(true);
  });

  it("adds up every project's audio and video seconds per day, in minutes", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ projects: [{ id: 'p1' }, { id: 'p2' }] }))
      .mockResolvedValueOnce(
        json({
          usages: [
            {
              date: '2026-10-01T00:00:00.000Z',
              usage: { durationAudioAll: 600, durationVideoHd: 3_000 },
            },
            { date: 1_790_899_200, usage: { durationAudioAll: 0, durationVideoHd: 120 } },
          ],
        }),
      )
      .mockResolvedValueOnce(
        json({
          usages: [{ date: '2026-10-01T00:00:00.000Z', usage: { durationVideo1080P: 600 } }],
        }),
      );

    const minutes = await client({
      AGORA_CUSTOMER_ID: 'id',
      AGORA_CUSTOMER_SECRET: 'secret',
    }).dailyMinutes('2026-10-01', '2026-10-02');

    expect(minutes).toEqual(
      new Map([
        ['2026-10-01', 70],
        ['2026-10-02', 2],
      ]),
    );
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(
      'https://api.agora.io/dev/v3/usage?project_id=p1&from_date=2026-10-01&to_date=2026-10-02&business=default',
    );
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('id:secret').toString('base64')}`);
  });

  it('says plainly when Agora refuses the credentials', async () => {
    fetchMock.mockResolvedValue(json({ message: 'Unauthorized' }, 401));

    await expect(
      client({ AGORA_CUSTOMER_ID: 'id', AGORA_CUSTOMER_SECRET: 'bad' }).dailyMinutes(
        '2026-10-01',
        '2026-10-02',
      ),
    ).rejects.toThrow(AgoraUsageError);
  });

  it("reads Agora's dates in seconds, milliseconds or ISO", () => {
    expect(dayOf(1_790_899_200)).toBe('2026-10-02');
    expect(dayOf(1_790_899_200_000)).toBe('2026-10-02');
    expect(dayOf('2026-10-02T00:00:00.000Z')).toBe('2026-10-02');
    expect(dayOf('not a date')).toBeNull();
  });
});
