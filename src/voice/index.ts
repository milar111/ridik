/**
 * The one entry point the UI uses for voice.
 *
 * `captureUtterance` hides the whole ladder: on-device recognition first,
 * network recognition when the device cannot, Whisper when the user has opted
 * in and the recogniser gave us nothing usable, and typed text from the
 * fallback modal when the user gives up on speaking altogether.
 */
import { createLogger } from '@/core/logger';
import {
  AppError,
  err,
  fail,
  ok,
  toAppError,
  type AppErrorCode,
  type Err,
  type Result,
} from '@/core/result';
import { abortListening, getSttState, startListening, stopListening } from './stt';
import { isSpeaking, speak, stop as stopSpeaking } from './tts';
import { cleanTranscript, createSilenceDetector, chunkForSpeech, evaluateTranscript } from './vad';
import {
  isConfigured as isAssemblyConfigured,
  recordAndTranscribe as assemblyRecordAndTranscribe,
  transcribeFile,
} from './assemblyai';
import { keptAudioOptions } from './capability';
import { deleteQuietly, sweepKeptRecordings } from './record';
import { transcribeFile as whisperLocalTranscribe } from './whisperLocal';
import { isConfigured as isWhisperConfigured, recordAndTranscribe } from './whisper';
import {
  DID_NOT_CATCH_MESSAGE,
  type TranscriptReason,
  type TranscriptSource,
  type VoiceCapture,
  type VoiceState,
} from './types';

const log = createLogger('voice');

export type CaptureOptions = {
  /** Text typed into the fallback modal; skips the microphone entirely. */
  manualText?: string;
  locale?: string;
  minConfidence?: number;
  silenceTimeoutMs?: number;
  onPartial?: (text: string) => void;
  onStateChange?: (state: VoiceState) => void;
  /**
   * Keep the audio on the phone: no network recogniser, no silent retry over
   * one. Set whenever assistant consent is not `granted` — see `onDeviceOnly`
   * in `./types`. Whisper is gated separately, by the caller, because it is a
   * different recipient and a different opt-in.
   */
  onDeviceOnly?: boolean;
  /**
   * The user's own names, biasing the recogniser towards them — see
   * `./dictionary`. Applies to the recogniser rungs only; Whisper takes a
   * prompt rather than a bias list and is left alone.
   */
  contextualStrings?: readonly string[];
  /** Whisper is opt-in and needs a key; without both, the ladder stops early. */
  whisper?: { enabled: boolean; apiKey?: string | null; maxSeconds?: number };
  /**
   * AssemblyAI, which is an *engine* rather than only a rescue.
   *
   * `primary: true` skips the platform recogniser entirely and records the
   * utterance for upload. That is the whole point of it: the fallback rungs
   * below only fire when the recogniser **failed**, and the complaint this was
   * built for is a recogniser that succeeds and is wrong — a confident wrong
   * answer never fails, so it never reaches a rescue. It costs the live
   * caption, because `expo-audio` has no PCM callback to feed a socket with;
   * see the docblock in `./assemblyai`.
   */
  assemblyai?: {
    enabled: boolean;
    primary?: boolean;
    /**
     * The good version of `primary`, and the one to prefer wherever it runs.
     *
     * `primary` replaces the recogniser, which buys accuracy and pays for it
     * with the live caption — the single most valuable thing on that screen,
     * because the caption is what makes auto-send safe to do at all. `upgrade`
     * does not choose: the recogniser runs normally and draws the caption, and
     * the audio it heard is handed to AssemblyAI afterwards for the transcript
     * that actually commits.
     *
     * It needs `captureAudio` to have produced a file, so it is Android 13+
     * only — see `canCaptureAudio` in `./capability`. Where it cannot run, `primary`
     * is still the fallback, and where neither can, the recogniser answers
     * alone exactly as it always did.
     */
    upgrade?: boolean;
    apiKey?: string | null;
    maxSeconds?: number;
  };
  /**
   * Whisper on the phone, reading the same audio AssemblyAI would have.
   *
   * The same `upgrade` rung and the same rules; only the reader changes. It is
   * the one upgrade engine with **no recipient** — nothing is uploaded — so it
   * is the only one that can run with consent declined, on a plane, or on a
   * phone with no signal. See `./whisperLocal`.
   */
  whisperLocal?: { upgrade: boolean };
  /** Cancels a Whisper recording in progress. */
  signal?: AbortSignal;
  /** Ends a Whisper recording early and transcribes what was captured. */
  stopSignal?: AbortSignal;
};

/**
 * Failures the Whisper fallback can plausibly fix. A denied microphone or a
 * dead connection are not among them — Whisper needs both.
 */
