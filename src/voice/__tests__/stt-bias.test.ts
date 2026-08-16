/**
 * The last hop of the personal dictionary: what the native recogniser is
 * actually started with.
 *
 * `startListening` built its options from six fixed fields and never mentioned
 * the user's own words, so every name they had invented — a colleague, a
 * company, a list — was decoded against a general vocabulary that has never
 * met any of them. This is the one place that can be fixed; by the time a
 * transcript exists the wrong word is indistinguishable from the right one.
 */
const mockStart = jest.fn();
const mockAbort = jest.fn();

jest.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: {
    getPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
    requestPermissionsAsync: async () => ({ granted: true }),
    isRecognitionAvailable: () => true,
    supportsOnDeviceRecognition: () => true,
    getSupportedLocales: async () => ({ installedLocales: ['en-US'] }),
    start: (options: unknown) => mockStart(options),
    stop: jest.fn(),
    abort: () => mockAbort(),
    addListener: () => ({ remove: () => {} }),
  },
  TaskHintIOS: { dictation: 'dictation' },
}));

import { abortListening, startListening } from '@/voice/stt';
import { CONTEXTUAL_STRINGS_CAP } from '@/voice/types';

const optionsOf = (): Record<string, unknown> =>
  (mockStart.mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;

afterEach(() => {
  // The session owns an interval and the microphone; a test that leaves one
  // running leaks both into the next one.
  abortListening();
});

describe('the recogniser is told the user\'s own names', () => {
  it('passes them through as contextualStrings', async () => {
    await startListening({ onFinal: () => {}, contextualStrings: ['Ivo Petrov', 'Vitosha'] });

    expect(optionsOf().contextualStrings).toEqual(['Ivo Petrov', 'Vitosha']);
    // Everything the session already sent still goes with it.
    expect(optionsOf()).toMatchObject({ lang: 'en-US', interimResults: true, continuous: true });
  });

  it('sends exactly what it always did when there are none', async () => {
    await startListening({ onFinal: () => {} });
    expect(optionsOf()).not.toHaveProperty('contextualStrings');

    abortListening();
    await startListening({ onFinal: () => {}, contextualStrings: [] });
    expect(optionsOf()).not.toHaveProperty('contextualStrings');
  });

  /* The builder caps its own output, but this is the boundary the native
     module sits behind: an oversized bias list is not rejected anywhere, it
     just quietly makes recognition worse. */
  it('clamps a list somebody else built too long', async () => {
    const many = Array.from({ length: CONTEXTUAL_STRINGS_CAP * 3 }, (_, i) => `Name ${i}`);
    await startListening({ onFinal: () => {}, contextualStrings: many });

    expect(optionsOf().contextualStrings).toHaveLength(CONTEXTUAL_STRINGS_CAP);
    expect((optionsOf().contextualStrings as string[])[0]).toBe('Name 0');
  });
});
