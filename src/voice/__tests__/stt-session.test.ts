/**
 * What the recogniser says on its way out.
 *
 * The engine is a native singleton and this module is the only thing that talks
 * to it, so the events are mocked and delivered by hand — which is the only way
 * to reproduce the thing this file exists for: an Android phone that hands over
 * a perfect transcript and *then* reports an error.
 */
import { AppError, type Result } from '@/core/result';
import type { SttFinalResult, SttListenOptions } from '../types';

type Handler = (event: unknown) => void;
const mockHandlers = new Map<string, Handler[]>();

/** Delivers one recogniser event to everything currently subscribed. */
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

// A getter, not a value: `jest.mock` is hoisted above every `import`, so the
// module under test resolves this before `mockModule` has been initialised and
// would capture `undefined` for the whole run.
jest.mock('expo-speech-recognition', () => ({
  get ExpoSpeechRecognitionModule() {
    return mockModule;
  },
  TaskHintIOS: { dictation: 'dictation' },
}));

import { abortListening, startListening } from '../stt';

/** A final recogniser result carrying one segment. */
function final(transcript: string) {
  return { isFinal: true, results: [{ transcript, confidence: 0 }] };
}

async function listen(): Promise<{
  final: jest.Mock<void, [SttFinalResult]>;
  error: jest.Mock<void, [AppError]>;
  started: Result<void>;
}> {
  const onFinal = jest.fn();
  const onError = jest.fn();
  const options: SttListenOptions = { onFinal, onError };
  const started = await startListening(options);
  emit('start');
  return { final: onFinal as never, error: onError as never, started };
}

afterEach(() => {
  abortListening();
  mockHandlers.clear();
});

describe('an error that arrives after the words did', () => {
  /*
    The bug this was written for. A Galaxy S23 transcribes a whole sentence and
    then fires `ERROR_CLIENT` as the session closes, so the screen said "Speech
    recognition failed." over a transcript that was completely correct and the
    turn never ran. Every single dictation ended that way.
  */
  it('settles with the transcript when `client` follows a final result', async () => {
    const session = await listen();
    emit('result', final('Book two hours for the robotics report on Thursday'));
    emit('error', { error: 'client', message: 'Other client side errors.' });

    expect(session.error).not.toHaveBeenCalled();
    expect(session.final).toHaveBeenCalledTimes(1);
    expect(session.final.mock.calls[0]![0]!.transcript).toBe(
      'Book two hours for the robotics report on Thursday',
    );
  });

  /** Half a sentence is worth incomparably more than an error message. */
  it('settles with the last partial when that is all there is', async () => {
    const session = await listen();
    emit('result', { isFinal: false, results: [{ transcript: 'email the tutor', confidence: 0 }] });
    emit('error', { error: 'client', message: 'Other client side errors.' });

    expect(session.error).not.toHaveBeenCalled();
    expect(session.final.mock.calls[0]![0]!.transcript).toBe('email the tutor');
  });

  /*
    And the other half of the rule. `client` over a microphone that genuinely
    never started is a failure, and reporting it as silence would replace one
    wrong message with a quieter one.
  */
  it('still fails when `client` arrives with nothing heard', async () => {
    const session = await listen();
    emit('error', { error: 'client', message: 'Other client side errors.' });

    expect(session.final).not.toHaveBeenCalled();
    expect(session.error).toHaveBeenCalledTimes(1);
    expect(session.error.mock.calls[0]![0]!.message).toContain('Speech recognition failed.');
  });

  /** A real failure is still a real failure, transcript or no transcript. */
  it('does not extend the reprieve to other codes', async () => {
    const session = await listen();
    emit('result', final('Book two hours'));
    emit('error', { error: 'audio-capture', message: 'Audio recording error.' });

    expect(session.final).not.toHaveBeenCalled();
    expect(session.error).toHaveBeenCalledTimes(1);
  });

  /** The engine's trailing `end` must not settle a second time. */
  it('reports the utterance once, however many farewells arrive', async () => {
    const session = await listen();
    emit('result', final('Book two hours'));
    emit('error', { error: 'client', message: 'Other client side errors.' });
    emit('error', { error: 'client', message: 'Other client side errors.' });
    emit('end');

    expect(session.final).toHaveBeenCalledTimes(1);
  });
});
