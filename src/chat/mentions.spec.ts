import { mentionedUsernames, mentionLookup, MAX_MENTIONS_PER_MESSAGE, resolveMentions } from './mentions';

describe('chat mentions', () => {
  it('finds @usernames anywhere in a message, first mention first, each once', () => {
    expect(mentionedUsernames('@ana hi, and @Bo_2! also @ANA again')).toEqual(['ana', 'Bo_2']);
  });

  it("doesn't take an email address or a doubled @ for a mention", () => {
    expect(mentionedUsernames('write to me@mail.example or @@ana')).toEqual([]);
    expect(mentionedUsernames('@')).toEqual([]);
  });

  it(`stops at ${MAX_MENTIONS_PER_MESSAGE} names`, () => {
    const text = Array.from({ length: 15 }, (_, i) => `@user${i}`).join(' ');
    expect(mentionedUsernames(text)).toHaveLength(MAX_MENTIONS_PER_MESSAGE);
  });

  it('resolves names case-insensitively, preferring an exact match', () => {
    const lookup = mentionLookup([
      { id: 'lower', username: 'abe' },
      { id: 'upper', username: 'Abe' },
      { id: 'sara', username: 'sara' },
    ]);

    expect(lookup('Abe')?.id).toBe('upper');
    expect(lookup('abe')?.id).toBe('lower');
    expect(lookup('SARA')?.id).toBe('sara');
    expect(lookup('ghost')).toBeUndefined();
  });

  it('keeps only real accounts, once each', () => {
    const lookup = mentionLookup([{ id: 'u1', username: 'ana' }]);

    expect(resolveMentions('@ana @nobody @ANA', lookup)).toEqual([{ id: 'u1', username: 'ana' }]);
  });
});
