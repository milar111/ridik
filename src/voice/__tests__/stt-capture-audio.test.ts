/**
 * The recogniser keeping a copy of what it heard.
 *
 * This is the transport half of the one rung that can fix a *confident wrong*
 * transcript. Every other fallback in the ladder fires on failure, and a
 * recogniser that returns a sentence with a word missing has not failed — so
 * the only shape that helps is having the audio afterwards and asking a better
 * engine about it.
 *
 * What makes it affordable is that it is not a second microphone: on Android
 * 13+ the recognition library owns one `AudioRecord`, writes the PCM to a file
 * and hands that same stream to the recognition service as
 * `EXTRA_AUDIO_SOURCE`. Measured on a device — a 16 kHz mono WAV in the cache,
 * with partials still arriving word by word.
 *
 * What is asserted here is the contract this module is responsible for: ask
 * only when told to, and report the file so somebody can delete it.
 */
import { AppError, type Result } from '@/core/result';
import type { SttFinalResult, SttListenOptions } from '../types';

type Handler = (event: unknown) => void;
const mockHandlers = new Map<string, Handler[]>();

function emit(name: string, event: unknown = {}): void {
  for (const handler of [...(mockHandlers.get(name) ?? [])]) handler(event);
}

const mockModule = {
  getPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true })),
  isRecognitionAvailable: jest.fn(() => true),
  supportsOnDeviceRecognition: jest.fn(() => true),
  getSupportedLocales: jest.fn(async () => ({ installedLocales: ['en-US'] })),
  start: jest.fn(),
  stop: jest.fn(),
  abort: jest.fn(),
  addListener: jest.fn((name: string, handler: Handler) => {
    const list = mockHandlers.get(name) ?? [];
    list.push(handler);
    mockHandlers.set(name, list);
    return {
      remove() {
        mockHandlers.set(name, (mockHandlers.get(name) ?? []).filter((entry) => entry !== handler));
      },
    };
  }),
};

// A getter rather than a value: `jest.mock` hoists above every `import`, so the
// module under test would otherwise capture `undefined` for the whole run.
jest.mock('expo-speech-recognition', () => ({
  get ExpoSpeechRecognitionModule() {
    return mockModule;
  },
  TaskHintIOS: { dictation: 'dictation' },
}));

import { abortListening, startListening } from '../stt';

const WAV = 'file:///data/user/0/ai.dby.ridik/cache/recording_1789214131617.wav';

/** What Android's `keptAudioOptions()` returns; iOS adds a format to it. */
const KEPT = { persist: true } as const;

function final(transcript: string) {
  return { isFinal: true, results: [{ transcript, confidence: 0.95 }] };
}

async function listen(
  extra: Partial<SttListenOptions> = {},
): Promise<{ final: jest.Mock<void, [SttFinalResult]>; started: Result<void> }> {
  const onFinal = jest.fn();
  const onError = jest.fn<void, [AppError]>();
  const started = await startListening({ onFinal, onError, ...extra });
  emit('start');
  return { final: onFinal as never, started };
}

/** What the recogniser was actually asked for on the most recent start. */
function lastStartOptions(): Record<string, unknown> {
  const calls = mockModule.start.mock.calls;
  return (calls[calls.length - 1]?.[0] ?? {}) as Record<string, unknown>;
}

afterEach(() => {
  abortListening();
  mockHandlers.clear();
  mockModule.start.mockClear();
});

