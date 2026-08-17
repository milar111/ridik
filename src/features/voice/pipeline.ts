/**
 * The concrete voice pipeline: microphone in, database and speech out.
 *
 * This is the only file that knows both halves of a voice turn — the native
 * side (`@/voice`, SecureStore, notifications) and the reasoning side (the
 * orchestrator). The dock talks to it through the `VoicePipeline` interface it
 * registers at startup, so no screen ever imports a native speech module.
 *
 * Three deliberate choices:
 *  - **The provider is chosen per turn, not per launch.** The key can arrive
 *    from the Settings screen at any moment, and a user who has just pasted one
 *    should not have to restart the app to stop getting offline heuristics.
 *  - **There is always a provider.** With no key we fall back to the mock
 *    provider's rule engine: it captures far less, but "spent 12 on lunch" and
 *    everything else lands as a note, so the app is never dead.
 *  - **Nothing here throws.** The dock renders whatever comes back; a denied
 *    microphone, a missing TTS voice or an unreadable keychain all degrade to a
 *    sentence the user can act on.
 */

import { createLogger } from '@/core/logger';
import {
  ASSISTANT_TOKEN_STORE_KEY,
  LLM_API_KEY_STORE_KEY,
  WHISPER_API_KEY_STORE_KEY,
  assistantApiUrl,
  readSecret,
} from './mode';
import { currentZone } from '@/core/time';
import { briefingScript } from '@/features/briefing';
// The module, not `@/features/consent` — that barrel carries the screen, and
// the pipeline must not pull React into a file the `logic` project loads.
import { readAssistantConsent } from '@/features/consent/gate';
import {
  CONSENT_ACTION,
  consentNotice,
  mayReachProvider,
  type AssistantConsent,
} from '@/llm/consent';
import {
  registerVoicePipeline,
  type VoiceOutcome,
  type VoiceOutcomeItem,
  type VoicePipeline,
} from '@/features/voice/store';
import { createLlmClient, type LlmClient } from '@/llm/client';
import { createOrchestrator, type TurnOutcome } from '@/llm/orchestrator';
import { createUsageMeter, estimateTextTokens, TYPICAL_TURN_TOKENS } from '@/llm/usage';
import type { ExecutorEffects } from '@/llm/executor';
import { createGeminiProvider, createHostedProvider, createMockProvider } from '@/llm/provider';
import { getRepositories } from '@/repositories';
import { defaultSettings, type SettingsValues } from '@/repositories/settings';
import { creditsCoverBreach, resolveAssistantBudget, type BudgetAction } from '@/services/billing/allowance';
import { currentEntitlement, isStoreBuild , topUpsPurchased } from '@/services/billing/entitlement';
import { NO_CREDITS, purchasedFrom } from '@/services/billing/credits';
import { chargeCredits, readCreditsUsed } from '@/services/billing/creditsLedger';
import { chargeTrial, readTrialLedger } from '@/services/billing/trialLedger';
import { pushEventNow } from '@/services/calendar';
import { focusEffects } from '@/services/focus';
import { enableFor as enableGeofence, refresh as refreshGeofences } from '@/services/geofence';
import { CHANNELS, cancelForEntity, scheduleAt } from '@/services/notifications';
import { registerBootstrapStep } from '@/startup/bootstrap';
import {
  captureUtterance,
  speak as speakAloud,
  stopListening as stopStt,
  stopSpeaking as stopTts,
} from '@/voice';
// The module rather than the barrel: this one is pure, and reaching it through
// `@/voice` would tie the personal dictionary to the recogniser's own mocks.
import { readContextualStrings } from '@/voice/dictionary';

const log = createLogger('voice-pipeline');

// Re-exported so every existing import site keeps working; the definitions
// live in ./mode so Settings can ask about them without loading the recogniser.
export {
  ASSISTANT_TOKEN_STORE_KEY,
  LLM_API_KEY_STORE_KEY,
  WHISPER_API_KEY_STORE_KEY,
  assistantApiUrl,
  assistantMode,
  type AssistantMode,
} from './mode';

/** Where the Settings screen writes the assistant key. Never in SQLite. */
/** Optional: unlocks the Whisper rung of the transcription ladder. */



/* ----------------------------------------------------------------- effects -- */

/**
 * The executor's side-effect ports, wired to the real services. Each one is
 * best-effort by design: the row is already written by the time it runs, so a
 * denied notification permission costs a reminder and nothing else.
 */
