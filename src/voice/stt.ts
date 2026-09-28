/**
 * Speech-to-text: one utterance at a time, on-device where the phone can.
 *
 * The recogniser is a global native resource, so this module owns a single
 * session and refuses to run two at once. It adds the two things the platform
 * does not give us: a trailing-silence endpointer that works the same on both
 * OSes (the native endpointers differ wildly), and a confidence gate that knows
 * Android usually reports no confidence at all.
 *
 * ## Two engines behind one door
 *
 * On an iPhone with iOS 26 and the model downloaded, "the phone's recogniser"
 * means Apple's `SpeechAnalyzer` (`./apple`) rather than `SFSpeechRecognizer`
 * — four times fewer word errors, still local, still with a live caption, and
 * it does not fall back to Apple's servers the way this one does. Everywhere
 * else it means what it always did.
 *
 * The choice is made here rather than by the caller, and there is no setting
 * for it: `captureUtterance` and the pipeline above it are unchanged, and
 * `source` on the result is the only way to tell which one answered. A row
 * offering a strictly worse local engine would be a question with no answer.
 */
import {
  ExpoSpeechRecognitionModule,
  TaskHintIOS,
  type ExpoSpeechRecognitionErrorEvent,
  type ExpoSpeechRecognitionOptions,
  type ExpoSpeechRecognitionResultEvent,
} from 'expo-speech-recognition';
import { now } from '@/core/clock';
import { createLogger } from '@/core/logger';
import { AppError, err, fail, ok, toAppError, type Result } from '@/core/result';
import {
  abortAppleListening,
  appleAnalyzerFor,
  getAppleState,
  startAppleListening,
  stopAppleListening,
} from './apple';
import { cleanTranscript, createSilenceDetector, evaluateTranscript, type SilenceDetector } from './vad';
import {
  CONTEXTUAL_STRINGS_CAP,
  DEFAULT_LOCALE,
  DEFAULT_MIN_SPEECH_MS,
  DEFAULT_TRAILING_SILENCE_MS,
  MAX_UTTERANCE_MS,
  NO_OFFLINE_VOICE_MESSAGE,
  STOP_GRACE_MS,
  TICK_INTERVAL_MS,
  type SttFinalResult,
  type SttListenOptions,
  type VoiceState,
} from './types';

const log = createLogger('stt');

/** Give the previous attempt time to emit its `end` before restarting. */
const RESTART_DELAY_MS = 250;

const PERMISSION_MESSAGE =
  'Ridik needs microphone and speech access to listen. Enable it in Settings.';

type Subscription = { remove(): void };

type Session = {
  options: SttListenOptions;
  locale: string;
  onDevice: boolean;
  /** Set when the audio may not reach the network at all — see `onDeviceOnly`. */
  onDeviceOnly: boolean;
  retriedOnNetwork: boolean;
  subscriptions: Subscription[];
  detector: SilenceDetector;
  ticker: ReturnType<typeof setInterval> | null;
  startedAt: number;
  stoppingAt: number | null;
  settled: boolean;
  finalParts: string[];
  lastPartial: string;
  /** Lowest positive confidence seen; one bad segment should drag the whole down. */
  confidence: number | null;
  /** Set from `audiostart`/`audioend` when `captureAudio` was asked for. */
  audioUri: string | null;
};

let session: Session | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let state: VoiceState = 'idle';

/**
 * Which engine the last `startListening` handed the microphone to.
 *
 * Every exported function routes on it, so `stop` and `abort` reach whichever
 * one is actually holding the microphone. It is deliberately not reset on
 * settle: `startListening` aborts before it starts, and that abort has to find
 * the engine the *previous* turn used.
 */
let engine: 'platform' | 'apple' = 'platform';

export function getSttState(): VoiceState {
  return engine === 'apple' ? getAppleState() : state;
}

/**
 * Asks for microphone + speech-recognition access. Denial is a normal outcome
 * (the user tapped "Don't Allow"), so it comes back as a Result.
 */
export async function ensurePermissions(): Promise<Result<void>> {
  try {
    const current = await ExpoSpeechRecognitionModule.getPermissionsAsync();
    if (current.granted) return ok(undefined);
    if (!current.canAskAgain) return fail('permission_denied', PERMISSION_MESSAGE);
    const requested = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (requested.granted) return ok(undefined);
    return fail('permission_denied', PERMISSION_MESSAGE);
  } catch (error) {
    return err(toAppError(error, 'Could not check microphone permissions.'));
  }
}

