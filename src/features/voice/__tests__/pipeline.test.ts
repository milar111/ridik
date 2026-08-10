/**
 * The pipeline is the wiring between the native half of a voice turn and the
 * reasoning half, so what is worth testing is the wiring itself: which key is
 * read when, what the dock is told about a rejection, and whether the
 * confidence the recogniser reported survives the trip to the audit trail.
 *
 * Every native module is replaced by a factory. The orchestrator is too — it
 * has its own suite against a real database, and here it is only a spy on what
 * the pipeline decided to hand it.
 */
const mockSecrets = new Map<string, string>();
const mockGetItem = jest.fn(async (key: string) => mockSecrets.get(key) ?? null);
// The build-time backend URL. Empty here, so these tests exercise the
// personal-key path; the hosted path has its own suite.
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'after-first-unlock',
  getItemAsync: (key: string, ...rest: unknown[]) => mockGetItem(key, ...(rest as [])),
}));

const mockCapture = jest.fn();
const mockSpeak = jest.fn(async () => {});
const mockStopStt = jest.fn(async () => {});
const mockStopTts = jest.fn(async () => {});
jest.mock('@/voice', () => ({
  captureUtterance: (...args: unknown[]) => mockCapture(...args),
  speak: (...args: unknown[]) => mockSpeak(...(args as [])),
  stopListening: () => mockStopStt(),
  stopSpeaking: () => mockStopTts(),
}));

const mockInterpret = jest.fn();
jest.mock('@/llm/orchestrator', () => ({
  createOrchestrator: () => ({ interpretAndExecute: mockInterpret, zone: 'Europe/Sofia' }),
}));

jest.mock('@/services/notifications', () => ({
  CHANNELS: { reminders: 'reminders' },
  scheduleAt: jest.fn(async () => ({ ok: true, value: 'notification-id' })),
  cancelForEntity: jest.fn(async () => {}),
}));
jest.mock('@/services/focus', () => ({ focusEffects: {} }));
jest.mock('@/services/geofence', () => ({ refresh: jest.fn(async () => {}) }));
jest.mock('@/services/calendar', () => ({ pushEventNow: jest.fn(async () => {}) }));
jest.mock('@/features/briefing', () => ({ briefingScript: jest.fn(async () => 'brief') }));
jest.mock('@/startup/bootstrap', () => ({ registerBootstrapStep: jest.fn() }));

const mockSettings: Record<string, unknown> = {};
jest.mock('@/repositories', () => ({
  getRepositories: () => ({
    settings: {
      getAll: async () => ({ ...mockSettings }),
      get: async (key: string) => mockSettings[key],
    },
  }),
}));

import { AppError } from '@/core/result';
import {
  createVoicePipeline,
  LLM_API_KEY_STORE_KEY,
  resetVoicePipeline,
  WHISPER_API_KEY_STORE_KEY,
} from '@/features/voice/pipeline';

const DEFAULTS = {
  ttsEnabled: true,
  ttsRate: 1,
  whisperFallbackEnabled: false,
  voiceConfidenceThreshold: 0.7,
  silenceTimeoutMs: 1500,
  llmModel: 'claude-opus-5',
};

const heard = (transcript: string, confidence: number | null) => ({
  ok: true as const,
  value: { transcript, confidence, source: 'ondevice' as const },
});

const rejected = (code: string, message: string, reason?: string) => ({
  ok: false as const,
  error: new AppError(code as 'invalid_input', message, {
    ...(reason ? { details: { reason } } : {}),
  }),
});

const noHandlers = { onPartial: () => {}, onFinal: () => {}, onError: () => {} };

beforeEach(() => {
  mockSecrets.clear();
  resetVoicePipeline();
  for (const key of Object.keys(mockSettings)) delete mockSettings[key];
  Object.assign(mockSettings, DEFAULTS);
  mockInterpret.mockResolvedValue({ transcript: '', feedback: 'Done.', items: [] });
});