/** Whether any upgrade engine is on, and therefore whether to keep the audio. */
function keepsAudio(options: CaptureOptions): boolean {
  return options.assemblyai?.upgrade === true || options.whisperLocal?.upgrade === true;
}

const WHISPER_RECOVERS: ReadonlySet<AppErrorCode> = new Set<AppErrorCode>([
  'invalid_input',
  'unsupported',
  'not_found',
  'unknown',
]);

/** Captures one utterance. Never throws; "I didn't hear you" is a Result. */
export async function captureUtterance(options: CaptureOptions = {}): Promise<Result<VoiceCapture>> {
  if (options.manualText !== undefined) return captureManual(options.manualText);
  if (!keepsAudio(options)) return runCapture(options);

  /*
   * Swept on both sides, and only one of them is a guarantee.
   *
   * **In** is the guarantee: nothing of ours is listening yet, so every
   * `recording_*.wav` in that directory is finished with, whatever left it —
   * a crash, a killed process, or the race below.
   *
   * **Out** is opportunistic, and the measurement is why it is described that
   * way rather than as the main event. This resolves when the *transcript*
   * arrives, which is before the recognition library has run its own
   * teardown — so a session whose file was still being closed is not in the
   * listing yet and survives the sweep. Measured on a device: of the two
   * recordings a retried turn produces, the out sweep took the first and could
   * not see the second, 367ms younger. It is kept because taking one of two is
   * better than taking none, and because a turn that ends cleanly does leave
   * nothing. What it cannot promise is that the *last* utterance before the
   * app is closed leaves nothing; the next sweep in is what collects that.
   *
   * Do not try to fix the race with a delay. The teardown is native and
   * asynchronous, a timeout that is long enough on this emulator is a guess
   * everywhere else, and the way-in sweep already covers what it would buy.
   *
   * `./record`'s own recordings are `.m4a` under a name `expo-audio` chooses,
   * so a Whisper upload in flight is outside the pattern and safe.
   */
  sweepKeptRecordings();
  try {
    return await runCapture(options);
  } finally {
    sweepKeptRecordings();
  }
}

async function runCapture(options: CaptureOptions): Promise<Result<VoiceCapture>> {

  /*
   * The one rung that runs *instead of* the recogniser rather than after it.
   *
   * Every other entry in this ladder is a rescue, and a rescue cannot fix the
   * failure this app was actually reported for: a recogniser that returns a
   * confident transcript with half the words missing never errors, so nothing
   * downstream is ever asked. Being able to replace it outright is the only
   * shape that helps.
   *
   * The state change is manual because there is no recogniser to emit one, and
   * without it the mic sits in `idle` through a five-second upload.
   */
  if (options.assemblyai?.primary && isAssemblyConfigured(options.assemblyai.apiKey)) {
    options.onStateChange?.('listening');
    const spoken = await transcribeWithAssembly(options);
    options.onStateChange?.('idle');
    if (spoken.ok || !canUseWhisper(options, spoken.error)) return spoken;
    log.info('assemblyai failed; trying the recogniser', { reason: spoken.error.code });
  }

  const heard = await listenOnce(options);
  if (heard.ok) return upgradeHeard(heard.value, options);

  // Preferred over Whisper when both are configured: same upload, better
  // English, and a third of the price. Whisper stays for an install that
  // already has a key in the keychain and no reason to change.
  if (options.assemblyai?.enabled && isAssemblyConfigured(options.assemblyai.apiKey)) {
    if (!canUseWhisper(options, heard.error)) return heard;
    log.info('falling back to AssemblyAI', { reason: heard.error.code });
    abortListening();
    const spoken = await transcribeWithAssembly(options);
    if (spoken.ok) return spoken;
    log.warn('AssemblyAI fallback failed too', spoken.error);
    return heard;
  }

  if (!canUseWhisper(options, heard.error)) return heard;
  log.info('falling back to Whisper', { reason: heard.error.code });
  // The recogniser may still be holding the microphone; the recorder needs it.
  abortListening();

  const recorded = await recordAndTranscribe({
    apiKey: options.whisper!.apiKey!,
    maxSeconds: options.whisper?.maxSeconds,
    language: options.locale,
    signal: options.signal,
    stopSignal: options.stopSignal,
  });
  // The recogniser's own error is the more actionable one to show, but the
  // Whisper failure (a rejected key, say) has to be diagnosable somewhere.
  if (!recorded.ok) {
    log.warn('Whisper fallback failed too', recorded.error);
    return heard;
  }

  const transcript = cleanTranscript(recorded.value.transcript);
  const evaluation = evaluateTranscript({ transcript, minConfidence: options.minConfidence });
  if (!evaluation.accept) return rejection(evaluation.reason);
  return ok({ transcript, confidence: null, source: 'whisper' });
}

