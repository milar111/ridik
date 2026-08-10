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
};

export const DEFAULT_LOCALE = 'en-US';
export const DEFAULT_MIN_CONFIDENCE = 0.7;
export const DEFAULT_TRAILING_SILENCE_MS = 1500;
export const DEFAULT_MIN_SPEECH_MS = 300;
/** Android's TTS engine truncates long utterances; keep chunks well under it. */
export const DEFAULT_TTS_CHUNK_CHARS = 200;

/** Spoken back verbatim when a transcript is unusable. */
export const DID_NOT_CATCH_MESSAGE = "I didn't catch that clearly. Try again?";