export const voiceEffects: ExecutorEffects = {
  async scheduleReminder(input) {
    const entityId = typeof input.data?.entityId === 'string' ? input.data.entityId : undefined;
    const href = typeof input.data?.href === 'string' ? input.data.href : undefined;
    const scheduled = await scheduleAt({
      title: input.title,
      ...(input.body ? { body: input.body } : {}),
      at: input.at,
      channel: CHANNELS.reminders,
      data: { kind: 'event', ...(entityId ? { entityId } : {}), ...(href ? { href } : {}) },
    });
    return scheduled.ok ? scheduled.value : null;
  },

  async cancelReminders(entityId) {
    await cancelForEntity(entityId);
  },

  startFocusSession: focusEffects.startFocusSession,
  controlFocusSession: focusEffects.controlFocusSession,

  /**
   * Arms a newly created place reminder, asking for what it needs.
   *
   * `refresh()` only re-diffs against the permission already held, so on an
   * install that has never granted location it did nothing at all — and no
   * screen in the app asks. "Remind me to pick up the frame when I get to the
   * maker lab" gave a successful receipt and armed no region, permanently.
   *
   * `enableFor` is the path that prompts: location first, then notifications,
   * because a reminder that fires into a muted app is the same silence by
   * another route. Falls back to a plain re-diff when the caller has no id —
   * an unrelated refresh must not raise a permission dialog out of nowhere.
   */
  async registerGeofences(triggerId?: string) {
    if (!triggerId) {
      await refreshGeofences();
      return;
    }
    const armed = await enableGeofence(triggerId);
    // A refusal is a normal answer, not a failure: the reminder is still saved
    // and the Places screen explains what is missing. It must not take the
    // whole turn down with it.
    if (!armed.ok) log.info('place reminder saved but not armed', armed.error.message);
  },

  async syncCalendarEvent(eventId) {
    // The executor has already queued the durable row; this only tries to make
    // it land now, and the queue remains the fallback when it cannot.
    await pushEventNow(eventId);
  },

  generateBriefing: (scope) => briefingScript(scope),
};

/* ------------------------------------------------------------------ client -- */

const mockClient = createLlmClient({ provider: createMockProvider(), logger: log });

let geminiKey: string | null = null;
let gemini: { model: string | undefined; schemaRung: number; client: LlmClient } | null = null;

export type TurnClient = {
  client: LlmClient;
  /** True when this turn's provider costs money and the meter must count it. */
  metered: boolean;
  /** True when the lifetime free trial is what is paying for it. */
  trial: boolean;
  /** True when a bought top-up is what is paying for it. Never both. */
  credits: boolean;
  /**
   * What to tell the user about the money side of this turn: a cap that bit, a
   * trial running out, or a trial already spent. Shown whether the turn was
   * allowed or not — an assistant that has quietly stopped calling the model is
   * the failure the receipt exists to prevent.
   */
  notice: string | null;
  /** Where that notice can be acted on. */
  action: BudgetAction | null;
  /**
   * What this turn was projected to draw. Kept so a turn that billed and then
   * failed to say how much can still be charged something honest.
   */
  estimatedTokens: number;
};

/** A turn that never reaches a paid provider costs nothing and says nothing. */
function unmetered(client: LlmClient, estimatedTokens: number): TurnClient {
  return {
    client,
    metered: false,
    trial: false,
    credits: false,
    notice: null,
    action: null,
    estimatedTokens,
  };
}




let hosted: LlmClient | null = null;

/**
 * The client for this turn.
 *
 * Three modes, in order of precedence:
 *
 *   hosted        a backend URL is baked into the build, so the request goes
 *                 there with the user's session token and the model key never
 *                 leaves your server. This is what ships to a store.
 *   personal-key  no backend, but a key in the device keychain — your own
 *                 builds, running on your own free-tier quota.
 *   offline       neither, or the budget is spent: the mock provider's pattern
 *                 matcher.
 *
 * **Both paid modes go through the same gate.** The hosted one used to return
 * before the budget was ever consulted, on the grounds that quotas belong to
 * the server — which is true of the *authoritative* answer and was read as
 * meaning the client should not have one. The result was that every line of
 * the free-tier lock was dead code on the only configuration that ships: the
 * trial, the entitlement check and the meter all ran on personal builds, where
 * the invoice belongs to whoever pasted the key, and none of them ran on the
 * build where it belongs to the operator. The server still decides; this is the
 * half that stops an unbilled request being made at all, and the half that
 * records what the turn cost so a caching change can be seen to have worked.
 *
 * Hitting a cap degrades rather than silences, the same path a missing key
 * takes, because a budget control that bricks the mic only teaches people to
 * raise the budget. It is never silent, though: whatever `assistantBudget()`
 * decided rides back on the turn as a notice.
 */