/**
 * Starts listening. Resolves once the recogniser has been handed the request;
 * the transcript arrives through `onFinal`.
 */
export async function startListening(options: SttListenOptions): Promise<Result<void>> {
  abortListening();

  const permitted = await ensurePermissions();
  if (!permitted.ok) {
    emitState(options, 'error');
    options.onError?.(permitted.error);
    return permitted;
  }

  if (!isRecognitionAvailable()) {
    // Names the way out rather than just the wall. Real devices hit this too —
    // an Android without Google's speech services, an iPhone with dictation
    // switched off in Screen Time — and on all of them typing still works.
    const error = new AppError(
      'unsupported',
      'This device has no speech recogniser. You can type instead.',
    );
    emitState(options, 'error');
    options.onError?.(error);
    return err(error);
  }

  const locale = options.locale ?? DEFAULT_LOCALE;

  /*
   * Apple's analyzer first, on a phone that has the model for this language.
   *
   * Ahead of `isRecognitionAvailable()` on purpose, and it rescues a case that
   * used to be a dead end: dictation disabled in Screen Time makes the
   * platform recogniser unavailable and says to type instead, while
   * `SpeechAnalyzer` is a different framework and works regardless.
   *
   * A start failure falls through rather than being reported. `appleAnalyzerFor`
   * having said yes and `start` then failing is rare, and the honest answer to
   * it is the recogniser that has been serving this app all along — not an
   * error over a microphone that could still hear them.
   *
   * `preferOnDevice: false` is honoured even though nothing in the app sets
   * it. The option means "skip the on-device attempt", the analyzer *is* the
   * on-device attempt, and an option that silently stopped meaning what it
   * says is worse than one nobody uses.
   */
  const analyzerLocale =
    options.preferOnDevice === false ? null : await appleAnalyzerFor(locale);
  if (analyzerLocale !== null) {
    engine = 'apple';
    const started = await startAppleListening(options, analyzerLocale);
    if (started.ok) return started;
    log.warn('the analyzer would not start; using the platform recogniser', started.error);
  }
  engine = 'platform';

  const onDeviceOnly = options.onDeviceOnly === true;
  const onDevice =
    options.preferOnDevice === false && !onDeviceOnly ? false : await supportsOnDevice(locale);

  // The one case where "prefer on-device" is not enough. Without this the
  // session would start with `requiresOnDeviceRecognition: false`, which hands
  // the raw audio to Apple's or Google's speech servers — on a turn where the
  // app has just been told, and is about to tell the user again, that their
  // words are staying on the phone.
  if (onDeviceOnly && !onDevice) {
    const error = new AppError('unsupported', NO_OFFLINE_VOICE_MESSAGE);
    emitState(options, 'error');
    options.onError?.(error);
    return err(error);
  }

  return beginSession(options, locale, onDevice, onDeviceOnly, false);
}

/** Asks the engine for a final result and settles the session. */
export function stopListening(): void {
  if (engine === 'apple') {
    stopAppleListening();
    return;
  }
  const current = session;
  if (!current || current.settled) return;
  current.stoppingAt = now();
  setState(current, 'processing');
  try {
    ExpoSpeechRecognitionModule.stop();
  } catch (error) {
    log.warn('stop() failed; settling with what we have', error);
    abortEngine();
    settle(current);
  }
}

/** Throws the utterance away. No callback fires. */
export function abortListening(): void {
  if (engine === 'apple') {
    abortAppleListening();
    return;
  }
  if (restartTimer !== null) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  const current = session;
  if (!current) {
    // Nothing is listening, so idle is the truth even after a failed start.
    state = 'idle';
    return;
  }
  current.settled = true;
  // A cancelled session reports nothing to anybody, so its recording has no
  // owner but this line. `abortListening` is also what `startListening` calls
  // on its way in, which makes this the sweep for a session the *previous*
  // turn abandoned.
  discardRecording(current);
  detach(current);
  session = null;
  abortEngine();
  if (state !== 'idle') {
    state = 'idle';
    current.options.onStateChange?.('idle');
  }
}

/* ------------------------------------------------------------- internals -- */

/**
 * Tells the native recogniser to let go of the microphone. Safe to call when
 * nothing is running, and the only way to free the mic on the paths where we
 * stop waiting for the engine before it has ended by itself.
 */
function abortEngine(): void {
  try {
    ExpoSpeechRecognitionModule.abort();
  } catch (error) {
    log.warn('abort() failed', error);
  }
}

