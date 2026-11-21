import { changesBetween, created, removed, snapshotOf } from './audit-changes';

describe('audit changes', () => {
  it('keeps only the fields that changed, on both sides', () => {
    expect(
      changesBetween(
        { displayName: 'Abebe', bio: 'Hi', avatarUrl: null },
        { displayName: 'Abebe K.', bio: 'Hi', avatarUrl: null },
      ),
    ).toEqual({ before: { displayName: 'Abebe' }, after: { displayName: 'Abebe K.' } });
  });

  it('looks only at the fields asked about', () => {
    expect(
      changesBetween({ title: 'A', updatedAt: 1 }, { title: 'A', updatedAt: 2 }, ['title']),
    ).toBeUndefined();
  });

  it('keeps dates as text, and compares lists and objects by value', () => {
    const changes = changesBetween(
      { endsAt: new Date('2026-11-20T10:00:00Z'), order: ['a', 'b'] },
      { endsAt: null, order: ['a', 'b'] },
    );
    expect(changes).toEqual({
      before: { endsAt: '2026-11-20T10:00:00.000Z' },
      after: { endsAt: null },
    });
  });

  it('describes something new by what it is, and something gone by what it was', () => {
    expect(created({ phrase: 'spam', severity: 'MASK', id: 'p1' }, ['phrase', 'severity'])).toEqual(
      {
        after: { phrase: 'spam', severity: 'MASK' },
      },
    );
    expect(removed({ phrase: 'spam' })).toEqual({ before: { phrase: 'spam' } });
    expect(snapshotOf(null)).toEqual({});
  });
});
