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
// The build-time backend URL. Empty by default, so most of these tests
// exercise the personal-key path; the hosted block below fills it in, because
// the hosted path is the one that actually ships and it went unbudgeted for a
// release by being tested somewhere else.
const mockExtra: Record<string, unknown> = {};
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { get extra() { return mockExtra; } } },
}));

const mockSetItem = jest.fn(async (key: string, value: string) => {
  mockSecrets.set(key, value);
});
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'after-first-unlock',
  getItemAsync: (key: string, ...rest: unknown[]) => mockGetItem(key, ...(rest as [])),
  setItemAsync: (key: string, value: string) => mockSetItem(key, value),
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
const mockCheck = jest.fn(async () => ({ ok: true as const, value: {} }));
const mockRecord = jest.fn(async () => {});
// Only the meter is faked. The cap vocabulary is real, because the assertions
// below are about the resolver and this file agreeing on it — a `limitOf` that
// came back from a mock would agree with anything.
jest.mock('@/llm/usage', () => ({
  ...jest.requireActual('@/llm/usage'),
  createUsageMeter: () => ({ check: mockCheck, record: mockRecord }),
}));

jest.mock('@/repositories', () => ({
  getRepositories: () => ({
    db: {},
    settings: {
      getAll: async () => ({ ...mockSettings }),
      get: async (key: string) => mockSettings[key],
      set: async (key: string, value: unknown) => {
        mockSettings[key] = value;
        return value;
      },
      // The real one does the read and the write inside one queued job; what
      // matters here is only that the pipeline reaches for it rather than for
      // a get/set pair of its own.
      bump: async (key: string, by: number) => {
        const next = Math.max(0, Math.trunc((mockSettings[key] as number) ?? 0) + by);
        mockSettings[key] = next;
        return next;
      },
    },
  }),
}));

import { AppError } from '@/core/result';
import {
  ASSISTANT_TOKEN_STORE_KEY,
  createVoicePipeline,
  LLM_API_KEY_STORE_KEY,
  resetVoicePipeline,
  WHISPER_API_KEY_STORE_KEY,
} from '@/features/voice/pipeline';
import { limitOf, UNLIMITED } from '@/llm/usage';
import {
  TRIAL_LIMIT_MESSAGE,
  TRIAL_TOTAL_REQUESTS,
  TRIAL_TOTAL_TOKENS,
} from '@/services/billing/allowance';
import {
  FREE,
  registerBillingProvider,
  type BillingProvider,
  type Entitlement,
} from '@/services/billing/entitlement';

const DEFAULTS = {
  ttsEnabled: true,
  ttsRate: 1,
  whisperFallbackEnabled: false,
  voiceConfidenceThreshold: 0.7,
  silenceTimeoutMs: 1500,
  llmModel: 'claude-opus-5',
  llmDailyRequestCap: 200,
  llmMonthlyRequestCap: 3_000,
  llmTrialRequestsUsed: 0,
  llmTrialTokensUsed: 0,
  simulateStoreBuild: false,
};

/**
 * A store, or the absence of one. Registered in every test rather than left
 * unset: with no provider at all `currentEntitlement()` sits on its five-second
 * startup timeout, and the difference between "no store in this build" and
 * "the store says free" is the thing under test here.
 */
const billing = (sells: boolean, current: Entitlement = FREE): BillingProvider => ({
  name: sells ? 'stub-store' : 'stub-personal',
  sells,
  configure: async () => {},
  plans: async () => [],
  marketing: async () => null,
  current: async () => current,
  purchase: async () => current,
  restore: async () => current,
  manageUrl: () => 'https://example.test',
});

const subscribed = (tier: Entitlement['tier']): Entitlement => ({
  ...FREE,
  active: true,
  plan: 'monthly',
  tier,
  store: 'app-store',
});

