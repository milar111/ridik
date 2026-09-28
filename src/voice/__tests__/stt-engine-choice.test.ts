/**
 * Which engine gets the microphone.
 *
 * `../stt` is one door with two engines behind it, and the choice is made
 * there rather than by a setting — so this is the only place that says, in a
 * form that fails, that an iPhone with Apple's analyzer does not use
 * `SFSpeechRecognizer`, that everything else still does, and that a phone
 * which promises the analyzer and then cannot start it gets a working
 * recogniser rather than an error.
 */
import { resetClock, setClock } from '@/core/clock';
import type { SttListenOptions } from '../types';

type Handler = (event: unknown) => void;
const recogniserHandlers = new Map<string, Handler[]>();
const analyzerHandlers = new Map<string, Handler[]>();

function subscribe(store: Map<string, Handler[]>) {
  return (name: string, handler: Handler) => {
    const list = store.get(name) ?? [];
    list.push(handler);
    store.set(name, list);
    return {
      remove() {
        store.set(name, (store.get(name) ?? []).filter((entry) => entry !== handler));
      },
    };
  };
}

const mockRecogniser = {
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  isRecognitionAvailable: jest.fn(),
  supportsOnDeviceRecognition: jest.fn(),
  getSupportedLocales: jest.fn(),
  start: jest.fn(),
  stop: jest.fn(),
  abort: jest.fn(),
  addListener: jest.fn(),
};

let analyzerSupported = true;

const mockAnalyzer = {
  get isSupported() {
    return analyzerSupported;
  },
  describe: jest.fn(),
  install: jest.fn(),
  start: jest.fn(),
  stop: jest.fn(),
  abort: jest.fn(),
  addListener: jest.fn(),
};

jest.mock('expo-speech-recognition', () => ({
  get ExpoSpeechRecognitionModule() {
    return mockRecogniser;
  },
  TaskHintIOS: { dictation: 'dictation' },
}));

// A proxy, because `../apple` captures the module at import time and this
// factory runs before the object below is initialised — see the long note in
// `apple-session.test.ts`.
jest.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () =>
    new Proxy(
      {},
      { get: (_target, key: string) => (mockAnalyzer as unknown as Record<string, unknown>)[key] },
    ),
}));

import { abortListening, startListening, stopListening } from '../stt';
import { resetAppleAnalyzerCache } from '../apple';

let clock = 0;

function options(): SttListenOptions {
  return { onFinal: jest.fn(), onError: jest.fn(), onPartial: jest.fn() };
}

beforeEach(() => {
  clock = 0;
  setClock(() => clock);
  recogniserHandlers.clear();
  analyzerHandlers.clear();
  analyzerSupported = true;

  mockRecogniser.getPermissionsAsync.mockImplementation(async () => ({
    granted: true,
    canAskAgain: true,
  }));
  mockRecogniser.requestPermissionsAsync.mockImplementation(async () => ({
    granted: true,
    canAskAgain: true,
  }));
  mockRecogniser.isRecognitionAvailable.mockImplementation(() => true);
  mockRecogniser.supportsOnDeviceRecognition.mockImplementation(() => true);
  mockRecogniser.getSupportedLocales.mockImplementation(async () => ({ installedLocales: ['en-US'] }));
  mockRecogniser.addListener.mockImplementation(subscribe(recogniserHandlers));

  mockAnalyzer.describe.mockImplementation(async () => ({ locale: 'en-US', status: 'installed' }));
  mockAnalyzer.install.mockImplementation(async () => undefined);
  mockAnalyzer.start.mockImplementation(async () => undefined);
  mockAnalyzer.stop.mockImplementation(async () => ({ text: 'heard it', confidence: 0.9 }));
  mockAnalyzer.abort.mockImplementation(async () => undefined);
  mockAnalyzer.addListener.mockImplementation(subscribe(analyzerHandlers));

  resetAppleAnalyzerCache();
});

