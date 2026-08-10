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
import * as SecureStore from 'expo-secure-store';

import { createLogger } from '@/core/logger';
import { currentZone } from '@/core/time';
import { briefingScript } from '@/features/briefing';
import {
  registerVoicePipeline,
  type VoiceOutcome,
  type VoiceOutcomeItem,
  type VoicePipeline,
} from '@/features/voice/store';
import { createLlmClient, type LlmClient } from '@/llm/client';
import { createOrchestrator, type TurnOutcome } from '@/llm/orchestrator';
import type { ExecutorEffects } from '@/llm/executor';
import { createGeminiProvider, createMockProvider } from '@/llm/provider';
import { getRepositories } from '@/repositories';
import { pushEventNow } from '@/services/calendar';
import { focusEffects } from '@/services/focus';
import { refresh as refreshGeofences } from '@/services/geofence';
import { CHANNELS, cancelForEntity, scheduleAt } from '@/services/notifications';
import { registerBootstrapStep } from '@/startup/bootstrap';
import {
  captureUtterance,
  speak as speakAloud,
  stopListening as stopStt,
  stopSpeaking as stopTts,
} from '@/voice';

const log = createLogger('voice-pipeline');

/** Where the Settings screen writes the assistant key. Never in SQLite. */
export const LLM_API_KEY_STORE_KEY = 'ridik.llm.apiKey';
/** Optional: unlocks the Whisper rung of the transcription ladder. */
export const WHISPER_API_KEY_STORE_KEY = 'ridik.whisper.apiKey';

const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

/** A keychain that will not open is a missing key, not a crash. */
async function readSecret(key: string): Promise<string | null> {
  try {
    const value = await SecureStore.getItemAsync(key, SECURE_STORE_OPTIONS);
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  } catch (error) {
    log.warn('could not read a stored key', { key, error });
    return null;
  }
}

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

  async registerGeofences() {
    await refreshGeofences();
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
let gemini: { model: string | undefined; client: LlmClient } | null = null;

/**
 * The client for this turn. Gemini whenever a key is readable, and the mock
 * provider's offline heuristic otherwise — the app degrades, never dies.
 */
async function clientForTurn(): Promise<LlmClient> {
  geminiKey = await readSecret(LLM_API_KEY_STORE_KEY);
  if (!geminiKey) return mockClient;

  const model = await preferredGeminiModel();
  if (!gemini || gemini.model !== model) {
    gemini = {
      model,
      client: createLlmClient({
        // A getter, so a rotated key takes effect without rebuilding anything.
        provider: createGeminiProvider({
          apiKey: () => geminiKey,
          ...(model ? { model } : {}),
        }),
        logger: log,
      }),
    };
  }
  return gemini.client;
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
  }));
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
      const whisperKey = config?.whisperFallbackEnabled
        ? await readSecret(WHISPER_API_KEY_STORE_KEY)
        : null;

      const capture = await captureUtterance({
        ...(config ? { minConfidence: config.voiceConfidenceThreshold } : {}),
        ...(config ? { silenceTimeoutMs: config.silenceTimeoutMs } : {}),
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
      const client = await clientForTurn();
      const orchestrator = createOrchestrator({
        repos: getRepositories(),
        client,
        effects: voiceEffects,
        zone: currentZone(),
        logger: log,
      });

      const heard = lastCapture?.transcript.trim() === transcript.trim() ? lastCapture : null;
      const outcome = await orchestrator.interpretAndExecute({
        transcript,
        confidence: heard?.confidence ?? null,
        ...(options?.pending ? { pending: options.pending } : {}),
      });
      lastCapture = null;

      return {
        transcript: outcome.transcript,
        speak: outcome.speak !== false,
        ...(outcome.feedback ? { feedback: outcome.feedback } : {}),
        items: toOutcomeItems(outcome),
        ...(outcome.clarification ? { clarification: outcome.clarification } : {}),
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
}

registerBootstrapStep({
  name: 'voice-pipeline',
  run: () => {
    installVoicePipeline();
  },
});
