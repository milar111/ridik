/**
 * The decisions in `../apple`, as opposed to its plumbing.
 *
 * Four of them are load-bearing and none is obvious from reading the file:
 *
 *  - **The endpointer is driven by results, because `SpeechAnalyzer` reports no
 *    speech boundaries at all.** So a volatile result that is re-reported
 *    unchanged must not count as speech, or the microphone never stops.
 *  - **Only terminal availability answers are cached.** A model that is a
 *    download away has to be re-asked about, or the app needs restarting
 *    before it can use the engine it just fetched.
 *  - **A start failure is returned, never announced**, because `../stt` falls
 *    back to the platform recogniser and an announced error would resolve the
 *    caller's promise first.
 *  - **A failed finalise still yields the caption.** Most of a sentence beats
 *    none of it, which is the same call `store.ts` makes with `recovered`.
 */
import { resetClock, setClock } from '@/core/clock';
import type { AppError } from '@/core/result';
import type { SttFinalResult, SttListenOptions } from '../types';

type Handler = (event: unknown) => void;
const handlers = new Map<string, Handler[]>();

function emit(name: string, event: unknown = {}): void {
  for (const handler of [...(handlers.get(name) ?? [])]) handler(event);
}

let supported = true;

const mockNative = {
  get isSupported() {
    return supported;
  },
  describe: jest.fn(),
  install: jest.fn(),
  start: jest.fn(),
  stop: jest.fn(),
  abort: jest.fn(),
  addListener: jest.fn(),
};

/**
 * `clearMocks` is on for this project, which strips every implementation
 * before each test — including `addListener`, whose return value the module
 * pushes onto its subscription list. Without restoring it the events are never
 * registered and every assertion here fails for a reason that has nothing to
 * do with what it was testing.
 */
function resetNative(): void {
  mockNative.describe.mockImplementation(async () => ({ locale: 'en-US', status: 'installed' }));
  mockNative.install.mockImplementation(async () => undefined);
  mockNative.start.mockImplementation(async () => undefined);
  mockNative.stop.mockImplementation(async () => ({ text: '', confidence: null }));
  mockNative.abort.mockImplementation(async () => undefined);
  mockNative.addListener.mockImplementation((name: string, handler: Handler) => {
    const list = handlers.get(name) ?? [];
    list.push(handler);
    handlers.set(name, list);
    return {
      remove() {
        handlers.set(name, (handlers.get(name) ?? []).filter((entry) => entry !== handler));
      },
    };
  });
}

/*
 * A forwarding proxy rather than the mock itself.
 *
 * `apple.ts` captures what this returns at *import* time, and babel hoists the
 * `import` below above the `const mockNative` above it — so handing back the
 * object directly hands the module `undefined` for the whole run, and it then
 * reports the analyzer as absent. `stt-session.test.ts` solves the same hazard
 * with a plain getter, which is enough there only because `stt.ts` reads its
 * native module on every call instead of keeping it.
 */
jest.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () =>
    new Proxy(
      {},
      {
        get: (_target, key: string) => (mockNative as unknown as Record<string, unknown>)[key],
      },
    ),
}));

import {
  abortAppleListening,
  appleAnalyzerFor,
  isAppleAnalyzerCompiled,
  resetAppleAnalyzerCache,
  startAppleListening,
} from '../apple';

let clock = 0;

/** Moves the clock and the timers together; a tick reads `now()`. */
async function advance(ms: number): Promise<void> {
  const step = 50;
  for (let moved = 0; moved < ms; moved += step) {
    clock += step;
    await jest.advanceTimersByTimeAsync(step);
  }
}

type Listener = {
  final: jest.Mock<void, [SttFinalResult]>;
  error: jest.Mock<void, [AppError]>;
  partial: jest.Mock<void, [string]>;
  options: SttListenOptions;
};

function listener(): Listener {
  const final = jest.fn();
  const error = jest.fn();
  const partial = jest.fn();
  return {
    final: final as never,
    error: error as never,
    partial: partial as never,
    options: { onFinal: final, onError: error, onPartial: partial },
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  clock = 0;
  setClock(() => clock);
  handlers.clear();
  supported = true;
  resetAppleAnalyzerCache();
  resetNative();
});

