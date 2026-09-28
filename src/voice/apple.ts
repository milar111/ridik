/**
 * Apple's `SpeechAnalyzer`: the best English transcription on this platform,
 * and it is local and free.
 *
 * ## Why this is not a setting
 *
 * Every other engine in this folder is a choice with a trade. This one is not.
 * Against the `SFSpeechRecognizer` it replaces it measures **2.12% word error
 * rate on clean speech to 9.02%, and 4.56% to 16.25% on hard audio** — four
 * times fewer wrong words — while being *more* private (the platform
 * recogniser streams to Apple's servers whenever the phone has no offline
 * model; this never leaves the phone), costing nothing per utterance, and
 * keeping the live caption that the upload engines cannot produce at all.
 *
 * `AGENTS.md` is clear that a row on Settings has to justify being a question,
 * and there is no answer to "would you like four times more wrong words".
 * So this is what `device` *means* on an iPhone that has it, and there is no
 * new row anywhere. See `notes/STT-OPTIONS.md`.
 *
 * ## Two things it does not lose, one of which the notes said it would
 *
 * **Custom vocabulary survives.** `AGENTS.md` and the STT note both recorded
 * that `SpeechAnalyzer` has no equivalent of `contextualStrings`, and that
 * adopting it would cost `./dictionary` — "the only fix for the one error the
 * rest of the pipeline cannot recover from". That was wrong. The SDK has
 * `AnalysisContext.contextualStrings`, keyed by tag, and `.general` is the tag
 * for exactly this; the bias list is handed over unchanged.
 *
 * **Confidence arrives for the first time.** `.transcriptionConfidence` is a
 * real 0..1 reading per run. `wasPoorlyHeard` in `src/llm/confirm.ts` has been
 * working from `null` on iOS since it was written, because `SFSpeechRecognizer`
 * mostly declines to say.
 *
 * ## What it does lose, and how that is handled
 *
 * The model is a download. On a phone that does not have it yet this reports
 * *not ready* and starts fetching in the background, and the utterance goes to
 * the old recogniser — because the alternative is a microphone that hangs for
 * the length of a download, and the first sentence somebody ever says to this
 * app is the worst possible one to drop. The turn after the download lands is
 * the better one, with nobody having waited for it.
 *
 * ## Why it has its own session rather than sharing `./stt`'s
 *
 * `./stt` carries an on-device/network negotiation, a silent retry, a Galaxy
 * S23 that says goodbye as an error, and seven native event names. None of
 * that exists here: three events, one lifecycle, no network at any point. What
 * the two genuinely share is the part with the logic in it — `./vad`'s
 * endpointer and transcript hygiene — and they share that rather than a
 * lifecycle whose complexity belongs entirely to the other engine.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

import { now } from '@/core/clock';
import { createLogger } from '@/core/logger';
import { AppError, err, fail, ok, type Result } from '@/core/result';
import { cleanTranscript, createSilenceDetector, evaluateTranscript, type SilenceDetector } from './vad';
import {
  CONTEXTUAL_STRINGS_CAP,
  DEFAULT_TRAILING_SILENCE_MS,
  MAX_UTTERANCE_MS,
  STOP_GRACE_MS,
  TICK_INTERVAL_MS,
  type SttFinalResult,
  type SttListenOptions,
  type VoiceState,
} from './types';

const log = createLogger('stt-apple');

/** `supported` means "a download away"; only `installed` can listen now. */
type AssetStatus = 'unsupported' | 'supported' | 'downloading' | 'installed';

/**
 * `locale` and `confidence` arrive *absent* rather than null — the native side
 * omits the key instead of putting `nil` in a dictionary, because that
 * conversion is untestable here (no simulator has the analyzer) and a `stop()`
 * rejecting on an absent confidence would be indistinguishable from a failed
 * transcription. Both are normalised to `null` at the boundary below, so
 * nothing downstream ever sees `undefined` in a field typed `number | null`.
 */
type Availability = { locale?: string | null; status: AssetStatus };

type Subscription = { remove(): void };

type SpeechEvents = {
  /** The caption as it stands: everything finalised plus the moving tail. */
  onPartial: (event: { text: string }) => void;
  /** The microphone is open and the analyzer is reading it. */
  onStart: () => void;
};

type RidikSpeech = {
  /** False below iOS 26 and on any build without the module compiled in. */
  readonly isSupported: boolean;
  describe(locale: string): Promise<Availability>;
  install(locale: string): Promise<void>;
  start(locale: string, contextualStrings: string[]): Promise<void>;
  stop(): Promise<{ text: string; confidence?: number | null }>;
  abort(): Promise<void>;
  addListener<K extends keyof SpeechEvents>(name: K, listener: SpeechEvents[K]): Subscription;
};