afterEach(() => {
  abortListening();
  resetClock();
});

it('gives the microphone to the analyzer when the model is installed', async () => {
  const started = await startListening(options());

  expect(started.ok).toBe(true);
  expect(mockAnalyzer.start).toHaveBeenCalledWith('en-US', []);
  // The whole point: the four-times-worse engine is not consulted.
  expect(mockRecogniser.start).not.toHaveBeenCalled();
});

it("hands the analyzer the user's own names", async () => {
  await startListening({ ...options(), contextualStrings: ['Ivo', 'Raisen'] });
  expect(mockAnalyzer.start).toHaveBeenCalledWith('en-US', ['Ivo', 'Raisen']);
});

it('uses the platform recogniser when the analyzer is absent', async () => {
  analyzerSupported = false;
  const started = await startListening(options());

  expect(started.ok).toBe(true);
  expect(mockRecogniser.start).toHaveBeenCalledTimes(1);
  expect(mockAnalyzer.start).not.toHaveBeenCalled();
  // Never asked, either: an absent framework is not worth a round trip.
  expect(mockAnalyzer.describe).not.toHaveBeenCalled();
});

it('uses the platform recogniser while the model is still downloading', async () => {
  mockAnalyzer.describe.mockImplementation(async () => ({ locale: 'en-US', status: 'supported' }));
  const started = await startListening(options());

  expect(started.ok).toBe(true);
  expect(mockRecogniser.start).toHaveBeenCalledTimes(1);
  expect(mockAnalyzer.start).not.toHaveBeenCalled();
  // …and the model is fetched for next time, without anybody waiting.
  expect(mockAnalyzer.install).toHaveBeenCalledWith('en-US');
});

it('falls back to the recogniser when the analyzer will not start, silently', async () => {
  mockAnalyzer.start.mockImplementation(() =>
    Promise.reject(Object.assign(new Error('busy'), { code: 'ERR_SPEECH_BUSY' })),
  );
  const listeners = options();
  const started = await startListening(listeners);

  expect(started.ok).toBe(true);
  expect(mockRecogniser.start).toHaveBeenCalledTimes(1);
  // The user is talking to a working recogniser, so there is nothing to say.
  expect(listeners.onError).not.toHaveBeenCalled();
});

it('is the analyzer that gets stopped, not the recogniser', async () => {
  await startListening(options());
  stopListening();

  expect(mockAnalyzer.stop).toHaveBeenCalledTimes(1);
  expect(mockRecogniser.stop).not.toHaveBeenCalled();
});

it('is the recogniser that gets stopped when it is the one listening', async () => {
  analyzerSupported = false;
  await startListening(options());
  stopListening();

  expect(mockRecogniser.stop).toHaveBeenCalledTimes(1);
  expect(mockAnalyzer.stop).not.toHaveBeenCalled();
});

it('skips the analyzer when the caller has refused on-device recognition', async () => {
  // Nothing in the app sets this, but the option says "skip the on-device
  // attempt" and the analyzer is the on-device attempt.
  const started = await startListening({ ...options(), preferOnDevice: false });

  expect(started.ok).toBe(true);
  expect(mockAnalyzer.start).not.toHaveBeenCalled();
  expect(mockAnalyzer.describe).not.toHaveBeenCalled();
  expect(mockRecogniser.start).toHaveBeenCalledTimes(1);
});

it('aborts the analyzer before starting the recogniser on the next turn', async () => {
  // The engine of the *previous* turn is what an abort has to reach, which is
  // why `../stt` never resets its record of it on settle.
  await startListening(options());
  expect(mockAnalyzer.start).toHaveBeenCalledTimes(1);

  analyzerSupported = false;
  resetAppleAnalyzerCache();
  await startListening(options());

  expect(mockAnalyzer.abort).toHaveBeenCalled();
  expect(mockRecogniser.start).toHaveBeenCalledTimes(1);
});