describe('keeping the audio the recogniser heard', () => {
  it('does not ask for a recording unless the caller wants one', async () => {
    await listen();
    expect(lastStartOptions().recordingOptions).toBeUndefined();
  });

  it('asks the recogniser to persist when the caller wants the audio', async () => {
    await listen({ captureAudio: KEPT });
    expect(lastStartOptions().recordingOptions).toEqual({ persist: true });
  });

  /*
    The format travels with the request rather than being decided here, because
    the two platforms do not agree on one: Android already writes 16 kHz mono
    PCM and ignores these fields, iOS records at the input node's own 44.1/48
    kHz float unless told otherwise. This module must not read `Platform` — it
    is loaded under plain Node — so it forwards whatever it was handed.
  */
  it('forwards the format it was handed rather than deciding one', async () => {
    const ios = { persist: true, outputSampleRate: 16_000, outputEncoding: 'pcmFormatInt16' } as const;
    await listen({ captureAudio: ios });
    expect(lastStartOptions().recordingOptions).toEqual(ios);
  });

  it('reports the file on the final result', async () => {
    const session = await listen({ captureAudio: KEPT });
    emit('audiostart', { uri: WAV });
    emit('result', final('book the dentist on Tuesday at three'));
    emit('audioend', { uri: WAV });
    emit('end');

    expect(session.final).toHaveBeenCalledTimes(1);
    expect(session.final.mock.calls[0]![0]!.audioUri).toBe(WAV);
  });

  /*
    `audioend` is the event that means the file is closed, but a session can
    die between the two — and the uri from `audiostart` is then the only name
    anybody has for a file holding somebody's voice. Losing it leaks a
    recording into the cache directory.
  */
  it('keeps the uri from audiostart when audioend never arrives', async () => {
    const session = await listen({ captureAudio: KEPT });
    emit('audiostart', { uri: WAV });
    emit('result', final('book the dentist'));
    emit('end');

    expect(session.final.mock.calls[0]![0]!.audioUri).toBe(WAV);
  });

  /*
    Below Android 13 the library accepts `recordingOptions` and ignores it, so
    `audiostart` arrives carrying nothing. That has to read as "no file",
    never as a missing event — the caller decides whether to upgrade on this.
  */
  it('reports no file when the platform quietly ignored the request', async () => {
    const session = await listen({ captureAudio: KEPT });
    emit('audiostart', { uri: null });
    emit('result', final('book the dentist'));
    emit('audioend', { uri: null });
    emit('end');

    expect(session.final.mock.calls[0]![0]!.audioUri).toBeNull();
  });

  it('reports no file at all when none was asked for', async () => {
    const session = await listen();
    emit('result', final('book the dentist'));
    emit('end');

    expect(session.final.mock.calls[0]![0]!.audioUri).toBeNull();
  });
});

/*
  A recording is somebody's voice in a cache directory that nothing else
  sweeps. Exactly one ending hands it to anybody — `onFinal` — and every other
  one has to say so, or the file is simply left there.

  This was found on a device rather than reasoned about: one session, two
  orphaned WAVs, because an on-device attempt that cannot serve the locale is
  abandoned mid-flight and retried over the network, and neither half had
  anywhere to report a file.
*/
describe('a recording nobody will be handed is thrown away', () => {
  it('discards it when the session ends in an error', async () => {
    const discarded: string[] = [];
    await listen({ captureAudio: KEPT, onDiscardAudio: (uri) => discarded.push(uri) });
    emit('audiostart', { uri: WAV });
    emit('error', { error: 'network', message: 'no connection' });

    expect(discarded).toEqual([WAV]);
  });

  it('discards it when the caller cancels', async () => {
    const discarded: string[] = [];
    await listen({ captureAudio: KEPT, onDiscardAudio: (uri) => discarded.push(uri) });
    emit('audiostart', { uri: WAV });
    abortListening();

    expect(discarded).toEqual([WAV]);
  });

  /*
    The one that actually leaked. A locale the on-device engine cannot serve
    abandons that session and starts a second one over the network — so the
    first recording is never reported to anybody and never deleted.
  */
  it('discards the first recording when the session retries over the network', async () => {
    const discarded: string[] = [];
    await listen({ captureAudio: KEPT, onDiscardAudio: (uri) => discarded.push(uri) });
    emit('audiostart', { uri: WAV });
    emit('error', { error: 'language-not-supported', message: 'no model' });

    expect(discarded).toEqual([WAV]);
  });

  /*
    And the other half of the rule: the file that *is* reported must survive,
    or the caller uploads a path to something already deleted.
  */
  it('does not discard the one it hands over with the result', async () => {
    const discarded: string[] = [];
    const session = await listen({
      captureAudio: KEPT,
      onDiscardAudio: (uri) => discarded.push(uri),
    });
    emit('audiostart', { uri: WAV });
    emit('result', final('book the dentist on Tuesday at three'));
    emit('end');

    expect(session.final.mock.calls[0]![0]!.audioUri).toBe(WAV);
    expect(discarded).toEqual([]);
  });
});