/** A turn that actually reached the model. */
const modelSpoke = {
  transcript: '',
  feedback: 'Done.',
  items: [],
  usage: { model: 'gemini-flash-latest', inputTokens: 7_240, outputTokens: 120 },
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
  for (const key of Object.keys(mockExtra)) delete mockExtra[key];
  resetVoicePipeline();
  for (const key of Object.keys(mockSettings)) delete mockSettings[key];
  Object.assign(mockSettings, DEFAULTS);
  mockInterpret.mockResolvedValue({ transcript: '', feedback: 'Done.', items: [] });
  mockCheck.mockResolvedValue({ ok: true as const, value: {} });
  // A personal build unless a test says otherwise: no store was compiled in.
  registerBillingProvider(billing(false));
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

/**
 * The money gate, through the pipeline rather than through the resolver.
 *
 * `allowance.test.ts` covers the decision; what is worth asserting here is that
 * the decision reaches the provider choice — that a locked turn issues no
 * billable call at all, still answers, and says so.
 */
describe('what a turn is allowed to cost', () => {
  beforeEach(() => {
    mockSecrets.set(LLM_API_KEY_STORE_KEY, 'a-personal-key');
    mockInterpret.mockResolvedValue(modelSpoke);
  });

  /* The build this app is developed on. Nothing was ever for sale here, the
     invoice belongs to whoever pasted the key, and it keeps its own caps. */
  it('leaves a build with no store on the developer caps', async () => {
    const outcome = await createVoicePipeline().process('note the resistors');

    // Exactly the ceilings the resolver decided, in the meter's own units and
    // unreinterpreted on the way: one decision, one measurement.
    expect(mockCheck).toHaveBeenCalledWith(
      { daily: { requests: limitOf(200) }, monthly: { requests: limitOf(3_000) } },
      // The projection is handed down rather than left to the meter's rolling
      // average, which describes turns already recorded and so waves the first
      // big one through at the size of a small one.
      { estimate: { tokens: expect.any(Number) } },
    );
    expect(mockRecord).toHaveBeenCalled();
    expect(outcome.notice).toBeUndefined();
    expect(mockSettings.llmTrialRequestsUsed).toBe(0);
  });

  it('gives a subscriber the plan allowance, floored by the local brake', async () => {
    registerBillingProvider(billing(true, subscribed('light')));

    await createVoicePipeline().process('note the resistors');

    expect(mockCheck).toHaveBeenCalledWith(
      { daily: { requests: limitOf(200) }, monthly: { requests: limitOf(300) } },
      expect.anything(),
    );
    expect(mockSettings.llmTrialRequestsUsed).toBe(0);
  });

  /* TIER_ALLOWANCE.unlimited is 0, the same number free answers with. Locking
     on that alone would have taken the top plan down with the free tier. */
  it('does not lock the Unlimited tier along with the free one', async () => {
    registerBillingProvider(billing(true, subscribed('unlimited')));

    const outcome = await createVoicePipeline().process('note the resistors');

    expect(mockRecord).toHaveBeenCalled();
    expect(outcome.notice).toBeUndefined();
  });

  it('spends the lifetime trial when the store says the user is free', async () => {
    registerBillingProvider(billing(true));

    await createVoicePipeline().process('note the resistors');

    expect(mockRecord).toHaveBeenCalled();
    expect(mockSettings.llmTrialRequestsUsed).toBe(1);
    // In both units, because 25 requests is 25 *turns* and one turn dragging a
    // huge context bills like fifty. The token half is a lifetime ledger of its
    // own rather than a cap on the meter: the meter counts a day and a calendar
    // month out of a table that has no idea who paid for what is in it.
    expect(mockSettings.llmTrialTokensUsed).toBe(7_240 + 120);
    // And the meter is left with nothing but the operator's own brakes.
    expect(mockCheck).toHaveBeenCalledWith(
      { daily: { requests: limitOf(200) }, monthly: { requests: limitOf(3_000) } },
      expect.anything(),
    );
  });

  /* The whole point. Not a slower assistant, not a smaller one — no request. */
  it('issues no billable call once the trial is spent, and says why', async () => {
    registerBillingProvider(billing(true));
    mockSettings.llmTrialRequestsUsed = TRIAL_TOTAL_REQUESTS;

    const outcome = await createVoicePipeline().process('note the resistors');

    expect(mockRecord).not.toHaveBeenCalled();
    expect(outcome.notice).toMatch(/free assistant requests/i);
    expect(outcome.noticeAction).toEqual({ label: 'See plans', href: '/plans' });
    // Voice is not bricked: the offline matcher still answered the utterance.
    expect(mockInterpret).toHaveBeenCalled();
    expect(outcome.items).toBeDefined();
  });

  /* A month rolling over is what a free monthly allowance would forgive. This
     one is counted for the life of the install, so there is nothing to wait
     for — the same lock, on any day, from any number above the total. */
  it('cannot be waited out', async () => {
    registerBillingProvider(billing(true));
    mockSettings.llmTrialRequestsUsed = TRIAL_TOTAL_REQUESTS + 500;

    const outcome = await createVoicePipeline().process('note the resistors');
    expect(mockRecord).not.toHaveBeenCalled();
    expect(outcome.notice).toBeTruthy();
  });

  it('warns before it locks rather than after', async () => {
    registerBillingProvider(billing(true));
    mockSettings.llmTrialRequestsUsed = TRIAL_TOTAL_REQUESTS - 2;

    const outcome = await createVoicePipeline().process('note the resistors');

    expect(mockRecord).toHaveBeenCalled();
    expect(outcome.notice).toMatch(/1 free assistant request left/);
  });

  /* Answering "yes" to a pending clarification never reaches the model — the
     orchestrator applies the stored action. Charging for it would burn a trial
     request on a turn that cost nothing. */
  it('does not charge the trial for a turn that never called the model', async () => {
    registerBillingProvider(billing(true));
    mockInterpret.mockResolvedValue({ transcript: 'yes', feedback: 'Booked.', items: [] });

    await createVoicePipeline().process('yes', { pending: '{"v":1}' });

    expect(mockSettings.llmTrialRequestsUsed).toBe(0);
  });

  /* The transport ladder can bill five attempts and return no usage at all. A
     trial that only counted successes would be spendable forever. */
  it('charges the trial for a failed turn that still reached the provider', async () => {
    registerBillingProvider(billing(true));
    mockInterpret.mockResolvedValue({ transcript: '', feedback: 'That did not work.', items: [] });

    await createVoicePipeline().process('note the resistors');

    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockSettings.llmTrialRequestsUsed).toBe(1);
    // It billed something; "we could not find out how much" must not be free.
    expect(mockSettings.llmTrialTokensUsed).toBeGreaterThan(0);
  });

  /* A database that will not open is not a way to get another 25 requests. */
  it('treats an unreadable settings row as a spent trial, not a fresh one', async () => {
    registerBillingProvider(billing(true));
    const repos = jest.requireMock('@/repositories') as { getRepositories: () => unknown };
    const original = repos.getRepositories;
    repos.getRepositories = () => ({
      db: {},
      settings: {
        getAll: async () => {
          throw new Error('database is locked');
        },
        get: async () => undefined,
        set: async () => undefined,
      },
    });

    try {
      const outcome = await createVoicePipeline().process('note the resistors');
      expect(mockRecord).not.toHaveBeenCalled();
      expect(outcome.notice).toBeTruthy();
    } finally {
      repos.getRepositories = original;
    }
  });

  /* The same failure on a personal build must not lock anything: there is no
     trial there to be unsure about. */
  it('still answers on a personal build when the settings cannot be read', async () => {
    const repos = jest.requireMock('@/repositories') as { getRepositories: () => unknown };
    const original = repos.getRepositories;
    repos.getRepositories = () => ({
      db: {},
      settings: {
        getAll: async () => {
          throw new Error('database is locked');
        },
        get: async () => undefined,
        set: async () => undefined,
      },
    });

    try {
      const outcome = await createVoicePipeline().process('note the resistors');
      expect(outcome.notice).toBeUndefined();
      expect(mockRecord).toHaveBeenCalled();
    } finally {
      repos.getRepositories = original;
    }
  });

  /* No store keys on a simulator, so the lock would otherwise be unreviewable
     until the products exist in App Store Connect. */
  it('can be exercised on a personal build through the developer override', async () => {
    mockSettings.simulateStoreBuild = true;
    mockSettings.llmTrialRequestsUsed = TRIAL_TOTAL_REQUESTS;

    const outcome = await createVoicePipeline().process('note the resistors');

    expect(mockRecord).not.toHaveBeenCalled();
    expect(outcome.notice).toBeTruthy();
  });

  /* The cap that already existed still reports through the same channel. */
  it('passes a spent daily cap through as a notice with a way out', async () => {
    mockCheck.mockResolvedValue({
      ok: false,
      error: new AppError('rate_limited', "You've used today's 200 assistant requests."),
    } as never);

    const outcome = await createVoicePipeline().process('note the resistors');

    expect(mockRecord).not.toHaveBeenCalled();
    expect(outcome.notice).toMatch(/today/);
  });

  /* The token tripwire is the trial's own, and so is the sentence.
     Every message the meter owns ends on something resetting, which is true of
     a day's cap and false of a lifetime allowance: one turn worth fifty must
     not be told to come back at midnight. It no longer goes through the meter
     at all — a lifetime budget measured in a monthly window is a budget you can
     wait out, and the window in question is full of other people's paid
     traffic. */
  it('stops a free user on tokens without promising them a reset', async () => {
    registerBillingProvider(billing(true));
    mockSettings.llmTrialTokensUsed = TRIAL_TOTAL_TOKENS;

    const outcome = await createVoicePipeline().process('note the resistors');

    expect(mockRecord).not.toHaveBeenCalled();
    expect(outcome.notice).toBe(TRIAL_LIMIT_MESSAGE);
    expect(outcome.notice).not.toMatch(/midnight/);
    expect(outcome.noticeAction).toEqual({ label: 'See plans', href: '/plans' });
    // Still answered, and no trial request spent on a turn that never ran.
    expect(mockInterpret).toHaveBeenCalled();
    expect(mockSettings.llmTrialRequestsUsed).toBe(0);
  });

  /* One utterance nobody could have meant. It is refused before it is sent and
     before it costs a request, and the offline matcher files it as a note —
     which for a paste that size is what the user wanted anyway. */
  it('refuses a single enormous turn rather than billing it', async () => {
    registerBillingProvider(billing(true));

    const outcome = await createVoicePipeline().process('x'.repeat(1_000_000));

    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockSettings.llmTrialRequestsUsed).toBe(0);
    expect(outcome.notice).toMatch(/too much to send/i);
    expect(mockInterpret).toHaveBeenCalled();
  });

  /* The same paste on a build running on the user's own key is their business:
     they pasted the key, the invoice is theirs. */
  it('lets a personal build send whatever it likes', async () => {
    const outcome = await createVoicePipeline().process('x'.repeat(1_000_000));
    expect(mockRecord).toHaveBeenCalled();
    expect(outcome.notice).toBeUndefined();
  });

  /**
   * The regression that took the product away from the people who paid for it.
   *
   * A store read that throws used to come back as `FREE`, which on a store
   * build is indistinguishable from "chose not to pay" — so a subscriber whose
   * trial counter was spent before they subscribed got hard-locked out of the
   * assistant by one network blink, and every turn during the outage marched
   * that counter closer to 25 for the next time.
   */
  describe('when the store cannot be reached', () => {
    const unreachable = (): BillingProvider => ({
      ...billing(true),
      current: async () => {
        throw new Error('network request failed');
      },
    });

    it('keeps the assistant working for somebody who may well have paid', async () => {
      registerBillingProvider(unreachable());
      mockSettings.llmTrialRequestsUsed = TRIAL_TOTAL_REQUESTS;

      const outcome = await createVoicePipeline().process('note the resistors');

      expect(mockRecord).toHaveBeenCalled();
      expect(outcome.notice).toBeUndefined();
    });

    it('charges nothing to a trial it cannot say is theirs', async () => {
      registerBillingProvider(unreachable());

      await createVoicePipeline().process('note the resistors');

      expect(mockSettings.llmTrialRequestsUsed).toBe(0);
      expect(mockSettings.llmTrialTokensUsed).toBe(0);
    });
  });
});