function isRecognitionAvailable(): boolean {
  try {
    return ExpoSpeechRecognitionModule.isRecognitionAvailable();
  } catch (error) {
    log.warn('isRecognitionAvailable() threw; assuming available', error);
    return true;
  }
}

/**
 * On-device recognition keeps audio off the network and works offline, so it is
 * always preferred. An empty installed-locale list means "unknown" (Android 12
 * and below never populates it) — we still try, and fall back on the error.
 */
async function supportsOnDevice(locale: string): Promise<boolean> {
  try {
    if (!ExpoSpeechRecognitionModule.supportsOnDeviceRecognition()) return false;
    const { installedLocales } = await ExpoSpeechRecognitionModule.getSupportedLocales({});
    if (installedLocales.length === 0) return true;
    const wanted = locale.toLowerCase();
    const language = wanted.split('-')[0] ?? wanted;
    return installedLocales.some((installed) => {
      const value = installed.toLowerCase().replace('_', '-');
      return value === wanted || value.startsWith(`${language}-`);
    });
  } catch (error) {
    log.debug('could not read supported locales', error);
    return false;
  }
}

function beginSession(
  options: SttListenOptions,
  locale: string,
  onDevice: boolean,
  onDeviceOnly: boolean,
  retriedOnNetwork: boolean,
): Result<void> {
  const current: Session = {
    options,
    locale,
    onDevice,
    onDeviceOnly,
    retriedOnNetwork,
    subscriptions: [],
    detector: createSilenceDetector({
      trailingSilenceMs: options.silenceTimeoutMs ?? DEFAULT_TRAILING_SILENCE_MS,
      minSpeechMs: DEFAULT_MIN_SPEECH_MS,
      onTimeout: () => stopListening(),
    }),
    ticker: null,
    startedAt: now(),
    stoppingAt: null,
    settled: false,
    finalParts: [],
    lastPartial: '',
    confidence: null,
    audioUri: null,
  };

  session = current;
  setState(current, 'starting');
  attach(current);

  try {
    ExpoSpeechRecognitionModule.start(
      recognitionOptions(locale, onDevice, options.contextualStrings, options.captureAudio),
    );
  } catch (error) {
    const appError = toAppError(error, 'Could not start listening.');
    current.settled = true;
    finish(current, 'error');
    options.onError?.(appError);
    return err(appError);
  }

  current.ticker = setInterval(() => tick(current), TICK_INTERVAL_MS);
  return ok(undefined);
}

function recognitionOptions(
  locale: string,
  onDevice: boolean,
  contextualStrings: readonly string[] | undefined,
  captureAudio: SttListenOptions['captureAudio'],
): ExpoSpeechRecognitionOptions {
  // Sliced rather than trusted: the builder caps its own output, but this is
  // the boundary the native module sits behind, and an oversized bias list is
  // not rejected — it quietly makes recognition worse.
  const bias = (contextualStrings ?? []).slice(0, CONTEXTUAL_STRINGS_CAP);
  return {
    lang: locale,
    // Partial results feed both the live UI text and our own endpointer.
    interimResults: true,
    continuous: true,
    requiresOnDeviceRecognition: onDevice,
    addsPunctuation: true,
    maxAlternatives: 1,
    iosTaskHint: TaskHintIOS.dictation,
    // The user's own proper nouns. Omitted entirely when there are none, so a
    // fresh install sends exactly what it always did.
    ...(bias.length > 0 ? { contextualStrings: bias } : {}),
    // Asked for only where it can be honoured — see `keptAudioOptions` in
    // `./capability`, which is also what decides the format. On Android the
    // library tees its own recorder into the recognition service rather than
    // opening a second microphone, so this costs the session nothing.
    ...(captureAudio ? { recordingOptions: captureAudio } : {}),
  };
}

function attach(current: Session): void {
  current.subscriptions.push(
    ExpoSpeechRecognitionModule.addListener('start', () => setState(current, 'listening')),
    ExpoSpeechRecognitionModule.addListener('speechstart', () => current.detector.noteSpeech(now())),
    ExpoSpeechRecognitionModule.addListener('speechend', () => current.detector.noteSilence(now())),
    ExpoSpeechRecognitionModule.addListener('result', (event) => handleResult(current, event)),
    ExpoSpeechRecognitionModule.addListener('nomatch', () => current.detector.noteSilence(now())),
    ExpoSpeechRecognitionModule.addListener('error', (event) => handleError(current, event)),
    ExpoSpeechRecognitionModule.addListener('end', () => settle(current)),
    // Both carry the uri; `audioend` is the one that means the file is closed
    // and safe to read, and `audiostart` is kept only so a session that dies
    // before it still names the file somebody has to delete.
    ExpoSpeechRecognitionModule.addListener('audiostart', (event) => {
      current.audioUri = event?.uri ?? null;
    }),
    ExpoSpeechRecognitionModule.addListener('audioend', (event) => {
      current.audioUri = event?.uri ?? current.audioUri;
    }),
  );
}

