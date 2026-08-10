import { createSilenceDetector, evaluateTranscript } from '@/voice/vad';

describe('createSilenceDetector', () => {
  it('fires once after trailing silence follows enough speech', () => {
    const onTimeout = jest.fn();
    const detector = createSilenceDetector({ trailingSilenceMs: 1500, minSpeechMs: 300, onTimeout });

    detector.noteSpeech(1000);
    detector.noteSpeech(1600);
    detector.noteSilence(1600);

    expect(detector.tick(2500)).toBe(false);
    expect(detector.tick(3099)).toBe(false);
    expect(detector.tick(3100)).toBe(true);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    // Further ticks must not fire again for the same utterance.
    expect(detector.tick(9000)).toBe(false);
    expect(detector.tick(20_000)).toBe(false);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('treats time since the last speech as silence when no speechend arrives', () => {
    const onTimeout = jest.fn();
    const detector = createSilenceDetector({ trailingSilenceMs: 1500, minSpeechMs: 300, onTimeout });

    detector.noteSpeech(0);
    detector.noteSpeech(800);

    expect(detector.tick(2200)).toBe(false);
    expect(detector.tick(2300)).toBe(true);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('does not fire on a too-short utterance no matter how long the silence', () => {
    const onTimeout = jest.fn();
    const detector = createSilenceDetector({ trailingSilenceMs: 1500, minSpeechMs: 300, onTimeout });

    detector.noteSpeech(1000);
    detector.noteSpeech(1100);
    detector.noteSilence(1100);

    for (const at of [2000, 3000, 5000, 30_000]) expect(detector.tick(at)).toBe(false);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(detector.hasFired()).toBe(false);
  });

  it('accumulates speech across pauses that are shorter than the threshold', () => {
    const onTimeout = jest.fn();
    const detector = createSilenceDetector({ trailingSilenceMs: 1500, minSpeechMs: 300, onTimeout });

    // Two 200ms bursts: neither is long enough alone, together they are.
    detector.noteSpeech(0);
    detector.noteSpeech(200);
    detector.noteSilence(200);
    expect(detector.tick(1000)).toBe(false);

    detector.noteSpeech(1000);
    detector.noteSpeech(1200);
    detector.noteSilence(1200);

    expect(detector.stats(1200).speechMs).toBe(400);
    expect(detector.tick(2699)).toBe(false);
    expect(detector.tick(2700)).toBe(true);
  });

  it('accumulates speech when a ticker runs between partial results', () => {
    // Exactly what stt.ts does: a 150 ms ticker alongside partial results that
    // only arrive every ~400 ms. A tick observes time passing; it must not cut
    // the open speech run short, or speechMs never reaches minSpeechMs and the
    // endpointer never fires.
    const onTimeout = jest.fn();
    const detector = createSilenceDetector({ trailingSilenceMs: 1500, minSpeechMs: 300, onTimeout });

    let firedAt: number | null = null;
    for (let at = 0; at <= 6000 && firedAt === null; at += 50) {
      if (at % 400 === 0 && at <= 2000) detector.noteSpeech(at);
      if (at % 150 === 0 && detector.tick(at)) firedAt = at;
    }

    expect(detector.stats(2000).speechMs).toBe(2000);
    expect(firedAt).toBe(3600);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('does not count the gap between bursts as speech', () => {
    const detector = createSilenceDetector({ trailingSilenceMs: 1500, minSpeechMs: 300 });

    detector.noteSpeech(0);
    detector.tick(500);
    detector.noteSpeech(5000);
    detector.noteSpeech(5100);

    expect(detector.stats(5100).speechMs).toBe(100);
  });

  it('restarts the silence clock when speech resumes', () => {
    const onTimeout = jest.fn();
    const detector = createSilenceDetector({ trailingSilenceMs: 1500, minSpeechMs: 300, onTimeout });

    detector.noteSpeech(0);
    detector.noteSpeech(500);
    detector.noteSilence(500);
    expect(detector.tick(1800)).toBe(false);

    detector.noteSpeech(1900);
    detector.noteSilence(2000);
    expect(detector.tick(3000)).toBe(false);
    expect(detector.tick(3500)).toBe(true);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('does not let repeated speechend events push the deadline out', () => {
    const detector = createSilenceDetector({ trailingSilenceMs: 1000, minSpeechMs: 300 });

    detector.noteSpeech(0);
    detector.noteSpeech(500);
    detector.noteSilence(500);
    detector.noteSilence(900);
    detector.noteSilence(1400);

    expect(detector.tick(1500)).toBe(true);
  });

  it('never fires on silence that was never preceded by speech', () => {
    const onTimeout = jest.fn();
    const detector = createSilenceDetector({ trailingSilenceMs: 1000, minSpeechMs: 300, onTimeout });

    detector.noteSilence(0);
    expect(detector.tick(60_000)).toBe(false);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('reports progress towards the deadline', () => {
    const detector = createSilenceDetector({ trailingSilenceMs: 1500, minSpeechMs: 300 });
    expect(detector.stats(0)).toEqual({ speechMs: 0, silenceMs: 0, fired: false });

    detector.noteSpeech(0);
    detector.noteSpeech(400);
    detector.noteSilence(400);

    expect(detector.stats(1000)).toEqual({ speechMs: 400, silenceMs: 600, fired: false });
    detector.tick(1900);
    expect(detector.stats(1900).fired).toBe(true);
  });

  it('reset() allows a second utterance to fire', () => {
    const onTimeout = jest.fn();
    const detector = createSilenceDetector({ trailingSilenceMs: 1000, minSpeechMs: 300, onTimeout });

    detector.noteSpeech(0);
    detector.noteSpeech(500);
    expect(detector.tick(1600)).toBe(true);

    detector.reset();
    expect(detector.hasFired()).toBe(false);
    expect(detector.stats(1600).speechMs).toBe(0);

    detector.noteSpeech(2000);
    detector.noteSpeech(2500);
    expect(detector.tick(3600)).toBe(true);
    expect(onTimeout).toHaveBeenCalledTimes(2);
  });

  it('dispose() stops it responding to anything', () => {
    const onTimeout = jest.fn();
    const detector = createSilenceDetector({ trailingSilenceMs: 1000, minSpeechMs: 300, onTimeout });

    detector.dispose();
    detector.noteSpeech(0);
    detector.noteSilence(100);

    expect(detector.tick(10_000)).toBe(false);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('uses the documented defaults', () => {
    const detector = createSilenceDetector();

    detector.noteSpeech(0);
    detector.noteSpeech(300);

    expect(detector.tick(1799)).toBe(false);
    expect(detector.tick(1800)).toBe(true);
  });
});

describe('evaluateTranscript', () => {
  it('accepts a normal transcript with good confidence', () => {
    expect(evaluateTranscript({ transcript: 'remind me to call Ivo', confidence: 0.94 })).toEqual({
      accept: true,
      reason: 'ok',
    });
  });

  it('rejects empty and whitespace-only transcripts', () => {
    for (const transcript of ['', '   ', '\n\t  ']) {
      expect(evaluateTranscript({ transcript, confidence: 0.99 })).toEqual({
        accept: false,
        reason: 'empty',
      });
    }
  });

  it('rejects text with nothing substantive in it', () => {
    expect(evaluateTranscript({ transcript: 'a', confidence: 0.99 })).toEqual({
      accept: false,
      reason: 'too_short',
    });
    expect(evaluateTranscript({ transcript: '!!', confidence: 0.99 })).toEqual({
      accept: false,
      reason: 'too_short',
    });
  });

  it('rejects a reported confidence below the threshold', () => {
    expect(evaluateTranscript({ transcript: 'add milk to the list', confidence: 0.42 })).toEqual({
      accept: false,
      reason: 'low_confidence',
    });
  });

  it('honours a custom threshold', () => {
    const input = { transcript: 'add milk to the list', confidence: 0.6 };
    expect(evaluateTranscript({ ...input, minConfidence: 0.5 }).accept).toBe(true);
    expect(evaluateTranscript({ ...input, minConfidence: 0.9 }).accept).toBe(false);
  });

  it('accepts when Android reports no usable confidence', () => {
    // Zero, -1 ("unavailable"), null and undefined all mean "we do not know".
    for (const confidence of [0, -1, null, undefined, Number.NaN]) {
      expect(evaluateTranscript({ transcript: 'log a workout for 30 minutes', confidence })).toEqual({
        accept: true,
        reason: 'ok',
      });
    }
  });

  it('still rejects empty text when confidence is unknown', () => {
    expect(evaluateTranscript({ transcript: '  ', confidence: 0 })).toEqual({
      accept: false,
      reason: 'empty',
    });
  });

  it('accepts a boundary confidence exactly on the threshold', () => {
    expect(evaluateTranscript({ transcript: 'cancel the meeting', confidence: 0.7 }).accept).toBe(
      true,
    );
  });
});
