import { chunkForSpeech, cleanTranscript } from '@/voice/vad';
import { DEFAULT_TTS_CHUNK_CHARS } from '@/voice/types';

describe('cleanTranscript', () => {
  it('trims and collapses whitespace', () => {
    expect(cleanTranscript('   add   milk   to   the  list  ')).toBe('add milk to the list');
    expect(cleanTranscript('add\n\tmilk')).toBe('add milk');
    expect(cleanTranscript('add milk')).toBe('add milk');
  });

  it('returns an empty string for nothing at all', () => {
    expect(cleanTranscript('')).toBe('');
    expect(cleanTranscript('    ')).toBe('');
  });

  it('strips the trailing full stop the recogniser adds', () => {
    expect(cleanTranscript('remind me to call Ivo.')).toBe('remind me to call Ivo');
    expect(cleanTranscript('remind me to call Ivo. ')).toBe('remind me to call Ivo');
    expect(cleanTranscript('remind me to call Ivo...')).toBe('remind me to call Ivo');
    expect(cleanTranscript('remind me to call Ivo…')).toBe('remind me to call Ivo');
  });

  it('keeps question and exclamation marks', () => {
    expect(cleanTranscript("what's on today?")).toBe("what's on today?");
    expect(cleanTranscript('cancel it!')).toBe('cancel it!');
  });

  it('keeps a trailing dot that belongs to an abbreviation', () => {
    expect(cleanTranscript('meet Ivo at 3 p.m.')).toBe('meet Ivo at 3 p.m.');
  });

  it('removes filler openers', () => {
    expect(cleanTranscript('um remind me to buy eggs')).toBe('remind me to buy eggs');
    expect(cleanTranscript('Uh, add milk')).toBe('add milk');
    expect(cleanTranscript('so cancel the meeting')).toBe('cancel the meeting');
    expect(cleanTranscript('Okay so schedule a call')).toBe('schedule a call');
    expect(cleanTranscript('ok so, um, log a workout')).toBe('log a workout');
  });

  it('only removes fillers at the start', () => {
    expect(cleanTranscript('tell Ivo it is okay so we can move on')).toBe(
      'tell Ivo it is okay so we can move on',
    );
  });

  it('leaves an all-filler utterance alone so a one-word answer survives', () => {
    expect(cleanTranscript('ok')).toBe('ok');
    expect(cleanTranscript('  Okay.  ')).toBe('Okay');
  });

  it('normalises dictation artefacts', () => {
    expect(cleanTranscript('buy eggs , milk and bread.')).toBe('buy eggs, milk and bread');
    expect(cleanTranscript('wait,, what?')).toBe('wait, what?');
    expect(cleanTranscript('don’t forget the keys')).toBe("don't forget the keys");
    expect(cleanTranscript('he said “hello”')).toBe('he said "hello"');
    expect(cleanTranscript(', remind me later')).toBe('remind me later');
  });
});

describe('chunkForSpeech', () => {
  const withinLimit = (chunks: string[], limit = DEFAULT_TTS_CHUNK_CHARS) =>
    chunks.every((chunk) => chunk.length <= limit);

  it('returns nothing for empty text', () => {
    expect(chunkForSpeech('')).toEqual([]);
    expect(chunkForSpeech('   \n ')).toEqual([]);
  });

  it('leaves short text in one piece', () => {
    expect(chunkForSpeech('You have three things today.')).toEqual([
      'You have three things today.',
    ]);
  });

  it('splits a long paragraph at sentence boundaries', () => {
    const sentence = 'You have a lecture at nine and a lab report due before the weekend.';
    const paragraph = Array.from({ length: 12 }, (_, i) => `${sentence} That is item ${i}.`).join(' ');

    const chunks = chunkForSpeech(paragraph);

    expect(chunks.length).toBeGreaterThan(1);
    expect(withinLimit(chunks)).toBe(true);
    expect(chunks.join(' ')).toBe(paragraph);
    // No chunk may begin mid-sentence: every one starts where a sentence does.
    for (const chunk of chunks) expect(chunk.startsWith('You have a lecture')).toBe(true);
  });

  it('packs several short sentences into one chunk', () => {
    const paragraph = Array.from({ length: 30 }, (_, i) => `Item ${i}.`).join(' ');

    const chunks = chunkForSpeech(paragraph);

    expect(withinLimit(chunks)).toBe(true);
    expect(chunks.join(' ')).toBe(paragraph);
    expect(chunks.length).toBeLessThan(paragraph.split('.').length);
    expect(chunks[0]!.length).toBeGreaterThan(DEFAULT_TTS_CHUNK_CHARS / 2);
  });

  it('splits text with no sentence breaks at all', () => {
    const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
    expect(words.length).toBeGreaterThan(DEFAULT_TTS_CHUNK_CHARS * 3);

    const chunks = chunkForSpeech(words);

    expect(chunks.length).toBeGreaterThan(3);
    expect(withinLimit(chunks)).toBe(true);
    expect(chunks.join(' ')).toBe(words);
  });

  it('falls back to clause boundaries inside an over-long sentence', () => {
    const clauses = Array.from({ length: 20 }, (_, i) => `part number ${i} of the list`).join(', ');
    const sentence = `${clauses}.`;

    const chunks = chunkForSpeech(sentence);

    expect(withinLimit(chunks)).toBe(true);
    expect(chunks.join(' ')).toBe(sentence);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(0, -1)) expect(chunk.endsWith(',')).toBe(true);
  });

  it('hard-splits a single word longer than the limit', () => {
    const word = 'x'.repeat(450);

    const chunks = chunkForSpeech(word);

    expect(chunks).toHaveLength(3);
    expect(withinLimit(chunks)).toBe(true);
    expect(chunks.join('')).toBe(word);
  });

  it('honours a custom limit', () => {
    const paragraph = 'One. Two. Three. Four. Five. Six.';

    const chunks = chunkForSpeech(paragraph, 10);

    expect(withinLimit(chunks, 10)).toBe(true);
    expect(chunks.join(' ')).toBe(paragraph);
  });

  it('keeps punctuation that no word precedes', () => {
    // A template that rendered an empty field leaves a stray ". " behind, and a
    // briefing can open with an ellipsis. Neither may be silently swallowed.
    const paragraph =
      '... Good morning. . You have three classes today, starting with Physics at nine. ' +
      ': and your lab report is due tomorrow!';
    const characters = (text: string) => text.replace(/\s/gu, '');

    for (const limit of [12, 40, 60, 100]) {
      const chunks = chunkForSpeech(paragraph, limit);
      expect(withinLimit(chunks, limit)).toBe(true);
      expect(characters(chunks.join(''))).toBe(characters(paragraph));
    }
  });

  it('never loses text no matter where the limit falls', () => {
    const paragraph =
      'Good morning. You have three classes today, starting with Physics at nine. ' +
      'Your lab report is due tomorrow and you owe Ivo a reply about the trip. ' +
      'The weather is fine, so walking is faster than the tram!';

    for (let limit = 8; limit <= 220; limit += 7) {
      const chunks = chunkForSpeech(paragraph, limit);
      expect(withinLimit(chunks, limit)).toBe(true);
      expect(chunks.join(' ')).toBe(paragraph);
    }
  });
});