function detach(current: Session): void {
  for (const subscription of current.subscriptions) {
    try {
      subscription.remove();
    } catch (error) {
      log.warn('could not remove recogniser listener', error);
    }
  }
  current.subscriptions.length = 0;
  if (current.ticker !== null) {
    clearInterval(current.ticker);
    current.ticker = null;
  }
  current.detector.dispose();
}

function handleResult(current: Session, event: ExpoSpeechRecognitionResultEvent): void {
  if (current.settled) return;
  const best = event.results[0];
  if (!best) return;
  const at = now();

  if (!event.isFinal) {
    if (!best.transcript.trim()) return;
    current.lastPartial = best.transcript;
    current.detector.noteSpeech(at);
    current.options.onPartial?.(best.transcript);
    return;
  }

  if (best.transcript.trim()) {
    current.finalParts.push(best.transcript.trim());
    noteConfidence(current, best.confidence);
  }
  // A final segment means the engine heard the end of speech, even in
  // continuous mode where more segments may still follow.
  current.detector.noteSilence(at);
  if (current.stoppingAt !== null) settle(current);
}

function noteConfidence(current: Session, reported: number): void {
  if (!Number.isFinite(reported) || reported <= 0) return;
  current.confidence =
    current.confidence === null ? reported : Math.min(current.confidence, reported);
}

function handleError(current: Session, event: ExpoSpeechRecognitionErrorEvent): void {
  if (current.settled) return;

  // We aborted on purpose; the caller already knows.
  if (event.error === 'aborted') return;

  if (
    current.onDevice &&
    !current.retriedOnNetwork &&
    (event.error === 'service-not-allowed' || event.error === 'language-not-supported')
  ) {
    // …unless the audio may not leave the phone. This retry is the second way
    // the recording reaches a speech server, and it is the quieter one: the
    // first attempt looked local and only the fallback is not.
    if (current.onDeviceOnly) {
      log.info('on-device recognition unavailable and the network is not permitted', event);
      const error = new AppError('unsupported', NO_OFFLINE_VOICE_MESSAGE);
      current.settled = true;
      finish(current, 'error');
      current.options.onError?.(error);
      return;
    }
    log.info('on-device recognition unavailable; retrying over the network', event);
    retryOnNetwork(current);
    return;
  }

  // "Heard nothing" is an empty utterance, not a failure the user must be
  // shown as an error — it flows through the normal empty-transcript path.
  if (event.error === 'no-speech' || event.error === 'speech-timeout') {
    settle(current);
    return;
  }

  /*
    `client` is Android's `SpeechRecognizer.ERROR_CLIENT`, and on this hardware
    it is what the recogniser says **as it is stopped** — after the final result
    has already been delivered. A farewell, not a failure.

    Observed on a Galaxy S23: a perfectly transcribed sentence
    ("Book two hours for the robotics report on Thursday afternoon and remind me
    to email the tutor the day before") followed by `code: 'client'`,
    `message: 'Other client side errors.'` — so the screen reported "Speech
    recognition failed." over a transcript that was completely correct, and the
    turn was never run. Every dictation ended that way.

    This is the same fact AGENTS.md already records — *the recogniser talks
    after it is stopped* — one step further on. The session ticket in `store.ts`
    guards a *superseded* session's late callbacks; this one arrives for the
    session that is still current, straight after a good result, so nothing was
    catching it.

    Settled, not swallowed: only when there are words to settle with. With
    nothing heard it stays an error, because "client error" over a microphone
    that genuinely failed to start is not something to report as silence.
  */
  if (event.error === 'client' && (current.finalParts.length > 0 || current.lastPartial.trim())) {
    log.info('recogniser reported `client` after a result; that is the stop, not a failure', {
      native: event.code,
      parts: current.finalParts.length,
    });
    settle(current);
    return;
  }

  // The code is the only thing that says *which* failure this was, and the
  // message the user sees deliberately does not: "Speech recognition failed."
  // is the `default` arm of `toSttError`, so every unmapped code arrives
  // looking identical. The details went into the `AppError` and nowhere else,
  // which made a real failure on a real phone undiagnosable — logcat had
  // nothing at all about it. One line, before the mapping throws the code away.
  log.warn('recogniser failed', {
    code: event.error,
    native: event.code,
    message: event.message,
  });
  const error = toSttError(event);
  current.settled = true;
  finish(current, 'error');
  current.options.onError?.(error);
}

