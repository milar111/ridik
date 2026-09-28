/**
 * The transcript that commits, when a better engine got to read the audio.
 *
 * The recogniser has already answered by the time any of this runs — the user
 * watched the caption the whole time they were speaking — so the upload only
 * changes what gets filed. That ordering is the whole safety argument, and it
 * is why the rules below are what they are: an upgrade may improve a turn and
 * must never be able to cost one.
 *
 * `.tsx` so it lands in the `ui` project: `../index` reads `Platform`, and the
 * `logic` project has no react-native. It tests no component.
 */
import { ok, fail } from '@/core/result';

const mockStartListening = jest.fn();
const mockTranscribeFile = jest.fn();
const mockDeleteQuietly = jest.fn();
const mockSweep = jest.fn();

jest.mock('../stt', () => ({
  startListening: (options: unknown) => mockStartListening(options),
  stopListening: jest.fn(),
  abortListening: jest.fn(),
  getSttState: () => 'idle',
}));

jest.mock('../assemblyai', () => ({
  isConfigured: (key: unknown) => typeof key === 'string' && key.length > 0,
  recordAndTranscribe: jest.fn(),
  transcribeFile: (options: unknown) => mockTranscribeFile(options),
}));

jest.mock('../record', () => ({
  deleteQuietly: (uri: unknown) => mockDeleteQuietly(uri),
  sweepKeptRecordings: () => mockSweep(),
}));

// Neither is on this path, and both reach a native module that does not
// initialise under jest-expo — `expo-audio` throws on import rather than
// reporting itself absent, so a stub is the only way in.
jest.mock('../tts', () => ({
  speak: jest.fn(),
  stop: jest.fn(),
  isSpeaking: jest.fn(() => false),
}));
jest.mock('../whisper', () => ({
  isConfigured: () => false,
  recordAndTranscribe: jest.fn(),
}));

import { captureUtterance } from '../index';

const WAV = 'file:///cache/recording_1.wav';
const HEARD = 'book the dentist on Tuesday at';
const BETTER = 'book the dentist on Tuesday at three';

/**
 * Drives one recogniser session that ends in `onFinal`.
 *
 * `accept: true` because this rung is reached only by an utterance the
 * recogniser was happy with — a rejected one never gets this far.
 */
function recogniserHears(options: { transcript?: string; audioUri: string | null }) {
  mockStartListening.mockImplementation((listen: Record<string, Function>) => {
    listen.onFinal!({
      transcript: options.transcript ?? HEARD,
      raw: options.transcript ?? HEARD,
      confidence: 0.95,
      source: 'network',
      accept: true,
      reason: 'ok',
      audioUri: options.audioUri,
    });
    return Promise.resolve(ok(undefined));
  });
}

const UPGRADING = { enabled: true, upgrade: true, apiKey: 'key-123' } as const;

beforeEach(() => {
  mockStartListening.mockReset();
  mockTranscribeFile.mockReset();
  mockDeleteQuietly.mockReset();
  mockSweep.mockReset();
});

describe('upgrading what the recogniser heard', () => {
  it('files the better engine’s transcript, not the recogniser’s', async () => {
    recogniserHears({ audioUri: WAV });
    mockTranscribeFile.mockResolvedValue(ok({ transcript: BETTER, confidence: 0.99 }));

    const result = await captureUtterance({ assemblyai: { ...UPGRADING } });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.transcript).toBe(BETTER);
    expect(result.ok && result.value.source).toBe('assemblyai');
    // The real confidence, which is most of why this engine is worth asking:
    // it answers, where the platform recognisers mostly decline to.
    expect(result.ok && result.value.confidence).toBe(0.99);
  });

  it('hands over the file the recogniser kept, and nothing else', async () => {
    recogniserHears({ audioUri: WAV });
    mockTranscribeFile.mockResolvedValue(ok({ transcript: BETTER, confidence: 0.99 }));

    await captureUtterance({ assemblyai: { ...UPGRADING }, locale: 'en-GB' });

    expect(mockTranscribeFile).toHaveBeenCalledTimes(1);
    expect(mockTranscribeFile.mock.calls[0]![0]).toMatchObject({ uri: WAV, apiKey: 'key-123' });
  });

  /*
    The rule that matters most. The user said something; something is filed.
    An upload that fails is a worse transcript, never a lost turn — every other
    outcome here would make the feature a liability rather than an improvement.
  */
  it('keeps what the recogniser heard when the upload fails', async () => {
    recogniserHears({ audioUri: WAV });
    mockTranscribeFile.mockResolvedValue(fail('offline', 'No connection.'));

    const result = await captureUtterance({ assemblyai: { ...UPGRADING } });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.transcript).toBe(HEARD);
    expect(result.ok && result.value.source).toBe('network');
  });

  /*
    The same rule for the path that is not supposed to happen. `transcribeFile`
    answers in Results, so a throw here is a bug somewhere — and a bug in an
    optional accuracy improvement must not take down a turn the user already
    watched being transcribed. `captureUtterance` promises never to throw, and
    this rung is inside that promise.
  */
  it('keeps what the recogniser heard when the upload throws', async () => {
    recogniserHears({ audioUri: WAV });
    mockTranscribeFile.mockRejectedValue(new Error('socket hung up'));

    const result = await captureUtterance({ assemblyai: { ...UPGRADING } });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.transcript).toBe(HEARD);
    expect(mockDeleteQuietly).toHaveBeenCalledWith(WAV);
  });

  /*
    An engine that returns "" for audio the phone heard words in is wrong, and
    taking its answer would turn a good turn into "I didn't catch that".
  */
  it('refuses an empty upgrade rather than filing silence', async () => {
    recogniserHears({ audioUri: WAV });
    mockTranscribeFile.mockResolvedValue(ok({ transcript: '   ', confidence: 0.4 }));

    const result = await captureUtterance({ assemblyai: { ...UPGRADING } });

    expect(result.ok && result.value.transcript).toBe(HEARD);
  });

  it('does not upload at all when the recogniser kept no audio', async () => {
    recogniserHears({ audioUri: null });

    const result = await captureUtterance({ assemblyai: { ...UPGRADING } });

    expect(mockTranscribeFile).not.toHaveBeenCalled();
    expect(result.ok && result.value.transcript).toBe(HEARD);
  });

  it('does not upload when the user has not chosen the engine', async () => {
    recogniserHears({ audioUri: WAV });

    const result = await captureUtterance({
      assemblyai: { enabled: true, upgrade: false, apiKey: 'key-123' },
    });

    expect(mockTranscribeFile).not.toHaveBeenCalled();
    expect(result.ok && result.value.transcript).toBe(HEARD);
  });

  it('does not upload without a key, however the setting reads', async () => {
    recogniserHears({ audioUri: WAV });

    const result = await captureUtterance({
      assemblyai: { enabled: true, upgrade: true, apiKey: null },
    });

    expect(mockTranscribeFile).not.toHaveBeenCalled();
    expect(result.ok && result.value.transcript).toBe(HEARD);
  });
});