/*
 * Optional, exactly like `RidikWidgets` in `src/services/widgets/publish.ts`:
 * every test run, every Expo Go session and every Android build gets null here
 * and falls through to the platform recogniser with nothing thrown.
 */
const native = requireOptionalNativeModule<RidikSpeech>('RidikSpeech');

/**
 * What the phone has already answered about a locale.
 *
 * Only the *terminal* answers are kept. `supported` and `downloading` both
 * become `installed` on their own, and re-asking is precisely what lets a
 * later utterance pick the better engine up without the app being restarted.
 */
const availability = new Map<string, Availability>();
const installing = new Set<string>();

type Session = {
  options: SttListenOptions;
  subscriptions: Subscription[];
  detector: SilenceDetector;
  ticker: ReturnType<typeof setInterval> | null;
  startedAt: number;
  stoppingAt: number | null;
  settled: boolean;
  /** The last caption seen, and the fallback transcript if finalising fails. */
  partial: string;
};

let session: Session | null = null;
let state: VoiceState = 'idle';

/** True when this build and this OS can transcribe on the phone. */
export function isAppleAnalyzerCompiled(): boolean {
  if (native === null) return false;
  try {
    return native.isSupported === true;
  } catch (error) {
    log.warn('could not read isSupported; assuming absent', { error });
    return false;
  }
}

export function isAppleListening(): boolean {
  return session !== null;
}

export function getAppleState(): VoiceState {
  return state;
}

/**
 * The locale to listen in, or null to leave this utterance to `./stt`.
 *
 * One native round trip, and only on the turns where the answer is not already
 * known — it sits directly in front of the microphone opening, so a second hop
 * here is latency the user feels as the app being slow to hear them.
 */
export async function appleAnalyzerFor(locale: string): Promise<string | null> {
  if (!isAppleAnalyzerCompiled()) return null;

  const cached = availability.get(locale);
  if (cached?.status === 'unsupported') return null;
  if (cached?.status === 'installed') return cached.locale ?? null;

  let answer: Availability;
  try {
    answer = normalise(await native!.describe(locale));
  } catch (error) {
    // A probe that throws is a phone that cannot answer, which is the same
    // outcome as "no" and must not stop the user from talking.
    log.warn('could not ask about on-device transcription', { error });
    availability.set(locale, { locale: null, status: 'unsupported' });
    return null;
  }

  // Only the terminal answers are remembered; see `availability` above.
  if (answer.status === 'unsupported' || answer.status === 'installed') {
    availability.set(locale, answer);
  }

  if (answer.status === 'installed') return answer.locale ?? null;
  // Before `warmUp`, and not merged into it: asking the OS to download a model
  // for a language it has just said it has none of is a native call that can
  // only fail.
  if (answer.status === 'unsupported') return null;

  warmUp(locale);
  return null;
}

/**
 * Fetches the model, for a later utterance.
 *
 * Fire and forget, and deduplicated: `appleAnalyzerFor` is called on every
 * turn, so without the guard a slow download would be started again every
 * time somebody spoke.
 */
function warmUp(locale: string): void {
  if (installing.has(locale)) return;
  installing.add(locale);
  log.info('fetching the on-device speech model', { locale });
  void native!
    .install(locale)
    .then(() => {
      log.info('on-device speech model installed', { locale });
    })
    .catch((error: unknown) => {
      // Nothing to tell the user: they are talking to a working recogniser and
      // the only thing they have lost is an upgrade they never knew about.
      log.warn('could not install the on-device speech model', { locale, error });
    })
    .finally(() => {
      installing.delete(locale);
    });
}

/**
 * Starts listening. The transcript arrives through `onFinal`, exactly as it
 * does from `./stt` — the caller cannot tell which engine answered except by
 * `source`.
 *
 * **A start failure is returned and never announced.** `onError` is for a
 * session that was running and then broke; a start that never took the
 * microphone is the caller's to route around, and `./stt` does route around it
 * — straight to the platform recogniser, which is a working answer and a much
 * better one than telling somebody to type. Calling `onError` here as well
 * would resolve the caller's promise before it had a chance to.
 */
