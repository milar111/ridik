/**
 * Whisper fallback for the cases the on-device recogniser cannot handle: a
 * noisy room, an accent it keeps mangling, or a locale it has no model for.
 *
 * Entirely optional — the caller only gets here when the user has turned the
 * fallback on and supplied a key. Audio leaves the device on this path, so it
 * is never the default and the recording is deleted the moment we are done.
 */
import { File, UploadType } from 'expo-file-system';
import { AppError, err, fail, ok, type Result } from '@/core/result';
import { DEFAULT_MAX_SECONDS, isAbort, recordThenTranscribe } from './record';

const TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MODEL = 'whisper-1';


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
  // The recording, the audio session and the deletion are `record.ts` now —
  // shared with `assemblyai.ts`, because a second copy of that cleanup is a
  // second place for a file holding somebody's voice to survive a failure.
  return recordThenTranscribe(
    {
      maxSeconds: options.maxSeconds ?? DEFAULT_MAX_SECONDS,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.stopSignal !== undefined ? { stopSignal: options.stopSignal } : {}),
    },
    (uri) =>
      transcribeFile({
        apiKey: options.apiKey,
        uri,
        ...(options.language !== undefined ? { language: options.language } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      }),
  );
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





