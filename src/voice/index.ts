/**
 * The one entry point the UI uses for voice.
 *
 * `captureUtterance` hides the whole ladder: on-device recognition first,
 * network recognition when the device cannot, Whisper when the user has opted
 * in and the recogniser gave us nothing usable, and typed text from the
 * fallback modal when the user gives up on speaking altogether.
 */
import { createLogger } from '@/core/logger';
import { AppError, err, fail, ok, toAppError, type AppErrorCode, type Result } from '@/core/result';
import { abortListening, getSttState, startListening, stopListening } from './stt';
import { isSpeaking, speak, stop as stopSpeaking } from './tts';
import { cleanTranscript, createSilenceDetector, chunkForSpeech, evaluateTranscript } from './vad';
import { isConfigured as isWhisperConfigured, recordAndTranscribe } from './whisper';
import {
  DID_NOT_CATCH_MESSAGE,
  type TranscriptReason,
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
  /** Cancels a Whisper recording in progress. */
  signal?: AbortSignal;
  /** Ends a Whisper recording early and transcribes what was captured. */
  stopSignal?: AbortSignal;
};

/**
 * Failures the Whisper fallback can plausibly fix. A denied microphone or a
 * dead connection are not among them — Whisper needs both.
 */
const WHISPER_RECOVERS: ReadonlySet<AppErrorCode> = new Set<AppErrorCode>([
  'invalid_input',
  'unsupported',
  'not_found',
  'unknown',
]);

/** Captures one utterance. Never throws; "I didn't hear you" is a Result. */
export async function captureUtterance(options: CaptureOptions = {}): Promise<Result<VoiceCapture>> {
  if (options.manualText !== undefined) return captureManual(options.manualText);

  const heard = await listenOnce(options);
  if (heard.ok) return heard;

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

function listenOnce(options: CaptureOptions): Promise<Result<VoiceCapture>> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: Result<VoiceCapture>) => {
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
      onError: (error) => done(err(error)),
      onFinal: (result) => {
        if (!result.accept) {
          done(rejection(result.reason));
          return;
        }
        done(
          ok({
            transcript: result.transcript,
            confidence: result.confidence,
            source: result.source,
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

function rejection(reason: TranscriptReason): Result<VoiceCapture> {
  return err(new AppError('invalid_input', DID_NOT_CATCH_MESSAGE, { details: { reason } }));
}

function canUseWhisper(options: CaptureOptions, error: AppError): boolean {
  if (!options.whisper?.enabled) return false;
  if (!isWhisperConfigured(options.whisper.apiKey)) return false;
  return WHISPER_RECOVERS.has(error.code);
}

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