describe('listen', () => {
  it('passes the recogniser its settings and forwards the final transcript', async () => {
    mockCapture.mockResolvedValue(heard('note the resistors', 0.91));
    const onFinal = jest.fn();

    await createVoicePipeline().listen({ ...noHandlers, onFinal });

    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({ minConfidence: 0.7, silenceTimeoutMs: 1500 }),
    );
    expect(onFinal).toHaveBeenCalledWith('note the resistors', 0.91);
  });

  it('only unlocks Whisper when the user has opted in and a key is stored', async () => {
    mockCapture.mockResolvedValue(heard('hello', null));
    mockSecrets.set(WHISPER_API_KEY_STORE_KEY, 'whisper-key');

    await createVoicePipeline().listen(noHandlers);
    expect(mockCapture.mock.calls[0]![0].whisper).toEqual({ enabled: false, apiKey: null });
    expect(mockGetItem).not.toHaveBeenCalledWith(WHISPER_API_KEY_STORE_KEY, expect.anything());

    mockSettings.whisperFallbackEnabled = true;
    await createVoicePipeline().listen(noHandlers);
    expect(mockCapture.mock.calls[1]![0].whisper).toEqual({
      enabled: true,
      apiKey: 'whisper-key',
    });
  });

  it.each([
    ['empty', 'empty'],
    ['low_confidence', 'low_confidence'],
    // Nothing in the dock distinguishes "too short" from "too quiet"; both are
    // an offer to say it again, and the store only understands two words.
    ['too_short', 'low_confidence'],
  ])('turns a %p rejection into a retryable %p for the dock', async (reason, expected) => {
    mockCapture.mockResolvedValue(rejected('invalid_input', 'I did not catch that.', reason));
    const onError = jest.fn();

    await createVoicePipeline().listen({ ...noHandlers, onError });

    expect(onError).toHaveBeenCalledWith('I did not catch that.', expected);
  });

  it('leaves a denied microphone as the error it is, so the dock does not offer a retry', async () => {
    mockCapture.mockResolvedValue(
      rejected('permission_denied', 'Ridik needs the microphone to listen.'),
    );
    const onError = jest.fn();

    await createVoicePipeline().listen({ ...noHandlers, onError });

    expect(onError).toHaveBeenCalledWith(
      'Ridik needs the microphone to listen.',
      'permission_denied',
    );
  });

  it('degrades to the recogniser defaults when the settings cannot be read', async () => {
    mockCapture.mockResolvedValue(heard('hello', null));
    const repos = jest.requireMock('@/repositories') as { getRepositories: () => unknown };
    const original = repos.getRepositories;
    repos.getRepositories = () => ({
      settings: {
        getAll: async () => {
          throw new Error('database is locked');
        },
      },
    });

    try {
      await expect(createVoicePipeline().listen(noHandlers)).resolves.toBeUndefined();
      const options = mockCapture.mock.calls.at(-1)![0];
      expect(options.minConfidence).toBeUndefined();
      expect(options.whisper).toEqual({ enabled: false, apiKey: null });
    } finally {
      repos.getRepositories = original;
    }
  });
});

describe('process', () => {
  it('carries the confidence of the utterance it actually heard into the turn', async () => {
    const pipeline = createVoicePipeline();
    mockCapture.mockResolvedValue(heard('note the resistors', 0.42));
    await pipeline.listen(noHandlers);

    await pipeline.process('note the resistors');

    expect(mockInterpret).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: 'note the resistors', confidence: 0.42 }),
    );
  });

  it('refuses to attach that confidence to text the user typed instead', async () => {
    const pipeline = createVoicePipeline();
    mockCapture.mockResolvedValue(heard('note the resistors', 0.42));
    await pipeline.listen(noHandlers);

    await pipeline.process('note the capacitors');

    expect(mockInterpret).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: 'note the capacitors', confidence: null }),
    );
  });

  it('does not reuse a confidence across two turns', async () => {
    const pipeline = createVoicePipeline();
    mockCapture.mockResolvedValue(heard('note the resistors', 0.42));
    await pipeline.listen(noHandlers);

    await pipeline.process('note the resistors');
    await pipeline.process('note the resistors');

    expect(mockInterpret.mock.calls[1]![0].confidence).toBeNull();
  });

  it('forwards the pending clarification and hands the outcome back to the dock', async () => {
    mockInterpret.mockResolvedValue({
      transcript: 'yes',
      feedback: 'Booked.',
      items: [{ toolName: 'calendar_add', ok: true, summary: 'Booked.', href: '/calendar' }],
      clarification: undefined,
    });

    const outcome = await createVoicePipeline().process('yes', { pending: '{"v":1}' });

    expect(mockInterpret).toHaveBeenCalledWith(expect.objectContaining({ pending: '{"v":1}' }));
    expect(outcome).toEqual({
      transcript: 'yes',
      speak: true,
      feedback: 'Booked.',
      items: [{ toolName: 'calendar_add', ok: true, summary: 'Booked.', href: '/calendar' }],
    });
  });

  it('reads the assistant key from the keychain on every turn, never from SQLite', async () => {
    const pipeline = createVoicePipeline();
    await pipeline.process('one');
    mockSecrets.set(LLM_API_KEY_STORE_KEY, 'a-key-pasted-mid-session');
    await pipeline.process('two');

    const reads = mockGetItem.mock.calls.filter(([key]) => key === LLM_API_KEY_STORE_KEY);
    expect(reads).toHaveLength(2);
  });

  it('survives a keychain that will not open', async () => {
    mockGetItem.mockRejectedValueOnce(new Error('keychain locked'));
    await expect(createVoicePipeline().process('note the resistors')).resolves.toMatchObject({
      feedback: 'Done.',
    });
  });
});

describe('speak', () => {
  it('says the sentence at the configured rate', async () => {
    mockSettings.ttsRate = 1.4;
    await createVoicePipeline().speak('Booked.');
    expect(mockSpeak).toHaveBeenCalledWith('Booked.', { rate: 1.4 });
  });

  it('stays quiet when the user muted it', async () => {
    mockSettings.ttsEnabled = false;
    await createVoicePipeline().speak('Booked.');
    expect(mockSpeak).not.toHaveBeenCalled();
  });

  it('does not fail the turn when the speech engine does', async () => {
    mockSpeak.mockRejectedValueOnce(new Error('no voice installed'));
    await expect(createVoicePipeline().speak('Booked.')).resolves.toBeUndefined();
  });
});
