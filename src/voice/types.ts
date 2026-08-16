/**
 * Shared vocabulary for the voice pipeline.
 *
 * Kept free of native imports so the pure half of the pipeline (`vad.ts`) and
 * its tests can load it under plain Node.
 */
import type { AppError } from '@/core/result';

/** Recogniser lifecycle as the UI needs to see it. */
export type VoiceState = 'idle' | 'starting' | 'listening' | 'processing' | 'error';

/** Where a transcript came from. Surfaced so the UI can badge low-trust text. */
export type TranscriptSource = 'ondevice' | 'network' | 'whisper' | 'manual';

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
  source: 'ondevice' | 'network';
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

export const DEFAULT_LOCALE = 'en-US';
export const DEFAULT_MIN_CONFIDENCE = 0.7;
export const DEFAULT_TRAILING_SILENCE_MS = 1500;
export const DEFAULT_MIN_SPEECH_MS = 300;
/** Android's TTS engine truncates long utterances; keep chunks well under it. */
export const DEFAULT_TTS_CHUNK_CHARS = 200;

/** Spoken back verbatim when a transcript is unusable. */
export const DID_NOT_CATCH_MESSAGE = "I didn't catch that clearly. Try again?";