async function clientForTurn(transcript: string): Promise<TurnClient> {
  // Before the endpoint, before the keychain, before the budget. Every other
  // branch below ends at somebody else's machine, and the order is the control:
  // a consent check that ran after the client was built would be a consent
  // check that could be skipped by adding a fourth mode, and one that ran after
  // the request is the specific mistake app review rejects for.
  const consent = await readAssistantConsent();
  if (!mayReachProvider(consent)) return withheld(consent);

  const endpoint = assistantApiUrl();
  if (endpoint) {
    if (!hosted) {
      hosted = createLlmClient({
        provider: createHostedProvider({
          endpoint,
          getToken: () => readSecret(ASSISTANT_TOKEN_STORE_KEY),
        }),
        logger: log,
      });
    }
    // A build that carries a backend URL is a build whose model key is the
    // operator's, whether or not RevenueCat happened to be keyed at compile
    // time — so it is a store build for the purposes of the lock even if the
    // billing provider fell back to the one that cannot sell.
    const budget = await assistantBudget({
      transcript,
      storeBuild: true,
      // The developer sliders are hidden on a hosted build and cannot be
      // adjusted there, so letting their defaults cap an Unlimited subscriber
      // at 3,000 a month would be a ceiling nobody could see or raise.
      developerCaps: false,
    });
    return budget.blocked !== null
      ? refused(budget)
      : {
          client: hosted,
          metered: true,
          trial: budget.trial,
          credits: budget.credits,
          notice: budget.notice,
          action: budget.action,
          estimatedTokens: budget.estimatedTokens,
        };
  }

  geminiKey = await readSecret(LLM_API_KEY_STORE_KEY);
  if (!geminiKey) return unmetered(mockClient, 0);

  const budget = await assistantBudget({ transcript, developerCaps: true });
  if (budget.blocked !== null) return refused(budget);

  const model = await preferredGeminiModel();
  const schemaRung = await preferredSchemaRung();
  // The rung is baked into the provider, so a change to it has to rebuild the
  // client the same way a model change does — otherwise flipping the setting
  // appears to do nothing until the app is restarted, which is precisely the
  // kind of silence that makes a measurement untrustworthy.
  if (!gemini || gemini.model !== model || gemini.schemaRung !== schemaRung) {
    gemini = {
      model,
      schemaRung,
      client: createLlmClient({
        // A getter, so a rotated key takes effect without rebuilding anything.
        provider: createGeminiProvider({
          apiKey: () => geminiKey,
          ...(model ? { model } : {}),
          startRung: schemaRung,
        }),
        logger: log,
      }),
    };
  }
  return {
    client: gemini.client,
    metered: true,
    trial: budget.trial,
    credits: budget.credits,
    notice: budget.notice,
    action: budget.action,
    estimatedTokens: budget.estimatedTokens,
  };
}

/**
 * A turn nobody has agreed to send: offline engine, and say so every time.
 *
 * The same shape a spent trial takes, on purpose — the app is never dead, it
 * just answers on its own — but for a different reason and with a different way
 * out. `metered` and `trial` are both false because no request was made and
 * nothing may be charged for one that was not.
 */
function withheld(consent: AssistantConsent): TurnClient {
  log.info('assistant consent not granted; answering offline', { consent });
  return {
    client: mockClient,
    metered: false,
    trial: false,
    credits: false,
    notice: consentNotice(consent),
    action: { ...CONSENT_ACTION },
    estimatedTokens: 0,
  };
}

/** A turn the budget refused: offline engine, and say why on every one. */
function refused(budget: TurnBudget): TurnClient {
  log.warn('assistant budget reached', { reason: budget.blocked });
  return {
    client: mockClient,
    metered: false,
    trial: false,
    credits: false,
    notice: budget.blocked,
    action: budget.action,
    estimatedTokens: budget.estimatedTokens,
  };
}