/*
  A recording is somebody's voice. It lives in the cache directory, where
  nothing else will clean it up, and every path through this rung has to end
  with it gone — including the ones that never opened it.
*/
describe('the recording never survives the turn', () => {
  it('deletes it after a successful upgrade', async () => {
    recogniserHears({ audioUri: WAV });
    mockTranscribeFile.mockResolvedValue(ok({ transcript: BETTER, confidence: 0.99 }));

    await captureUtterance({ assemblyai: { ...UPGRADING } });

    expect(mockDeleteQuietly).toHaveBeenCalledWith(WAV);
  });

  it('deletes it after a failed upgrade', async () => {
    recogniserHears({ audioUri: WAV });
    mockTranscribeFile.mockResolvedValue(fail('offline', 'No connection.'));

    await captureUtterance({ assemblyai: { ...UPGRADING } });

    expect(mockDeleteQuietly).toHaveBeenCalledWith(WAV);
  });

  it('deletes it when it was recorded and then not wanted', async () => {
    recogniserHears({ audioUri: WAV });

    await captureUtterance({ assemblyai: { enabled: true, upgrade: false, apiKey: 'key-123' } });

    expect(mockDeleteQuietly).toHaveBeenCalledWith(WAV);
  });

  /*
    The orphan `onDiscardAudio` can never catch. A session that dies before
    `audiostart` has already had its file written natively and never tells JS
    what it was called — so the only place to catch it is the way in, before
    anything of ours is writing one. Two of these were measured on a device.
  */
  it('sweeps before and after, so a turn leaves nothing behind', async () => {
    recogniserHears({ audioUri: WAV });
    mockTranscribeFile.mockResolvedValue(ok({ transcript: BETTER, confidence: 0.99 }));

    await captureUtterance({ assemblyai: { ...UPGRADING } });

    // Out matters most — without it the last utterance of the day leaves its
    // recordings in the cache until somebody happens to speak again. In
    // catches what a crash left, where no `finally` ever ran.
    expect(mockSweep).toHaveBeenCalledTimes(2);
  });

  it('still sweeps after a turn that failed outright', async () => {
    mockStartListening.mockImplementation((listen: Record<string, Function>) => {
      listen.onError!(new Error('mic died'));
      return Promise.resolve(ok(undefined));
    });

    await captureUtterance({ assemblyai: { ...UPGRADING } });

    expect(mockSweep).toHaveBeenCalledTimes(2);
  });

  it('does not sweep when it is not the one keeping recordings', async () => {
    recogniserHears({ audioUri: null });

    await captureUtterance({ assemblyai: { enabled: true, upgrade: false, apiKey: 'key-123' } });

    expect(mockSweep).not.toHaveBeenCalled();
  });

  it('deletes it when the utterance was rejected as unusable', async () => {
    mockStartListening.mockImplementation((listen: Record<string, Function>) => {
      listen.onFinal!({
        transcript: '',
        raw: '',
        confidence: null,
        source: 'network',
        accept: false,
        reason: 'empty',
        audioUri: WAV,
      });
      return Promise.resolve(ok(undefined));
    });

    const result = await captureUtterance({ assemblyai: { ...UPGRADING } });

    expect(result.ok).toBe(false);
    expect(mockDeleteQuietly).toHaveBeenCalledWith(WAV);
  });
});