function retryOnNetwork(current: Session): void {
  current.settled = true;
  // This one is the reason the funnel above was not enough on its own: the
  // retry does not `finish`, it abandons. Measured on a device — the
  // on-device attempt and the retry each left a recording behind.
  discardRecording(current);
  detach(current);
  if (session === current) session = null;
  try {
    ExpoSpeechRecognitionModule.abort();
  } catch (error) {
    log.warn('abort() before network retry failed', error);
  }
  // Let the dead attempt emit its trailing `end` before new listeners exist.
  restartTimer = setTimeout(() => {
    restartTimer = null;
    const started = beginSession(current.options, current.locale, false, false, true);
    if (!started.ok) log.warn('network retry failed to start', started.error);
  }, RESTART_DELAY_MS);
}

function tick(current: Session): void {
  if (current.settled) return;
  const at = now();

  if (current.stoppingAt !== null) {
    if (at - current.stoppingAt >= STOP_GRACE_MS) {
      // The engine is still holding the microphone: nothing else will free it,
      // because `settle` drops the session and later aborts find nothing.
      log.warn('recogniser never returned a final result; settling');
      abortEngine();
      settle(current);
    }
    return;
  }

  if (at - current.startedAt >= MAX_UTTERANCE_MS) {
    log.info('utterance hit the hard cap; finalising');
    stopListening();
    return;
  }

  current.detector.tick(at);
}

function settle(current: Session): void {
  if (current.settled) return;
  current.settled = true;
  setState(current, 'processing');

  const raw = (current.finalParts.join(' ') || current.lastPartial).trim();
  const transcript = cleanTranscript(raw);
  const evaluation = evaluateTranscript({
    transcript,
    confidence: current.confidence,
    minConfidence: current.options.minConfidence,
  });

  const result: SttFinalResult = {
    transcript,
    raw,
    confidence: current.confidence,
    source: current.onDevice ? 'ondevice' : 'network',
    accept: evaluation.accept,
    reason: evaluation.reason,
    audioUri: current.audioUri,
  };

  // Ownership travels with the result. Cleared before `finish` so the funnel
  // there does not delete a file the caller is about to upload.
  current.audioUri = null;
  finish(current, 'idle');
  // Fires last so the callback is free to start a fresh session.
  current.options.onFinal(result);
}

/**
 * Drops a recording nobody is going to be handed.
 *
 * `settle` clears `audioUri` before it calls `finish`, because there the file
 * has travelled out on the result and the caller owns it. Everything else —
 * an error, a cancel, the network retry — reaches here still holding one, and
 * the only correct thing to do with it is throw it away.
 */
function discardRecording(current: Session): void {
  const uri = current.audioUri;
  if (uri === null) return;
  current.audioUri = null;
  current.options.onDiscardAudio?.(uri);
}

function finish(current: Session, next: VoiceState): void {
  discardRecording(current);
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

/** State change for a session that never got created. */
function emitState(options: SttListenOptions, next: VoiceState): void {
  if (state === next) return;
  state = next;
  options.onStateChange?.(next);
}

function toSttError(event: ExpoSpeechRecognitionErrorEvent): AppError {
  const details = { code: event.error, native: event.code, message: event.message };
  switch (event.error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return new AppError('permission_denied', PERMISSION_MESSAGE, { details });
    case 'network':
      return new AppError('offline', 'No connection for speech recognition.', {
        details,
        retryable: true,
      });
    case 'language-not-supported':
      return new AppError('unsupported', 'That language is not supported on this device.', {
        details,
      });
    case 'busy':
      return new AppError('conflict', 'The recogniser is busy. Try again in a moment.', {
        details,
        retryable: true,
      });
    case 'audio-capture':
    case 'interrupted':
      return new AppError('unknown', 'Something interrupted the microphone.', {
        details,
        retryable: true,
      });
    default:
      return new AppError('unknown', 'Speech recognition failed.', { details });
  }
}
