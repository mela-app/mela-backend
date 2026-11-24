import { AppCrashKind, SessionPlatform } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AppCrashesService } from './app-crashes.service';
import { crashSignature } from './crash-signature';

describe('crashSignature', () => {
  const stack = (line: number, address: string) =>
    [
      'Null check operator used on a null value',
      `#0      _ViewerScreenState._join (package:mela_live/features/live_stream/viewer_screen.dart:${line}:5)`,
      `#1      ${address} RoomEvents.emit (package:livekit_client/src/events.dart:12:3)`,
    ].join('\n');

  it('is the same crash on every phone - line numbers and addresses aside', () => {
    expect(
      crashSignature(AppCrashKind.DART_ERROR, 'Bad state: id 42', stack(310, '0x7ffe01')),
    ).toBe(crashSignature(AppCrashKind.DART_ERROR, 'Bad state: id 97', stack(311, '0x7ffe99')));
  });

  it('tells different crashes, and kinds, apart', () => {
    const one = crashSignature(AppCrashKind.DART_ERROR, 'Bad state', stack(1, '0x1'));
    expect(crashSignature(AppCrashKind.DART_ERROR, 'Other error', stack(1, '0x1'))).not.toBe(one);
    expect(crashSignature(AppCrashKind.ANR, 'Bad state', stack(1, '0x1'))).not.toBe(one);
  });
});

describe('AppCrashesService', () => {
  const prisma = { appCrash: { createMany: jest.fn() } };
  const service = () => new AppCrashesService(prisma as unknown as PrismaService);
  const now = new Date('2026-11-24T10:00:00Z');

  beforeEach(() => jest.clearAllMocks());

  it('keeps each report with the app version, phone and who - trimmed to size', async () => {
    await expect(
      service().record(
        [
          {
            kind: AppCrashKind.NATIVE_CRASH,
            fatal: true,
            message: 'x'.repeat(5000),
            stack: 'y'.repeat(30_000),
            breadcrumbs: ['screen /live/abc', 'live.join start'],
            occurredAt: '2026-11-24T09:58:00Z',
            deviceModel: 'TECNO KI5',
            osVersion: 'Android 13',
          },
        ],
        { platform: SessionPlatform.ANDROID, version: '1.0.13', build: 23 },
        'u1',
        now,
      ),
    ).resolves.toEqual({ ok: true, recorded: 1 });

    const [row] = prisma.appCrash.createMany.mock.calls[0][0].data;
    expect(row).toMatchObject({
      userId: 'u1',
      kind: AppCrashKind.NATIVE_CRASH,
      fatal: true,
      platform: SessionPlatform.ANDROID,
      appVersion: '1.0.13',
      appBuild: 23,
      deviceModel: 'TECNO KI5',
      osVersion: 'Android 13',
      breadcrumbs: ['screen /live/abc', 'live.join start'],
      occurredAt: new Date('2026-11-24T09:58:00Z'),
    });
    expect(row.message).toHaveLength(2000);
    expect(row.stack).toHaveLength(16_000);
    expect(row.signature).toMatch(/^[0-9a-f]{16}$/);
  });

  it('dates a report from the future, or weeks old, when it arrived', async () => {
    await service().record(
      [
        { kind: AppCrashKind.ANR, fatal: true, message: 'a', occurredAt: '2027-01-01T00:00:00Z' },
        { kind: AppCrashKind.ANR, fatal: true, message: 'b', occurredAt: '2026-01-01T00:00:00Z' },
      ],
      {},
      null,
      now,
    );

    const rows = prisma.appCrash.createMany.mock.calls[0][0].data;
    expect(rows.map((row: { occurredAt: Date }) => row.occurredAt)).toEqual([now, now]);
    expect(rows[0]).toMatchObject({ userId: null, platform: null, appVersion: null });
  });
});
