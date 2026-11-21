import { CHAT_MAX_LENGTH, CHAT_MAX_LINES, cleanChatText } from './chat-text';

describe('cleanChatText', () => {
  it('keeps an ordinary message as it is', () => {
    expect(cleanChatText('Nice hand! 🔥')).toEqual({ text: 'Nice hand! 🔥' });
  });

  it('trims, and collapses tabs and runs of spaces', () => {
    expect(cleanChatText('  all  in \t now   ')).toEqual({ text: 'all in now' });
  });

  it('keeps line breaks, tidied: no spaces around them, at most one empty line', () => {
    expect(cleanChatText('\nhello  \r\n  world\n\n\n\nbye\n')).toEqual({
      text: 'hello\nworld\n\nbye',
    });
  });

  it('joins lines past the limit onto the last one', () => {
    const lines = ['1', '2', '3', '4', '5', '6', '', '7'].join('\n');
    expect(CHAT_MAX_LINES).toBe(5);
    expect(cleanChatText(lines)).toEqual({ text: '1\n2\n3\n4\n5 6 7' });
    expect(cleanChatText(lines, CHAT_MAX_LENGTH, 20)).toEqual({ text: '1\n2\n3\n4\n5\n6\n\n7' });
  });

  it('removes control characters and bidi overrides', () => {
    expect(cleanChatText('a\u0000b\u202Ec\u2066d\u0007')).toEqual({ text: 'abcd' });
  });

  it('keeps emoji built from several code points intact', () => {
    const family = '👨\u200D👩\u200D👧';
    expect(cleanChatText(`gg ${family}`)).toEqual({ text: `gg ${family}` });
  });

  it('collapses floods to five of a kind', () => {
    expect(cleanChatText('wowwwwwwwwwww!!!!!!!!!!')).toEqual({ text: 'wowwwww!!!!!' });
    expect(cleanChatText('😂😂😂😂😂😂😂😂')).toEqual({ text: '😂😂😂😂😂' });
  });

  it('refuses a message with nothing left to say', () => {
    expect(cleanChatText('   \n\u202E ')).toEqual({ error: 'MESSAGE_EMPTY' });
  });

  it('counts characters, not UTF-16 units, against the limit', () => {
    const emojiAndSpace = '🎲 ';
    const atLimit = emojiAndSpace.repeat(CHAT_MAX_LENGTH / 2).trim();
    expect([...atLimit].length).toBeLessThanOrEqual(CHAT_MAX_LENGTH);
    expect(cleanChatText(atLimit)).toEqual({ text: atLimit });

    expect(cleanChatText('ab'.repeat(CHAT_MAX_LENGTH))).toEqual({ error: 'MESSAGE_TOO_LONG' });
  });
});