/**
 * The build that actually ships.
 *
 * `clientForTurn()` used to return the hosted client before the budget was ever
 * consulted, on the grounds that quotas belong to the server. The effect was
 * that every line of the free-tier lock ran only on personal builds — where the
 * invoice belongs to whoever pasted the key — and none of it ran where the
 * invoice belongs to the operator. The server is still the authority; this is
 * the half that stops an unbilled request being made and records what it cost.
 */
describe('a hosted build', () => {
  beforeEach(() => {
    mockExtra.assistantApiUrl = 'https://api.example.test';
    mockSecrets.set(ASSISTANT_TOKEN_STORE_KEY, 'a-session-token');
    mockInterpret.mockResolvedValue(modelSpoke);
    // No RevenueCat keys in this build: the provider that gets registered is
    // the one that cannot sell, and it must not therefore read as personal.
    registerBillingProvider(billing(false));
  });

  it('is a store build even when no store was compiled in', async () => {
    mockSettings.llmTrialRequestsUsed = TRIAL_TOTAL_REQUESTS;

    const outcome = await createVoicePipeline().process('note the resistors');

    expect(outcome.notice).toMatch(/free assistant requests/i);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('spends the trial like any other store build', async () => {
    await createVoicePipeline().process('note the resistors');
    expect(mockSettings.llmTrialRequestsUsed).toBe(1);
  });

  /* The developer sliders are hidden on this build and cannot be adjusted, so
     letting their defaults stand would cap an Unlimited subscriber at 3,000 a
     month behind a control nobody can see. */
  it('does not apply the hidden developer ceilings', async () => {
    registerBillingProvider(billing(true, subscribed('unlimited')));

    await createVoicePipeline().process('note the resistors');

    expect(mockCheck).toHaveBeenCalledWith(
      { daily: { requests: UNLIMITED }, monthly: { requests: UNLIMITED } },
      expect.anything(),
    );
  });

  /* The proxy is the half of this app where prompt caching can actually pay —
     it sends a byte-identical prefix on behalf of every user — so it is the
     only path that can ever report a non-zero `cached`. An unmetered hosted
     turn meant the column could not move, and the read-out for it was drawn
     only on the build guaranteed to have nothing in it. */
  it('records what the turn cost, cached tokens included', async () => {
    mockInterpret.mockResolvedValue({
      ...modelSpoke,
      usage: { model: 'hosted', inputTokens: 7_240, cachedTokens: 4_500, outputTokens: 120, calls: 3 },
    });

    await createVoicePipeline().process('note the resistors');

    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ cachedTokens: 4_500, calls: 3, requests: 1 }),
    );
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