type TurnBudget = {
  /** The sentence to say instead of calling the model, or null to go ahead. */
  blocked: string | null;
  /** Worth saying either way — a trial with three requests left, for instance. */
  notice: string | null;
  action: BudgetAction | null;
  /** True when going ahead spends one of the lifetime trial's requests. */
  trial: boolean;
  /** True when it spends one of the requests bought as a top-up. Never both. */
  credits: boolean;
  /** What this turn was projected to draw, in tokens. */
  estimatedTokens: number;
};

type BudgetOptions = {
  /** What the user said. Its length is most of what makes a turn expensive. */
  transcript: string;
  /** Whether the developer screen's own ceilings apply to this build. */
  developerCaps: boolean;
  /** Forced true by the hosted path; otherwise read off the billing provider. */
  storeBuild?: boolean;
};

/**
 * What this turn will draw, before it is sent.
 *
 * The prompt's own baseline plus the transcript, because the transcript is the
 * one part nobody clamps: the prompt's sections are all bounded, but the typed
 * box takes a paste and hands it straight to the provider. Projecting only the
 * baseline is what let a megabyte of text through a token ceiling — the
 * rolling average `check()` falls back to describes turns *already recorded*,
 * so the first big one is always waved through at the size of a small one.
 */
function projectTurnTokens(transcript: string): number {
  return TYPICAL_TURN_TOKENS + estimateTextTokens(transcript);
}

/**
 * Whether this turn may cost money, and what to say about it.
 *
 * One decision, then one measurement, in that order and nowhere else.
 * `resolveAssistantBudget` says who may spend and hands down the ceilings — a
 * personal build keeps the developer caps, a subscriber gets their plan floored
 * by them, and a free user on a store build gets a lifetime trial and then
 * nothing. `createUsageMeter().check()` then enforces exactly those ceilings,
 * in whichever units they were stated. Nothing in between reinterprets them,
 * which is what stops the two from disagreeing about what 0 means.
 *
 * The trial's counters are kept outside the meter entirely, because they are a
 * *lifetime* budget and the meter only knows about today and this month — a
 * lifetime budget expressed as a monthly one is a budget you can wait out, and
 * the table it would be measured in has no idea whose traffic is in it.
 *
 * Failure is not one answer here. A store that cannot be reached reads as
 * *unknown* and changes nothing about the turn, while a database that will not
 * open must not hand out a fresh trial — so an unreadable counter counts as
 * *spent* rather than unspent. The personal build is untouched by either: it
 * never consults the trial, and never even opens the keychain to look.
 */
