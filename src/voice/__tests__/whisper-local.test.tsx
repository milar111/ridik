/**
 * The upgrade engine that sends nothing anywhere.
 *
 * Same rung, same rules, different reader — and that is the thing worth
 * asserting. `upgradeHeard` was written once, for a server, and every rule it
 * enforces (a failed upgrade keeps the recogniser's words, an empty one is a
 * failure, the recording always goes) has to hold identically when the work
 * happens on the phone. Two engines with two copies of those rules is how the
 * two drift, so there is one code path and these tests point it at the other
 * reader.
 *
 * `.tsx` for the `ui` project: `../index` reaches `react-native`.
 */
import { ok, fail } from '@/core/result';

const mockStartListening = jest.fn();
const mockWhisperTranscribe = jest.fn();
const mockAssemblyTranscribe = jest.fn();
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
  transcribeFile: (options: unknown) => mockAssemblyTranscribe(options),
}));

jest.mock('../whisperLocal', () => ({
  transcribeFile: (uri: unknown) => mockWhisperTranscribe(uri),
  ensureModel: jest.fn(),
  status: () => 'installed',
  WHISPER_MODEL_FILE: 'ggml-base.en-q5_1.bin',
}));

jest.mock('../record', () => ({
  deleteQuietly: (uri: unknown) => mockDeleteQuietly(uri),
  sweepKeptRecordings: () => mockSweep(),
}));

jest.mock('../tts', () => ({ speak: jest.fn(), stop: jest.fn(), isSpeaking: () => false }));
jest.mock('../whisper', () => ({ isConfigured: () => false, recordAndTranscribe: jest.fn() }));

import { captureUtterance } from '../index';

const WAV = 'file:///cache/recording_1.wav';
const HEARD = 'book the dentist on Tuesday at';
const BETTER = 'book the dentist on Tuesday at three';

function recogniserHears(audioUri: string | null) {
  mockStartListening.mockImplementation((listen: Record<string, Function>) => {
    listen.onFinal!({
      transcript: HEARD,
      raw: HEARD,
      confidence: 0.95,
      source: 'network',
      accept: true,
      reason: 'ok',
      audioUri,
    });
    return Promise.resolve(ok(undefined));
  });
}

const OFFLINE = { whisperLocal: { upgrade: true } } as const;

beforeEach(() => {
  mockStartListening.mockReset();
  mockWhisperTranscribe.mockReset();
  mockAssemblyTranscribe.mockReset();
  mockDeleteQuietly.mockReset();
  mockSweep.mockReset();
});

describe('upgrading on the phone', () => {
  it('files the offline transcript and says which engine wrote it', async () => {
    recogniserHears(WAV);
    mockWhisperTranscribe.mockResolvedValue(ok({ transcript: BETTER, confidence: null }));

    const result = await captureUtterance({ ...OFFLINE });

    expect(result.ok && result.value.transcript).toBe(BETTER);
    expect(result.ok && result.value.source).toBe('whisper');
    // No invented number. whisper.cpp reports no confidence, and a fabricated
    // one would read as measured to `wasPoorlyHeard`.
    expect(result.ok && result.value.confidence).toBeNull();
  });

  it('keeps the audio, because there is nothing to upgrade without it', async () => {
    recogniserHears(WAV);
    mockWhisperTranscribe.mockResolvedValue(ok({ transcript: BETTER, confidence: null }));

    await captureUtterance({ ...OFFLINE });

    // The `ui` project runs as iOS, so this is also the iOS format: left at
    // its default that recorder writes 44.1/48 kHz float, which whisper.cpp
    // cannot read without a resample nobody would see fail.
    expect(mockStartListening.mock.calls[0]![0].captureAudio).toEqual({
      persist: true,
      outputSampleRate: 16_000,
      outputEncoding: 'pcmFormatInt16',
    });
    expect(mockWhisperTranscribe).toHaveBeenCalledWith(WAV);
  });

  /*
    The rule that makes this safe to switch on. An engine that cannot answer —
    the model is still downloading, the native side is missing from this build
    — leaves the recogniser's own transcript exactly as it was.
  */
  it('keeps what the recogniser heard while the model is still downloading', async () => {
    recogniserHears(WAV);
    mockWhisperTranscribe.mockResolvedValue(
      fail('unsupported', 'The offline speech model is still downloading.'),
    );

    const result = await captureUtterance({ ...OFFLINE });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.transcript).toBe(HEARD);
    expect(result.ok && result.value.source).toBe('network');
  });

  it('keeps what the recogniser heard when the engine throws', async () => {
    recogniserHears(WAV);
    mockWhisperTranscribe.mockRejectedValue(new Error('native side died'));

    const result = await captureUtterance({ ...OFFLINE });

    expect(result.ok && result.value.transcript).toBe(HEARD);
  });

  it('refuses an empty offline transcript rather than filing silence', async () => {
    recogniserHears(WAV);
    mockWhisperTranscribe.mockResolvedValue(ok({ transcript: '  ', confidence: null }));

    const result = await captureUtterance({ ...OFFLINE });

    expect(result.ok && result.value.transcript).toBe(HEARD);
  });

  it('deletes the recording whatever the engine answered', async () => {
    recogniserHears(WAV);
    mockWhisperTranscribe.mockResolvedValue(fail('unknown', 'nope'));

    await captureUtterance({ ...OFFLINE });

    expect(mockDeleteQuietly).toHaveBeenCalledWith(WAV);
  });

  /*
    No key, no consent gate, no network — that is the entire point of this
    engine, and a test that lets an apiKey creep into its path would be the
    first step back towards one.
  */
  it('needs no key of any kind', async () => {
    recogniserHears(WAV);
    mockWhisperTranscribe.mockResolvedValue(ok({ transcript: BETTER, confidence: null }));

    const result = await captureUtterance({ ...OFFLINE });

    expect(result.ok && result.value.transcript).toBe(BETTER);
    expect(mockAssemblyTranscribe).not.toHaveBeenCalled();
  });
});

describe('choosing between the two upgrade engines', () => {
  /*
    They are never both on through the settings screen — `sttEngine` is one
    value — but if that ever changes, the engine that sends nothing anywhere is
    the one to prefer.
  */
  it('prefers the phone when somehow both are on', async () => {
    recogniserHears(WAV);
    mockWhisperTranscribe.mockResolvedValue(ok({ transcript: BETTER, confidence: null }));
    mockAssemblyTranscribe.mockResolvedValue(ok({ transcript: 'uploaded', confidence: 0.9 }));

    const result = await captureUtterance({
      ...OFFLINE,
      assemblyai: { enabled: true, upgrade: true, apiKey: 'key-123' },
    });

    expect(result.ok && result.value.source).toBe('whisper');
    expect(mockAssemblyTranscribe).not.toHaveBeenCalled();
  });

  it('keeps no audio at all when neither engine is on', async () => {
    recogniserHears(null);

    await captureUtterance({ assemblyai: { enabled: true, upgrade: false, apiKey: 'key-123' } });

    // Absent, not `false`: nothing is asked for, so the recogniser is handed
    // no `recordingOptions` at all and writes nothing.
    expect(mockStartListening.mock.calls[0]![0].captureAudio).toBeUndefined();
    expect(mockSweep).not.toHaveBeenCalled();
  });
});