export async function startAppleListening(
  options: SttListenOptions,
  locale: string,
): Promise<Result<void>> {
  if (!isAppleAnalyzerCompiled()) {
    return fail('unsupported', 'This iPhone cannot transcribe on the device.');
  }
  abortAppleListening();

  const current: Session = {
    options,
    subscriptions: [],
    detector: createSilenceDetector({
      trailingSilenceMs: options.silenceTimeoutMs ?? DEFAULT_TRAILING_SILENCE_MS,
      /*
       * Zero, where `./stt` passes `DEFAULT_MIN_SPEECH_MS`, and this is the
       * one place the two endpointers are deliberately configured apart.
       *
       * That floor is a *duration* of speech, and `./stt` can measure one:
       * `speechstart` and `speechend` bracket the real thing. This engine
       * reports no speech boundaries at all, so the only timestamps available
       * are the moments results arrived — and for a short utterance that is a
       * single instant, spanning 0ms. Keeping the floor meant "yes", "done"
       * and "log it" could never satisfy it, so nothing but the sixty-second
       * hard cap would ever end them: a one-word command with the microphone
       * held open for a minute afterwards.
       *
       * Dropping it loses nothing, because the floor was a proxy for "was
       * that actually speech?" and this engine has a far better answer to that
       * — `noteSpeech` is only ever called when *recognised words changed*.
       * A session that hears nothing notes nothing, leaves the detector with
       * no anchor, and still cannot fire. And whether the words amount to
       * anything is `evaluateTranscript`'s job either way, which rejects on
       * `MIN_SUBSTANTIVE_CHARS` well after this point.
       */
      minSpeechMs: 0,
      onTimeout: () => stopAppleListening(),
    }),
    ticker: null,
    startedAt: now(),
    stoppingAt: null,
    settled: false,
    partial: '',
  };

  session = current;
  setState(current, 'starting');
  // Before `start`, so a result that arrives on the same tick as the promise
  // resolving is not delivered to nobody.
  attach(current);

  // Sliced rather than trusted, for the same reason `./stt` slices it: the
  // builder caps its own output, but this is the boundary the native module
  // sits behind, and an oversized bias list is not rejected — it quietly makes
  // recognition worse.
  const bias = (options.contextualStrings ?? []).slice(0, CONTEXTUAL_STRINGS_CAP);

  try {
    await native!.start(locale, [...bias]);
  } catch (error) {
    log.warn('the analyzer would not start', { locale, error });
    current.settled = true;
    // `idle`, not `error`: the caller is about to try another engine, and a
    // microphone that briefly reported a failure it then recovered from is a
    // red mic flashing on screen for no reason anybody can act on.
    finish(current, 'idle');
    return err(toAppleError(error));
  }

  current.ticker = setInterval(() => tick(current), TICK_INTERVAL_MS);
  return ok(undefined);
}

/** Asks the analyzer to finalise, and settles with what it returns. */
export function stopAppleListening(): void {
  const current = session;
  if (!current || current.settled || current.stoppingAt !== null) return;
  current.stoppingAt = now();
  setState(current, 'processing');

  void native!
    .stop()
    .then((result) => settle(current, result.text, result.confidence ?? null))
    .catch((error: unknown) => {
      /*
       * Most of a sentence is worth incomparably more than none of it — the
       * same call `store.ts` makes when it keeps a dying recogniser's last
       * partial in `recovered`, and the same one `./stt` makes for the Galaxy
       * S23's farewell error. The native side only throws here when it has
       * nothing at all, but it cannot see the caption we have been showing.
       */
      if (current.partial.trim()) {
        log.warn('finalising failed; settling with the caption', { error });
        settle(current, current.partial, null);
        return;
      }
      const appError = toAppleError(error);
      current.settled = true;
      finish(current, 'error');
      current.options.onError?.(appError);
    });
}

/** Throws the utterance away and gives the microphone back. No callback fires. */
export function abortAppleListening(): void {
  const current = session;
  if (!current) {
    // Nothing is listening, so idle is the truth even after a failed start.
    state = 'idle';
    return;
  }
  current.settled = true;
  detach(current);
  session = null;
  void native?.abort().catch((error: unknown) => {
    log.warn('abort() failed', { error });
  });
  if (state !== 'idle') {
    state = 'idle';
    current.options.onStateChange?.('idle');
  }
}

/** Test seam: forgets what the phone has said about its own capabilities. */
export function resetAppleAnalyzerCache(): void {
  availability.clear();
  installing.clear();
}

/* ------------------------------------------------------------- internals -- */

/** An omitted key becomes an explicit `null`, so the cache holds one shape. */
function normalise(answer: Availability): Availability {
  return { locale: answer.locale ?? null, status: answer.status };
}

function attach(current: Session): void {
  current.subscriptions.push(
    native!.addListener('onStart', () => {
      // Measured from when the microphone actually opened, not from when we
      // asked: preparing the model can take a moment and `MAX_UTTERANCE_MS` is
      // a budget for *speaking*.
      current.startedAt = now();
      setState(current, 'listening');
    }),
    native!.addListener('onPartial', (event) => handlePartial(current, event.text)),
  );
}

