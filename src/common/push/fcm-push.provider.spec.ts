import { compactCollapseKey, fcmMulticast } from './fcm-push.provider';

describe('FCM messages', () => {
  const longKey =
    'afe88d70-32e6-4816-8e67-7c7c4a6c0bb6:campaign:01a1f758-d94b-7023-b834-f17350226de4';

  it('keeps every collapse key within what APNs accepts (64 bytes), or FCM refuses the push', () => {
    const message = fcmMulticast(['t1'], {
      title: 'Hi',
      body: 'There',
      data: { type: 'CAMPAIGN' },
      collapseKey: longKey,
    });

    const id = message.apns?.headers?.['apns-collapse-id'] ?? '';
    expect(Buffer.byteLength(id)).toBeLessThanOrEqual(64);
    expect(message.android?.collapseKey).toBe(id);
    expect(message.android?.notification?.tag).toBe(id);
  });

  it('gives the same key the same id, and different keys different ids', () => {
    expect(compactCollapseKey(longKey)).toBe(compactCollapseKey(longKey));
    expect(compactCollapseKey('u1:dm-a')).not.toBe(compactCollapseKey('u1:dm-b'));
  });

  it('sends a push without a collapse key as it is', () => {
    const message = fcmMulticast(['t1'], { title: 'Hi', body: 'There' });

    expect(message.android).toBeUndefined();
    expect(message.apns).toBeUndefined();
    expect(message.notification).toEqual({ title: 'Hi', body: 'There' });
  });
});
