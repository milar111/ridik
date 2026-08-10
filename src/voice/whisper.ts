/**
 * Whisper fallback for the cases the on-device recogniser cannot handle: a
 * noisy room, an accent it keeps mangling, or a locale it has no model for.
 *
 * Entirely optional — the caller only gets here when the user has turned the
 * fallback on and supplied a key. Audio leaves the device on this path, so it
 * is never the default and the recording is deleted the moment we are done.
 */
import {
  AudioModule,
  AudioQuality,
  IOSOutputFormat,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  type AudioMode,
  type RecordingOptions,
} from 'expo-audio';
import { File, UploadType } from 'expo-file-system';
import { createLogger } from '@/core/logger';
import { AppError, err, fail, ok, toAppError, type Result } from '@/core/result';

const log = createLogger('whisper');

const TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MODEL = 'whisper-1';
const DEFAULT_MAX_SECONDS = 60;
const MAX_SECONDS_CEILING = 300;

/** Mono 16 kHz AAC: what Whisper wants, and a fraction of the upload size. */
const RECORDING_OPTIONS: RecordingOptions = {
  extension: '.m4a',
  sampleRate: 16_000,
  numberOfChannels: 1,
  bitRate: 64_000,
  directory: 'cache',
  android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
  ios: {
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.MEDIUM,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: { mimeType: 'audio/webm', bitsPerSecond: 64_000 },
};

export type WhisperTranscript = {
  transcript: string;
  /** Whisper reports no per-utterance confidence. */
  confidence: null;
};

export type RecordAndTranscribeOptions = {
  apiKey: string;
  maxSeconds?: number;
  /** Cancels the whole operation; nothing is transcribed. */
  signal?: AbortSignal;
  /** Ends the recording early and transcribes what was captured. */
  stopSignal?: AbortSignal;
  /** BCP-47 hint passed to Whisper; improves accuracy when known. */
  language?: string;
};

export function isConfigured(apiKey: string | null | undefined): apiKey is string {
  return typeof apiKey === 'string' && apiKey.trim().length > 0;
}

/**
 * Records up to `maxSeconds` of audio and transcribes it. The temporary file is
 * always removed, including when the upload throws.
 */
export async function recordAndTranscribe(
  options: RecordAndTranscribeOptions,
): Promise<Result<WhisperTranscript>> {
  if (!isConfigured(options.apiKey)) {
    return fail('invalid_input', 'No transcription key is configured.');
  }
  if (options.signal?.aborted) return fail('invalid_input', 'Recording was cancelled.');

  const permitted = await requestRecordingPermission();
  if (!permitted.ok) return permitted;

  const maxSeconds = Math.min(Math.max(1, options.maxSeconds ?? DEFAULT_MAX_SECONDS), MAX_SECONDS_CEILING);
  let recorder: InstanceType<typeof AudioModule.AudioRecorder> | null = null;
  let uri: string | null = null;

  try {
    await applyAudioMode({ allowsRecording: true, playsInSilentMode: true, interruptionMode: 'doNotMix' });
    recorder = new AudioModule.AudioRecorder({});
    await recorder.prepareToRecordAsync(RECORDING_OPTIONS);
    recorder.record();

    const cancelled = await waitForRecording(maxSeconds, options.signal, options.stopSignal);
    await recorder.stop();
    uri = recorder.uri;

    if (cancelled) return fail('invalid_input', 'Recording was cancelled.');
    if (!uri) return fail('unknown', 'The recording produced no audio.');
    return await transcribeFile({
      apiKey: options.apiKey,
      uri,
      language: options.language,
      signal: options.signal,
    });
  } catch (error) {
    return err(toAppError(error, 'Could not record audio.'));
  } finally {
    const path = uri ?? safeUri(recorder);
    deleteQuietly(path);
    releaseQuietly(recorder);
    await applyAudioMode({ allowsRecording: false, interruptionMode: 'mixWithOthers' });
  }
}

/** Uploads an existing audio file. Split out so callers can drive recording themselves. */
export async function transcribeFile(options: {
  apiKey: string;
  uri: string;
  language?: string;
  signal?: AbortSignal;
}): Promise<Result<WhisperTranscript>> {
  const file = new File(options.uri);
  if (!file.exists) return fail('not_found', 'The recording is missing.');

  const parameters: Record<string, string> = { model: MODEL, response_format: 'json' };
  if (options.language) parameters.language = options.language.split('-')[0] ?? options.language;

  let status: number;
  let body: string;
  try {
    const response = await file.upload(TRANSCRIPTIONS_URL, {
      httpMethod: 'POST',
      uploadType: UploadType.MULTIPART,
      fieldName: 'file',
      mimeType: 'audio/m4a',
      headers: { Authorization: `Bearer ${options.apiKey}` },
      parameters,
      signal: options.signal,
    });
    status = response.status;
    body = response.body;
  } catch (error) {
    if (isAbort(error)) return fail('invalid_input', 'Transcription was cancelled.');
    return err(
      new AppError('offline', 'Could not reach the transcription service.', {
        cause: error,
        retryable: true,
      }),
    );
  }

  if (status < 200 || status >= 300) return err(httpError(status, body));

  const transcript = readTranscript(body);
  if (transcript === null) {
    return err(new AppError('upstream', 'The transcription service sent something unreadable.', {
      details: body.slice(0, 500),
    }));
  }
  return ok({ transcript, confidence: null });
}

/* ------------------------------------------------------------- internals -- */

async function requestRecordingPermission(): Promise<Result<void>> {
  try {
    const response = await requestRecordingPermissionsAsync();
    if (response.granted) return ok(undefined);
    return fail('permission_denied', 'Ridik needs microphone access to record.');
  } catch (error) {
    return err(toAppError(error, 'Could not check microphone permissions.'));
  }
}

/** Resolves true when the operation was cancelled outright. */
function waitForRecording(
  maxSeconds: number,
  signal?: AbortSignal,
  stopSignal?: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (cancelled: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCancel);
      stopSignal?.removeEventListener('abort', onStop);
      resolve(cancelled);
    };
    const onCancel = () => finish(true);
    const onStop = () => finish(false);

    const timer = setTimeout(() => finish(false), maxSeconds * 1000);
    signal?.addEventListener('abort', onCancel);
    stopSignal?.addEventListener('abort', onStop);
    if (signal?.aborted) finish(true);
    else if (stopSignal?.aborted) finish(false);
  });
}