function detach(current: Session): void {
  for (const subscription of current.subscriptions) {
    try {
      subscription.remove();
    } catch (error) {
      log.warn('could not remove an analyzer listener', { error });
    }
  }
  current.subscriptions.length = 0;
  if (current.ticker !== null) {
    clearInterval(current.ticker);
    current.ticker = null;
  }
  current.detector.dispose();
}

function handlePartial(current: Session, text: string): void {
  if (current.settled) return;
  const trimmed = text.trim();
  if (!trimmed || trimmed === current.partial) {
    /*
     * Only a *changed* caption counts as speech, and that is the whole
     * endpointer on this engine.
     *
     * `SpeechAnalyzer` reports no speech-boundary events at all — there is no
     * `speechstart`/`speechend` to forward — so `./vad` is driven by results
     * arriving and `tick` measures the gap since the last one. A volatile
     * result that is re-reported unchanged while somebody is silent would
     * therefore hold the utterance open for ever, which is a microphone that
     * never stops listening.
     */
    return;
  }
  current.partial = trimmed;
  current.detector.noteSpeech(now());
  current.options.onPartial?.(trimmed);
}

function tick(current: Session): void {
  if (current.settled) return;
  const at = now();

  if (current.stoppingAt !== null) {
    if (at - current.stoppingAt >= STOP_GRACE_MS) {
      // Nothing else will free the microphone: `settle` drops the session, so
      // a later `abort` finds nothing to abort. A `stop()` that resolves after
      // this is harmless — `settle` refuses a session already settled.
      log.warn('the analyzer never finalised; settling with the caption');
      settle(current, current.partial, null);
      void native?.abort().catch(() => {});
    }
    return;
  }

  if (at - current.startedAt >= MAX_UTTERANCE_MS) {
    log.info('utterance hit the hard cap; finalising');
    stopAppleListening();
    return;
  }

  current.detector.tick(at);
}

function settle(current: Session, raw: string, confidence: number | null): void {
  if (current.settled) return;
  current.settled = true;
  setState(current, 'processing');

  const heard = raw.trim();
  const transcript = cleanTranscript(heard);
  const evaluation = evaluateTranscript({
    transcript,
    confidence,
    minConfidence: current.options.minConfidence,
  });

  const result: SttFinalResult = {
    transcript,
    raw: heard,
    confidence,
    source: 'apple',
    accept: evaluation.accept,
    reason: evaluation.reason,
    // This engine keeps nothing. It has no need to: it *is* the good engine on
    // an iPhone, so there is nothing better to hand a recording to.
    audioUri: null,
  };

  finish(current, 'idle');
  // Fires last so the callback is free to start a fresh session.
  current.options.onFinal(result);
}

function finish(current: Session, next: VoiceState): void {
  detach(current);
  if (session === current) session = null;
  if (state !== next) {
    state = next;
    current.options.onStateChange?.(next);
  }
}

function setState(current: Session, next: VoiceState): void {
  if (state === next) return;
  state = next;
  current.options.onStateChange?.(next);
}

/**
 * Maps a native rejection onto the app's own error vocabulary.
 *
 * The codes the module raises are deliberately the ones
 * `expo-speech-recognition` uses, so this table and `toSttError`'s in `./stt`
 * say the same thing about the same failure rather than drifting into two
 * different sentences for one cause.
 */
function toAppleError(error: unknown): AppError {
  const code = nativeCode(error);
  const details = { code, message: message(error) };
  switch (code) {
    case 'ERR_SPEECH_NOT_ALLOWED':
      return new AppError(
        'permission_denied',
        'Ridik needs microphone and speech access to listen. Enable it in Settings.',
        { details },
      );
    case 'ERR_SPEECH_LANGUAGE_NOT_SUPPORTED':
      return new AppError('unsupported', 'That language is not supported on this device.', {
        details,
      });
    case 'ERR_SPEECH_UNSUPPORTED':
      return new AppError('unsupported', 'This iPhone cannot transcribe on the device.', {
        details,
      });
    case 'ERR_SPEECH_BUSY':
      return new AppError('conflict', 'The recogniser is busy. Try again in a moment.', {
        details,
        retryable: true,
      });
    case 'ERR_SPEECH_AUDIO_CAPTURE':
      return new AppError('unknown', 'Something interrupted the microphone.', {
        details,
        retryable: true,
      });
    default:
      return new AppError('unknown', 'Speech recognition failed.', { details });
  }
}

function nativeCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return '';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