afterEach(() => {
  abortAppleListening();
  jest.useRealTimers();
  resetClock();
});

describe('availability', () => {
  it('is absent when the OS is too old, without asking anything else', () => {
    supported = false;
    expect(isAppleAnalyzerCompiled()).toBe(false);
  });

  it('asks once for a model that is already installed', async () => {
    await expect(appleAnalyzerFor('en-US')).resolves.toBe('en-US');
    await expect(appleAnalyzerFor('en-US')).resolves.toBe('en-US');
    expect(mockNative.describe).toHaveBeenCalledTimes(1);
  });

  it('re-asks while a model is only downloadable, and never downloads twice at once', async () => {
    mockNative.describe.mockImplementation(async () => ({ locale: 'en-US', status: 'supported' }));
    // A download that is still running, which is the case the guard is for:
    // somebody speaks again while the model is on its way.
    let release = () => {};
    mockNative.install.mockImplementation(
      () => new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      }),
    );

    // Not ready, so both utterances belong to the platform recogniser.
    await expect(appleAnalyzerFor('en-US')).resolves.toBeNull();
    await expect(appleAnalyzerFor('en-US')).resolves.toBeNull();

    // Asked again — a cached "not yet" would need an app restart to clear.
    expect(mockNative.describe).toHaveBeenCalledTimes(2);
    // …and one download, not one per utterance.
    expect(mockNative.install).toHaveBeenCalledTimes(1);
    expect(mockNative.install).toHaveBeenCalledWith('en-US');
    release();
  });

  it('remembers an unsupported language and stops asking', async () => {
    mockNative.describe.mockImplementation(async () => ({ locale: null, status: 'unsupported' }));
    await expect(appleAnalyzerFor('cy-GB')).resolves.toBeNull();
    await expect(appleAnalyzerFor('cy-GB')).resolves.toBeNull();
    expect(mockNative.describe).toHaveBeenCalledTimes(1);
    expect(mockNative.install).not.toHaveBeenCalled();
  });

  it('treats a probe that throws as a no rather than a broken turn', async () => {
    mockNative.describe.mockImplementation(() => Promise.reject(new Error('nope')));
    await expect(appleAnalyzerFor('en-US')).resolves.toBeNull();
  });
});

describe('one utterance', () => {
  it('ends on trailing silence and reports the analyzer confidence', async () => {
    mockNative.stop.mockImplementation(async () => ({
      text: 'book two hours for the robotics report',
      confidence: 0.91,
    }));
    const heard = listener();
    const started = await startAppleListening(heard.options, 'en-US');
    expect(started.ok).toBe(true);

    emit('onStart');
    emit('onPartial', { text: 'book' });
    await advance(400);
    emit('onPartial', { text: 'book two' });

    // The default trailing silence is 1500ms and nothing more is said.
    await advance(1800);

    expect(heard.final).toHaveBeenCalledTimes(1);
    const result = heard.final.mock.calls[0]![0];
    expect(result.transcript).toBe('book two hours for the robotics report');
    expect(result.confidence).toBe(0.91);
    expect(result.source).toBe('apple');
    expect(result.accept).toBe(true);
    expect(heard.error).not.toHaveBeenCalled();
  });

  it('does not treat an unchanged volatile result as speech', async () => {
    /*
     * The failure this guards is a microphone that never stops. `tick` measures
     * the gap since the last *speech* observation, so re-reporting the same
     * tail during silence would push the deadline out for ever.
     */
    mockNative.stop.mockImplementation(async () => ({ text: 'remind me', confidence: 0.8 }));
    const heard = listener();
    await startAppleListening(heard.options, 'en-US');
    emit('onStart');

    emit('onPartial', { text: 'remind me' });

    // Six seconds of the analyzer saying the same thing. Four times the
    // trailing-silence threshold; the utterance must have ended.
    for (let repeat = 0; repeat < 12; repeat += 1) {
      emit('onPartial', { text: 'remind me' });
      await advance(500);
    }

    expect(heard.final).toHaveBeenCalledTimes(1);
    // And the caption was drawn once, not thirteen times.
    expect(heard.partial).toHaveBeenCalledTimes(1);
  });

  it('ends a one-word utterance without waiting for the hard cap', async () => {
    /*
     * The regression this pins: the endpointer used to carry a 300ms floor on
     * accumulated *speech*, which a single result cannot satisfy because it
     * spans no time at all. "Yes" then held the microphone for a minute.
     */
    mockNative.stop.mockImplementation(async () => ({ text: 'yes', confidence: 0.95 }));
    const heard = listener();
    await startAppleListening(heard.options, 'en-US');
    emit('onStart');

    emit('onPartial', { text: 'yes' });
    await advance(1800);

    expect(heard.final).toHaveBeenCalledTimes(1);
    expect(heard.final.mock.calls[0]![0].transcript).toBe('yes');
  });

  it('finalises at the hard cap even while somebody is still talking', async () => {
    mockNative.stop.mockImplementation(async () => ({ text: 'a very long dictation', confidence: 0.7 }));
    const heard = listener();
    await startAppleListening(heard.options, 'en-US');
    emit('onStart');

    // A new word every half second for over a minute: the endpointer never
    // fires, so only MAX_UTTERANCE_MS can end this.
    for (let word = 0; word < 130; word += 1) {
      emit('onPartial', { text: `word ${word}` });
      await advance(500);
      if (heard.final.mock.calls.length > 0) break;
    }

    expect(heard.final).toHaveBeenCalledTimes(1);
    expect(heard.final.mock.calls[0]![0].transcript).toBe('a very long dictation');
  });
});