async function assistantBudget(options: BudgetOptions): Promise<TurnBudget> {
  const estimatedTokens = projectTurnTokens(options.transcript);

  // `currentEntitlement` does not throw; it reports a store failure as unknown
  // rather than as free, which is what stops an outage looking like a decision
  // not to pay.
  const entitlement = await currentEntitlement();

  let repos: ReturnType<typeof getRepositories> | null = null;
  let stored: SettingsValues | null = null;
  try {
    repos = getRepositories();
    stored = await repos.settings.getAll();
  } catch (error) {
    log.warn('could not read the assistant caps; assuming the strictest ones', error);
  }

  const settings = stored ?? defaultSettings();
  const developerCaps = options.developerCaps
    ? { daily: settings.llmDailyRequestCap, monthly: settings.llmMonthlyRequestCap }
    : { daily: 0, monthly: 0 };
  const storeBuild = options.storeBuild ?? (isStoreBuild() || settings.simulateStoreBuild);

  // Only read on a build that has a trial. There is no trial on a personal one,
  // and the ledger's durable half is a keychain item — an I/O round trip per
  // utterance to answer a question nothing downstream will ask.
  const trial = storeBuild ? await readTrialLedger() : { requestsUsed: 0, tokensUsed: 0 };
  // Same reasoning as the trial: only a build that can sell a top-up can have
  // one, and the balance costs a store round trip plus a keychain read.
  const credits = storeBuild
    ? { purchased: purchasedFrom(await topUpsPurchased()), used: await readCreditsUsed() }
    : NO_CREDITS;

  const budget = resolveAssistantBudget({
    storeBuild,
    entitlement,
    trial,
    credits,
    caps: developerCaps,
    estimatedTokens,
  });

  if (!budget.allowed) {
    return {
      blocked: budget.message,
      notice: budget.message,
      action: budget.action,
      trial: false,
      credits: false,
      estimatedTokens,
    };
  }

  if (repos) {
    try {
      // The projection is handed down rather than left to the meter's rolling
      // average: the average is of turns already recorded, and the turn that
      // matters is the one nobody has seen yet.
      const verdict = await createUsageMeter(repos.db).check(budget.caps, {
        estimate: { tokens: estimatedTokens },
      });
      if (!verdict.ok) {
        /*
         * Before the door shuts: can this be paid for out of a top-up?
         *
         * The decision is `creditsCoverBreach`, in allowance.ts, and not an
         * `if` written here — the invariant is one decision then one
         * measurement, and this is the same decision being asked again with
         * the measurement in hand. A subscriber who bought a top-up for
         * exactly this moment used to be refused anyway, because the only path
         * to the balance ran through `refuse()` inside the first decision and
         * a spent monthly allowance is refused by the meter, downstream of it.
         */
        const breach = (verdict.error.details as { breach?: { window?: string } } | undefined)
          ?.breach;
        const covered = creditsCoverBreach({
          budget,
          credits,
          window: breach?.window === 'today' ? 'today' : 'month',
        });
        if (covered?.allowed) {
          return {
            blocked: null,
            notice: covered.notice,
            action: covered.action,
            trial: false,
            credits: true,
            estimatedTokens,
          };
        }

        const message = verdict.error.userMessage;
        return {
          blocked: message,
          notice: message,
          action: budget.action,
          trial: false,
          credits: false,
          estimatedTokens,
        };
      }
    } catch (error) {
      // A meter that cannot be read must not block the assistant; the plan
      // decision above already stands, and the provider's own cap is under us.
      log.warn('could not read the assistant usage', error);
    }
  }

  return {
    blocked: null,
    notice: budget.notice,
    action: budget.action,
    trial: budget.metersTrial,
    credits: budget.metersCredits,
    estimatedTokens,
  };
}

/**
 * Which rung of the schema ladder to start on. Total: an unreadable setting
 * must not decide how the assistant talks to the model.
 *
 * It fell back to 0 — "the strict schema, which is the safe end of the trade".
 * That was true only while nothing had ever been sent to Google. Measured
 * against the live API, rung 0 is refused outright with a bare 400 and rung 1
 * returns actions with empty parameters; rung 2 answers 8 utterances out of 8.
 * So the safe end is the *last* rung, and falling back to the first would take
 * two guaranteed-wasted calls to reach it — on the one path taken when the
 * database is already in trouble.
 */
async function preferredSchemaRung(): Promise<number> {
  try {
    return await getRepositories().settings.get('llmSchemaRung');
  } catch (error) {
    log.warn('could not read the schema rung setting', error);
    return 2;
  }
}

/**
 * `llmModel` is a free-text setting shared with future providers, so a value
 * that plainly is not a Gemini model is ignored rather than sent to Google as
 * a 404.
 */
async function preferredGeminiModel(): Promise<string | undefined> {
  try {
    const stored = (await getRepositories().settings.get('llmModel')).trim();
    return stored.toLowerCase().startsWith('gemini') ? stored : undefined;
  } catch (error) {
    log.warn('could not read the model setting', error);
    return undefined;
  }
}

/* ---------------------------------------------------------------- pipeline -- */

/** Rejection reasons the dock turns into "Try again?" rather than an error. */
const RETRYABLE_REASONS = new Set(['empty', 'low_confidence', 'too_short']);

function rejectionReason(details: unknown): string | undefined {
  if (typeof details !== 'object' || details === null) return undefined;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : undefined;
}

function toOutcomeItems(outcome: TurnOutcome): VoiceOutcomeItem[] {
  return outcome.items.map((item) => ({
    toolName: item.toolName,
    ok: item.ok,
    summary: item.summary,
    ...(item.detail ? { detail: item.detail } : {}),
    ...(item.href ? { href: item.href } : {}),
    ...(item.results?.length ? { results: item.results } : {}),
    ...(item.entityId ? { entityId: item.entityId } : {}),
  }));
}

/**
 * The bias list for one listening session, or nothing at all.
 *
 * `getRepositories()` opens the database on first use and can throw
 * synchronously, which is why this is a function rather than a `.catch` on the
 * call: an unbiased microphone is a working microphone, and a dictionary is
 * never worth the utterance.
 */
