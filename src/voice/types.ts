/**
 * Shared vocabulary for the voice pipeline.
 *
 * Kept free of native imports so the pure half of the pipeline (`vad.ts`) and
 * its tests can load it under plain Node.
 */
import type { AppError } from '@/core/result';

/** Recogniser lifecycle as the UI needs to see it. */
export type VoiceState = 'idle' | 'starting' | 'listening' | 'processing' | 'error';

/**
 * Where a transcript came from. Surfaced so the UI can badge low-trust text.
 *
 * `apple` is `SpeechAnalyzer` and `ondevice` is `SFSpeechRecognizer`, and they
 * are told apart deliberately even though both are local: the whole reason to
 * wire the first was that transcript quality differs sharply between them, and
 * a log that cannot say which engine produced a bad sentence makes the next
 * investigation guesswork.
 */
export type TranscriptSource =
  | 'apple'
  | 'ondevice'
  | 'network'
  | 'whisper'
  | 'assemblyai'
  | 'manual';

export type TranscriptReason = 'ok' | 'empty' | 'low_confidence' | 'too_short';

export type TranscriptEvaluation = {
  accept: boolean;
  reason: TranscriptReason;
};

/** What the rest of the app consumes: one utterance, ready for the LLM. */
export type VoiceCapture = {
  transcript: string;
  /** `null` when the engine reported no usable confidence (common on Android). */
  confidence: number | null;
  source: TranscriptSource;
};

export type SttFinalResult = TranscriptEvaluation & {
  /** Cleaned text. Empty when the engine returned nothing usable. */
  transcript: string;
  /** Exactly what the recogniser said, before cleaning. Kept for diagnostics. */
  raw: string;
  confidence: number | null;
  source: 'apple' | 'ondevice' | 'network';
  /**
   * The audio the recogniser just heard, when it was able to keep a copy.
   *
   * `null` on every path but one — see `captureAudio` below. The caller owns
   * the file from here and **must delete it**: it is somebody's voice sitting
   * in the cache directory, and the recogniser will not clean up after a
   * caller that forgot.
   */
  audioUri: string | null;
};

export type SttListenOptions = {
  onPartial?: (text: string) => void;
  onFinal: (result: SttFinalResult) => void;
  onError?: (error: AppError) => void;
  onStateChange?: (state: VoiceState) => void;
  /** BCP-47, e.g. "en-US". */
  locale?: string;
  minConfidence?: number;
  /** Trailing silence that ends the utterance. */
  silenceTimeoutMs?: number;
  /** Set false to skip the on-device attempt entirely. */
  preferOnDevice?: boolean;
  /**
   * The user's own proper nouns, biasing the recogniser towards them.
   *
   * `SFSpeechRecognitionRequest.contextualStrings` on iOS and
   * `EXTRA_BIASING_STRINGS` (API 33+) on Android. Without it the engine returns
   * the nearest word in its general vocabulary — a colleague's name, a company,
   * a list the user invented — and the wrong word lands on a real row.
   *
   * Ranked and capped at `CONTEXTUAL_STRINGS_CAP` by `./dictionary`; anything
   * past that is dropped here too, because a bias list is a hint and an
   * oversized one degrades the recognition it was meant to help.
   */
  contextualStrings?: readonly string[];
  /**
   * Refuse the platform's *network* recogniser outright, even when the device
   * has no offline model for the locale.
   *
   * On-device recognition has always been preferred, and preferring is not the
   * same promise as guaranteeing: `supportsOnDeviceRecognition()` is false on a
   * great many Android devices and on any iPhone whose locale dictation has not
   * been downloaded, and the session then starts with
   * `requiresOnDeviceRecognition: false` — which streams the raw audio to
   * Apple's or Google's speech servers. There is also a silent retry over the
   * network when the on-device engine reports `service-not-allowed` or
   * `language-not-supported`.
   *
   * That is a defensible default for someone who agreed to it and a false
   * statement to someone who did not: the consent screen's third panel is about
   * the recording, and the refusal notice says in so many words that nothing
   * went to the provider. So the pipeline sets this whenever consent is not
   * `granted`, and a phone with no offline voice for the language is told to
   * type rather than quietly uploaded.
   */
  onDeviceOnly?: boolean;
  /**
   * Keep a copy of the audio the recogniser heard, for a better engine to read.
   *
   * This is the one way out of the trap the rest of this file is built around:
   * every rescue rung fires only when the recogniser **failed**, and the
   * failure that actually hurts is a recogniser that succeeds and is wrong. A
   * confident wrong answer never reaches a rescue.
   *
   * It is not two microphones. On Android 13+ the recognition library owns a
   * single `AudioRecord`, writes the PCM to a file, and hands that same stream
   * to the recognition service as `RecognizerIntent.EXTRA_AUDIO_SOURCE` — so
   * the live caption and the upgrade transcript come from one capture and
   * there is no contention to lose. Measured on a device: a 16 kHz mono 16-bit
   * WAV in the app's cache, with partials still arriving word by word.
   *
   * It carries the *format* rather than a yes, because the two platforms do
   * not agree on one: Android already writes 16 kHz mono PCM and ignores the
   * fields, iOS records at the input node's own 44.1/48 kHz float unless told
   * otherwise. `keptAudioOptions()` in `./capability` is the only thing that
   * decides, so this module needs no `Platform` — which it could not read
   * anyway, being loaded under plain Node by the `logic` project.
   *
   * Only ask for it where that function says yes. Elsewhere the request is
   * accepted and silently ignored, which is worse than refusing: the caller
   * waits for a file that is never coming.
   */
  captureAudio?: {
    persist: true;
    outputSampleRate?: number;
    /** The library's own union; widening it to `string` makes the option unusable. */
    outputEncoding?: 'pcmFormatFloat32' | 'pcmFormatFloat64' | 'pcmFormatInt16' | 'pcmFormatInt32';
  };
  /**
   * A recording this module is abandoning rather than reporting.
   *
   * Every session that ends through `onFinal` hands its `audioUri` over with
   * the result, and the caller deletes it. Every *other* ending — an error, a
   * cancel, and above all the silent retry over the network, which abandons
   * one session and starts another — has nowhere to put the uri, and the file
   * then sits in the cache directory for ever. Two of them were measured on a
   * device before this existed: one from the on-device attempt and one from
   * the retry, both holding whatever had been said.
   *
   * It is a callback rather than a delete because this module must stay
   * loadable under plain Node — see the note on `canCaptureAudio` — and the
   * file APIs are native. The ladder in `./index` owns the deleting.
   */
  onDiscardAudio?: (uri: string) => void;
};