describe('failures', () => {
  it('returns a start failure instead of announcing it', async () => {
    // `../stt` falls back to the platform recogniser on this path, and an
    // `onError` here would resolve `listenOnce`'s promise before it could.
    const failure = Object.assign(new Error('busy'), { code: 'ERR_SPEECH_BUSY' });
    mockNative.start.mockImplementation(() => Promise.reject(failure));

    const heard = listener();
    const started = await startAppleListening(heard.options, 'en-US');

    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error.code).toBe('conflict');
    expect(heard.error).not.toHaveBeenCalled();
    expect(heard.final).not.toHaveBeenCalled();
  });

  it('settles with the caption when finalising fails', async () => {
    mockNative.stop.mockImplementation(() => Promise.reject(new Error('finalise blew up')));
    const heard = listener();
    await startAppleListening(heard.options, 'en-US');
    emit('onStart');

    emit('onPartial', { text: 'add milk to the shopping list' });
    await advance(400);
    emit('onPartial', { text: 'add milk to the shopping list please' });
    await advance(1800);

    expect(heard.final).toHaveBeenCalledTimes(1);
    expect(heard.final.mock.calls[0]![0].transcript).toBe('add milk to the shopping list please');
    // Reported as heard, not as an error: the words are the whole point.
    expect(heard.final.mock.calls[0]![0].accept).toBe(true);
    expect(heard.error).not.toHaveBeenCalled();
  });

  it('reports a failed finalise when nothing was heard at all', async () => {
    const failure = Object.assign(new Error('gone'), { code: 'ERR_SPEECH_AUDIO_CAPTURE' });
    mockNative.stop.mockImplementation(() => Promise.reject(failure));
    const heard = listener();
    await startAppleListening(heard.options, 'en-US');
    emit('onStart');

    // A silent room: the endpointer needs `minSpeechMs` before it will fire,
    // so this is the hard cap doing it.
    for (let step = 0; step < 130 && heard.error.mock.calls.length === 0; step += 1) {
      await advance(500);
    }

    expect(heard.error).toHaveBeenCalledTimes(1);
    expect(heard.final).not.toHaveBeenCalled();
  });

  it('gives the microphone back when a session is abandoned', async () => {
    const heard = listener();
    await startAppleListening(heard.options, 'en-US');
    emit('onStart');
    emit('onPartial', { text: 'never mind' });

    abortAppleListening();

    expect(mockNative.abort).toHaveBeenCalled();
    // Abandoning is not a result and not a failure.
    expect(heard.final).not.toHaveBeenCalled();
    expect(heard.error).not.toHaveBeenCalled();
  });
});