async function personalDictionary(): Promise<string[]> {
  try {
    return await readContextualStrings(getRepositories());
  } catch (error) {
    log.warn('could not read the personal dictionary', error);
    return [];
  }
}

export function createVoicePipeline(): VoicePipeline {
  /**
   * The store hands `process` a bare string, so the confidence the recogniser
   * reported would be lost between the two calls. Keeping the last capture
   * lets the audit trail record how well we heard the utterance we acted on.
   */
  let lastCapture: { transcript: string; confidence: number | null } | null = null;

  async function settings() {
    return getRepositories().settings.getAll();
  }

  return {
    async listen(handlers) {
      const config = await settings().catch(() => null);
      // Consent covers this rung too, and more obviously than it covers the
      // model: Whisper uploads the *recording*, to a second third party, and
      // the consent screen's central promise is that the audio never leaves the
      // phone. It is opt-in and needs a key pasted on the developer screen, so
      // nobody meets it by accident — but "off by default" is not the same
      // promise as "not without your say-so", and only one of them is the one
      // the screen makes.
      const whisperAllowed =
        config?.whisperFallbackEnabled === true && mayReachProvider(config.assistantConsent);
      const whisperKey = whisperAllowed ? await readSecret(WHISPER_API_KEY_STORE_KEY) : null;

      /**
       * And it covers the *recogniser* too, which is the rung nobody thought to
       * gate because it looks local from the call site.
       *
       * It is not reliably local. On-device recognition is preferred and often
       * simply unavailable — most Android devices, and any iPhone whose locale
       * dictation has not been downloaded — and the session then starts with
       * `requiresOnDeviceRecognition: false`, which streams the raw audio to
       * Apple's or Google's speech servers; there is a silent retry over the
       * network on top of that. So a fresh install that read the screen, tapped
       * "Use Ridik offline" and spoke had its audio uploaded, and was then told
       * "nothing went to Google" by the refusal notice on that exact turn.
       *
       * Fails closed on a settings read that did not land: an unknown answer is
       * not a yes.
       */
      const onDeviceOnly = !mayReachProvider(config?.assistantConsent ?? 'unset');

      /**
       * The user's own proper nouns, handed to the recogniser before it
       * listens. Nothing leaves the phone for this — a bias list is weighted
       * into the engine's own language model, on-device or not — and it is the
       * only fix for the one error the rest of the pipeline cannot recover
       * from: a name heard as the nearest common word is a plausible receipt
       * over the wrong row, and every layer below this one is working from the
       * wrong word by then.
       */
      const contextualStrings = await personalDictionary();

      const capture = await captureUtterance({
        ...(config ? { minConfidence: config.voiceConfidenceThreshold } : {}),
        ...(config ? { silenceTimeoutMs: config.silenceTimeoutMs } : {}),
        onDeviceOnly,
        ...(contextualStrings.length > 0 ? { contextualStrings } : {}),
        onPartial: handlers.onPartial,
        whisper: { enabled: Boolean(whisperKey), apiKey: whisperKey },
      });

      if (capture.ok) {
        lastCapture = { transcript: capture.value.transcript, confidence: capture.value.confidence };
        handlers.onFinal(capture.value.transcript, capture.value.confidence);
        return;
      }

      const reason = rejectionReason(capture.error.details);
      // "I didn't catch that" is not a failure the user should have to read as
      // one — it is an offer to say it again.
      const retryable =
        (reason && RETRYABLE_REASONS.has(reason)) || capture.error.code === 'invalid_input';
      handlers.onError(
        capture.error.userMessage,
        retryable ? (reason === 'empty' ? 'empty' : 'low_confidence') : capture.error.code,
      );
    },

    async stopListening() {
      await stopStt();
    },

    async process(transcript, options): Promise<VoiceOutcome> {
      const repos = getRepositories();
      const turn = await clientForTurn(transcript);
      // Read per turn rather than captured once: the pipeline is installed at
      // startup and lives for the session, so a mode captured at construction
      // would keep the value the app booted with until it was killed.
      const confirmMode = await repos.settings.get('confirmMode');
      const orchestrator = createOrchestrator({
        repos,
        client: turn.client,
        effects: voiceEffects,
        zone: currentZone(),
        logger: log,
        confirmMode,
      });

      const heard = lastCapture?.transcript.trim() === transcript.trim() ? lastCapture : null;
      const outcome = await orchestrator.interpretAndExecute({
        transcript,
        confidence: heard?.confidence ?? null,
        ...(options?.pending ? { pending: options.pending } : {}),
      });
      lastCapture = null;

      if (turn.metered && outcome.usage) {
        // Metering must never cost the user the turn they just completed.
        await createUsageMeter(repos.db)
          .record({
            model: outcome.usage.model,
            inputTokens: outcome.usage.inputTokens,
            // Zero on the direct path — nothing in a Gemini request from this
            // app is long enough to cache (see the note in provider/gemini.ts)
            // — and non-zero on the hosted one, which is the half where
            // caching can actually pay: the proxy sends a byte-identical
            // prefix on behalf of every user. Recording it is the only way a
            // caching change can afterwards be shown to have worked.
            cachedTokens: outcome.usage.cachedTokens,
            outputTokens: outcome.usage.outputTokens,
            // One utterance, however many times the reply had to be repaired
            // to answer it. The repairs are counted beside it rather than
            // added to it: they are the app's own retries, and charging them
            // to an allowance sold in requests bills the user for them.
            requests: 1,
            calls: outcome.usage.calls,
          })
          .catch((error: unknown) => log.warn('could not record assistant usage', error));
      }

      // Deliberately not gated on `outcome.usage`, which the orchestrator omits
      // both when it never called the model and when the call ladder failed
      // after billing five attempts. The one case that truly costs nothing is a
      // pending clarification answered yes or no, and that is the one exempted
      // here; everything else charges the trial whether it worked or not.
      // A bought request is drawn down on exactly the turns the trial would
      // have been — same unit, same exemption for a yes/no that never reached
      // the model. Never both: `resolveAssistantBudget` sets one flag or the
      // other, because the two balances mean opposite things.
      if (turn.credits && (outcome.usage || !options?.pending)) {
        await chargeCredits(1);
      }

      if (turn.trial && (outcome.usage || !options?.pending)) {
        const billed =
          (outcome.usage?.inputTokens ?? 0) + (outcome.usage?.outputTokens ?? 0);
        await chargeTrial({
          // One utterance is one of the 25, whatever it cost to answer — that
          // is the unit the user was told about. What it cost is the line
          // below, summed across every call the repair ladder made, which is
          // the only thing that can tell a "hello" from a pasted novel.
          requests: 1,
          // A turn that billed and then could not say how much is charged an
          // ordinary turn rather than nothing: unknown must not be free.
          tokens: billed > 0 ? billed : TYPICAL_TURN_TOKENS,
        });
      }

      return {
        transcript: outcome.transcript,
        speak: outcome.speak !== false,
        // Repeated on every affected turn, not said once: the whole point is
        // that the user never has to work out why the answers got simpler.
        ...(turn.notice ? { notice: turn.notice } : {}),
        ...(turn.notice && turn.action ? { noticeAction: turn.action } : {}),
        ...(outcome.feedback ? { feedback: outcome.feedback } : {}),
        items: toOutcomeItems(outcome),
        ...(outcome.clarification ? { clarification: outcome.clarification } : {}),
        // The turn never ran. Carried through so the store can keep the words:
        // a resolved outcome with an apology in it looks exactly like a turn
        // that ran and wrote nothing.
        ...(outcome.failed ? { failed: true as const } : {}),
      };
    },

    async speak(text) {
      // Muted is a setting, not a failure: the dock still shows the sentence.
      const config = await settings().catch(() => null);
      if (config && !config.ttsEnabled) return;
      try {
        await speakAloud(text, { rate: config?.ttsRate ?? 1 });
      } catch (error) {
        log.warn('could not speak', error);
      }
    },

    async stopSpeaking() {
      await stopTts();
    },
  };
}

let installed = false;

/** Idempotent: the dock only ever needs one pipeline behind it. */
export function installVoicePipeline(): void {
  if (installed) return;
  registerVoicePipeline(createVoicePipeline());
  installed = true;
}

/** Test hook — lets a suite install a pipeline of its own. */
export function resetVoicePipeline(): void {
  installed = false;
  gemini = null;
  geminiKey = null;
  // The hosted client captures the endpoint it was built with, so a suite that
  // changes the build config would otherwise keep talking to the old one.
  hosted = null;
}

registerBootstrapStep({
  name: 'voice-pipeline',
  run: () => {
    installVoicePipeline();
  },
});