/**
 * Hands the audio the recogniser kept to a better engine, and keeps whichever
 * transcript survives.
 *
 * This is the rung that answers the complaint the rest of the ladder cannot:
 * every other fallback fires on *failure*, and a recogniser that returns a
 * confident transcript with a word missing has not failed. Here the recogniser
 * has already answered — the user watched the caption the whole time — and the
 * upload only changes what commits.
 *
 * Three rules, and the second is the one that matters:
 *
 *  - **It is never the reason a turn fails.** An upload that errors, times out
 *    or comes back empty leaves the recogniser's own transcript exactly as it
 *    was. The user said something; something is filed.
 *  - **An empty upgrade is a failure, not an answer.** A network engine that
 *    returns "" for audio the phone heard words in is wrong, and taking it
 *    would turn a good turn into "I didn't catch that".
 *  - **The file always goes.** Every path through here deletes it, including
 *    the ones that never read it.
 */
async function upgradeHeard(
  heard: HeardUtterance,
  options: CaptureOptions,
): Promise<Result<VoiceCapture>> {
  const { audioUri, ...capture } = heard;
  if (audioUri === null) return ok(capture);

  const reader = upgradeReader(options);
  if (reader === null) {
    // Recording was asked for and then not used — a configuration change
    // mid-session, or a rung that stopped applying. Not worth failing over,
    // very much worth not leaving the recording behind.
    deleteQuietly(audioUri);
    return ok(capture);
  }

  try {
    const better = await reader(audioUri);

    if (!better.ok) {
      log.warn('upgrade failed; keeping what the recogniser heard', better.error);
      return ok(capture);
    }

    const transcript = cleanTranscript(better.value.transcript);
    if (!transcript) {
      log.warn('upgrade came back empty; keeping what the recogniser heard');
      return ok(capture);
    }

    log.info('upgraded the transcript', {
      from: capture.source,
      to: better.value.source,
      chars: transcript.length,
      confidence: better.value.confidence,
    });
    return ok({ transcript, confidence: better.value.confidence, source: better.value.source });
  } catch (error) {
    // `transcribeFile` answers in Results, so reaching here means something
    // threw that was not supposed to. It still must not cost the turn: this
    // whole rung is an improvement on a transcript the user has already
    // watched being typed out, and `captureUtterance` promises not to throw.
    log.warn('upgrade threw; keeping what the recogniser heard', error);
    return ok(capture);
  } finally {
    deleteQuietly(audioUri);
  }
}

/**
 * Which engine, if any, gets to read the audio the recogniser kept.
 *
 * Returns a reader rather than a name so `upgradeHeard` stays one code path:
 * the rules about what a failed, empty or thrown upgrade means are identical
 * whether the work happened on a server or on the phone, and duplicating them
 * per engine is how the two drift.
 *
 * Local first when both are chosen. They are never both chosen through the
 * settings screen — `sttEngine` is one value — but if that ever changes, the
 * engine that sends nothing anywhere is the one to prefer.
 */