/**
 * Mirrors the mapping the Gemini client uses: auth problems are the user's to
 * fix, throttling and 5xx are worth retrying, everything else is terminal.
 */
function httpError(status: number, body: string): AppError {
  const details = describe(body);
  if (status === 401 || status === 403) {
    return new AppError('permission_denied', 'The transcription key was rejected.', { details });
  }
  if (status === 429) {
    return new AppError('rate_limited', 'Transcription is rate limited. Try again shortly.', {
      details,
      retryable: true,
    });
  }
  if (status === 400 || status === 413 || status === 422) {
    return new AppError('invalid_input', 'That recording could not be transcribed.', { details });
  }
  if (status >= 500) {
    return new AppError('upstream', 'The transcription service is having trouble.', {
      details,
      retryable: true,
    });
  }
  return new AppError('unknown', `Transcription failed (HTTP ${status}).`, { details });
}

function readTranscript(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { text?: unknown }).text === 'string') {
      return (parsed as { text: string }).text.trim();
    }
    return null;
  } catch {
    return null;
  }
}

function describe(body: string): string {
  const parsed = readErrorMessage(body);
  return parsed ?? body.slice(0, 500);
}

function readErrorMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    return typeof message === 'string' ? message : null;
  } catch {
    return null;
  }
}

function isAbort(error: unknown): boolean {
  if (error instanceof Error) return error.name === 'AbortError' || /abort/i.test(error.message);
  return false;
}

function safeUri(recorder: InstanceType<typeof AudioModule.AudioRecorder> | null): string | null {
  if (!recorder) return null;
  try {
    return recorder.uri;
  } catch {
    return null;
  }
}

function deleteQuietly(uri: string | null): void {
  if (!uri) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch (error) {
    log.warn('could not delete the temporary recording', error);
  }
}

function releaseQuietly(recorder: InstanceType<typeof AudioModule.AudioRecorder> | null): void {
  try {
    recorder?.release();
  } catch (error) {
    log.warn('could not release the recorder', error);
  }
}

async function applyAudioMode(mode: Partial<AudioMode>): Promise<void> {
  try {
    await setAudioModeAsync(mode);
  } catch (error) {
    log.warn('could not change the audio mode', error);
  }
}