/**
 * What the user is told when the words may not leave the phone and the phone
 * cannot do it alone.
 *
 * Names the two ways out — type it, or turn the assistant on — because a wall
 * with no door reads as a broken microphone, and this one is a choice the user
 * made and can unmake.
 */
export const NO_OFFLINE_VOICE_MESSAGE =
  'This phone has no offline voice for your language, and Ridik is keeping your words on ' +
  'this phone. You can type instead, or turn the assistant on in Settings.';

/**
 * How many bias phrases a recognition session may carry.
 *
 * Apple's guidance for `contextualStrings` is to keep the array small — the
 * list is weighted into the language model for the whole session, so a large
 * one drags ordinary words towards the user's nouns and costs more accuracy
 * than it buys. Android's `EXTRA_BIASING_STRINGS` is a hint the recogniser is
 * free to truncate, and a service that truncates decides *for* us which names
 * survive. A hundred is comfortably inside both, and `./dictionary` spends it
 * on the names most likely to be said next rather than the first hundred rows.
 */
export const CONTEXTUAL_STRINGS_CAP = 100;

/**
 * How the endpointer is driven, shared by both local engines.
 *
 * They were constants in `./stt` until `./apple` needed the same three, and
 * two copies of a timeout that must agree is how the two engines end up
 * feeling like different products. `./vad` owns the *decision*; these are the
 * clock it runs on.
 */
export const TICK_INTERVAL_MS = 150;
/** Nobody dictates a single command for a minute; stop before the battery does. */
export const MAX_UTTERANCE_MS = 60_000;
/** How long to wait for a final result after asking the engine to stop. */
export const STOP_GRACE_MS = 2_500;

export const DEFAULT_LOCALE = 'en-US';
export const DEFAULT_MIN_CONFIDENCE = 0.7;
export const DEFAULT_TRAILING_SILENCE_MS = 1500;
export const DEFAULT_MIN_SPEECH_MS = 300;
/** Android's TTS engine truncates long utterances; keep chunks well under it. */
export const DEFAULT_TTS_CHUNK_CHARS = 200;

/** Spoken back verbatim when a transcript is unusable. */
export const DID_NOT_CATCH_MESSAGE = "I didn't catch that clearly. Try again?";