function upgradeReader(
  options: CaptureOptions,
): ((uri: string) => Promise<Result<{ transcript: string; confidence: number | null; source: TranscriptSource }>>) | null {
  if (options.whisperLocal?.upgrade === true) {
    return async (uri) => {
      const heard = await whisperLocalTranscribe(uri);
      if (!heard.ok) return heard;
      return ok({ ...heard.value, source: 'whisper' as const });
    };
  }

  if (options.assemblyai?.upgrade === true && isAssemblyConfigured(options.assemblyai.apiKey)) {
    return async (uri) => {
      const heard = await transcribeFile({
        apiKey: options.assemblyai!.apiKey!,
        uri,
        ...(options.locale !== undefined ? { language: options.locale } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      if (!heard.ok) return heard;
      return ok({ ...heard.value, source: 'assemblyai' as const });
    };
  }

  return null;
}

async function transcribeWithAssembly(
  options: CaptureOptions,
): Promise<Result<VoiceCapture>> {
  const recorded = await assemblyRecordAndTranscribe({
    apiKey: options.assemblyai!.apiKey!,
    ...(options.assemblyai?.maxSeconds !== undefined
      ? { maxSeconds: options.assemblyai.maxSeconds }
      : {}),
    ...(options.locale !== undefined ? { language: options.locale } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.stopSignal !== undefined ? { stopSignal: options.stopSignal } : {}),
  });
  if (!recorded.ok) return recorded;

  const transcript = cleanTranscript(recorded.value.transcript);
  const evaluation = evaluateTranscript({ transcript, minConfidence: options.minConfidence });
  if (!evaluation.accept) return rejection(evaluation.reason);
  // The confidence is real here — most platform recognisers report nothing —
  // so it reaches the review gate rather than being dropped. See
  // `wasPoorlyHeard` in `src/llm/confirm.ts`.
  return ok({ transcript, confidence: recorded.value.confidence, source: 'assemblyai' });
}

/** Runs typed text through the same hygiene as speech so the model sees one shape. */
export function captureManual(text: string): Result<VoiceCapture> {
  const transcript = cleanTranscript(text);
  const evaluation = evaluateTranscript({ transcript });
  if (!evaluation.accept) {
    return fail('invalid_input', 'There was nothing to act on.', {
      details: { reason: evaluation.reason },
    });
  }
  return ok({ transcript, confidence: null, source: 'manual' });
}

/**
 * What the recogniser answered, plus the audio it kept if it was asked to.
 *
 * The uri never leaves this module — `upgradeHeard` is the only reader and it
 * deletes the file on every path. A caller handed a path to a recording would
 * be a second owner of somebody's voice with no rule about who cleans up.
 */
type HeardUtterance = VoiceCapture & { audioUri: string | null };

function listenOnce(options: CaptureOptions): Promise<Result<HeardUtterance>> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: Result<HeardUtterance>) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    void startListening({
      locale: options.locale,
      minConfidence: options.minConfidence,
      silenceTimeoutMs: options.silenceTimeoutMs,
      onDeviceOnly: options.onDeviceOnly,
      contextualStrings: options.contextualStrings,
      onPartial: options.onPartial,
      onStateChange: options.onStateChange,
      ...(keepsAudio(options) ? { captureAudio: keptAudioOptions() ?? undefined } : {}),
      // Every ending that is not `onFinal` comes back through here, which is
      // what stops an abandoned session leaving somebody's voice in the cache.
      onDiscardAudio: deleteQuietly,
      onError: (error) => done(err(error)),
      onFinal: (result) => {
        if (!result.accept) {
          // A rejected utterance still leaves a file behind when the recogniser
          // was recording. Nothing downstream will see it, so it is dropped
          // here rather than surviving in the cache until the OS decides.
          deleteQuietly(result.audioUri);
          done(rejection(result.reason));
          return;
        }
        done(
          ok({
            transcript: result.transcript,
            confidence: result.confidence,
            source: result.source,
            audioUri: result.audioUri,
          }),
        );
      },
    })
      .then((started) => {
        if (!started.ok) done(started);
      })
      // Nothing in startListening is expected to throw, but a rejection here
      // would leave the caller awaiting a promise that can never settle.
      .catch((error: unknown) => done(err(toAppError(error, 'Could not start listening.'))));
  });
}

// `Err` rather than `Result<VoiceCapture>`: a rejection carries no value, so
// naming one makes it un-assignable to the other shapes this module resolves
// with — `HeardUtterance` among them — for a `value` that is never there.
function rejection(reason: TranscriptReason): Err<AppError> {
  return err(new AppError('invalid_input', DID_NOT_CATCH_MESSAGE, { details: { reason } }));
}

function canUseWhisper(options: CaptureOptions, error: AppError): boolean {
  if (!options.whisper?.enabled) return false;
  if (!isWhisperConfigured(options.whisper.apiKey)) return false;
  return WHISPER_RECOVERS.has(error.code);
}

export { canCaptureAudio } from './capability';

export {
  ensureModel as ensureWhisperModel,
  prepare as prepareWhisper,
  status as whisperModelStatus,
  WHISPER_MODEL_FILE,
  type WhisperModelStatus,
} from './whisperLocal';

export {
  buildContextualStrings,
  readContextualStrings,
  readPersonalNames,
  DICTIONARY_QUOTAS,
} from './dictionary';

export {
  abortListening,
  chunkForSpeech,
  cleanTranscript,
  createSilenceDetector,
  evaluateTranscript,
  getSttState,
  isSpeaking,
  isWhisperConfigured,
  speak,
  startListening,
  stopListening,
  stopSpeaking,
};

export type {
  SttFinalResult,
  SttListenOptions,
  TranscriptEvaluation,
  TranscriptReason,
  TranscriptSource,
  VoiceCapture,
  VoiceState,
} from './types';
export type {
  DictionaryRepositories,
  DictionarySource,
  PersonalName,
  PersonalNames,
} from './dictionary';
export type { SilenceDetector, SilenceDetectorOptions, SilenceStats } from './vad';
export type { RecordAndTranscribeOptions, WhisperTranscript } from './whisper';
export type { SpeakOptions } from './tts';
