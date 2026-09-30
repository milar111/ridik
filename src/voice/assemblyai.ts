/**
 * AssemblyAI transcription, for when the phone's own recogniser is not good
 * enough — which on a real Android device, in a real room, it often is not.
 *
 * ## Why this exists next to `whisper.ts` rather than replacing it
 *
 * Whisper is a *rescue*: `captureUtterance` reaches it only when the platform
 * recogniser **failed**. That covers a dead session and a locale with no model,
 * and it does nothing at all for the complaint that prompted this file — words
 * quietly going missing from a transcript the recogniser was perfectly happy
 * with. A confident wrong answer never fails, so it never reaches a fallback.
 *
 * So this is wired as an *engine* the user can pick, not only as a rung under
 * one. See `sttEngine` in `src/repositories/settings.ts`.
 *
 * ## What it costs, and it is not money
 *
 * This is upload-and-wait, so **there is no live caption while you speak**.
 * `expo-audio`'s recorder writes a file; it has no PCM callback, and AssemblyAI's
 * realtime API wants a socket fed raw frames. Getting partials out of this
 * provider needs a native audio module — the same shape of gap as Live
 * Activities — so the honest version of this feature today is: accuracy in
 * exchange for the words appearing at the end rather than as you go.
 *
 * That is a real trade and it is why the device recogniser stays the default.
 *
 * ## The audio leaves the phone
 *
 * Same as Whisper, and gated the same way: `STT_PROVIDER` is named on the
 * consent screen, `mayReachProvider` guards the path, and the recording is
 * deleted the moment the upload returns.
 */
import { File, UploadType } from 'expo-file-system';

import { createLogger } from '@/core/logger';
import { AppError, err, fail, ok, type Result } from '@/core/result';
import { isAbort, recordThenTranscribe, type RecordOptions } from './record';

const log = createLogger('assemblyai');

const UPLOAD_URL = 'https://api.assemblyai.com/v2/upload';
const TRANSCRIPT_URL = 'https://api.assemblyai.com/v2/transcript';

/**
 * `universal` is the general model — the one AssemblyAI's published English
 * benchmarks are measured on (5.6% mean WER, 4.7% on noisy sets).
 */
const SPEECH_MODEL = 'universal';

/** How long to wait for a transcript before giving up, and how often to ask. */
const POLL_INTERVAL_MS = 600;
const POLL_TIMEOUT_MS = 90_000;

export type AssemblyTranscript = {
  transcript: string;
  /**
   * AssemblyAI reports a real 0..1 confidence, which the platform recognisers
   * mostly do not. It feeds the same review gate every other transcript does —
   * see `wasPoorlyHeard` in `src/llm/confirm.ts`.
   */
  confidence: number | null;
};

export function isConfigured(apiKey: string | null | undefined): apiKey is string {
  return typeof apiKey === 'string' && apiKey.trim().length > 0;
}

export type TranscribeOptions = RecordOptions & {
  apiKey: string;
  /** BCP-47; only the language part is sent. Undefined lets the service detect. */
  language?: string;
};

/** Records one utterance and transcribes it. The file is always deleted. */
export async function recordAndTranscribe(
  options: TranscribeOptions,
): Promise<Result<AssemblyTranscript>> {
  if (!isConfigured(options.apiKey)) {
    return fail('invalid_input', 'No transcription key is configured.');
  }
  return recordThenTranscribe(options, (uri) =>
    transcribeFile({
      apiKey: options.apiKey,
      uri,
      ...(options.language !== undefined ? { language: options.language } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    }),
  );
}

/**
 * Uploads an existing file and waits for the transcript.
 *
 * Three round trips, which is the shape of this API: the audio is uploaded to
 * a URL, a transcript job is created against that URL, and the job is polled.
 * Split out so a caller that already has a recording can use it.
 */
export async function transcribeFile(options: {
  apiKey: string;
  uri: string;
  language?: string;
  signal?: AbortSignal;
}): Promise<Result<AssemblyTranscript>> {
  const file = new File(options.uri);
  if (!file.exists) return fail('not_found', 'The recording is missing.');

  const uploaded = await upload(file, options.apiKey, options.signal);
  if (!uploaded.ok) return uploaded;

  const created = await createJob(uploaded.value, options);
  if (!created.ok) return created;

  return pollJob(created.value, options.apiKey, options.signal);
}

/* ------------------------------------------------------------- internals -- */

async function upload(file: File, apiKey: string, signal?: AbortSignal): Promise<Result<string>> {
  try {
    const response = await file.upload(UPLOAD_URL, {
      httpMethod: 'POST',
      // Binary, not multipart: this endpoint takes the raw bytes as the body
      // and answers with the URL to hand to the transcript job.
      uploadType: UploadType.BINARY_CONTENT,
      headers: { authorization: apiKey },
      ...(signal ? { signal } : {}),
    });
    if (response.status < 200 || response.status >= 300) {
      return err(httpError(response.status, response.body));
    }
    const url = readString(response.body, 'upload_url');
    if (!url) return err(unreadable(response.body));
    return ok(url);
  } catch (error) {
    if (isAbort(error)) return fail('invalid_input', 'Transcription was cancelled.');
    return err(offline(error));
  }
}

async function createJob(
  audioUrl: string,
  options: { apiKey: string; language?: string; signal?: AbortSignal },
): Promise<Result<string>> {
  const body: Record<string, unknown> = { audio_url: audioUrl, speech_model: SPEECH_MODEL };
  if (options.language) body.language_code = options.language.split('-')[0] ?? options.language;

  try {
    const response = await fetch(TRANSCRIPT_URL, {
      method: 'POST',
      headers: { authorization: options.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const text = await response.text();
    if (!response.ok) return err(httpError(response.status, text));
    const id = readString(text, 'id');
    if (!id) return err(unreadable(text));
    return ok(id);
  } catch (error) {
    if (isAbort(error)) return fail('invalid_input', 'Transcription was cancelled.');
    return err(offline(error));
  }
}

async function pollJob(
  id: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Result<AssemblyTranscript>> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (signal?.aborted) return fail('invalid_input', 'Transcription was cancelled.');

    let text: string;
    try {
      const response = await fetch(`${TRANSCRIPT_URL}/${id}`, {
        headers: { authorization: apiKey },
        ...(signal ? { signal } : {}),
      });
      text = await response.text();
      if (!response.ok) return err(httpError(response.status, text));
    } catch (error) {
      if (isAbort(error)) return fail('invalid_input', 'Transcription was cancelled.');
      return err(offline(error));
    }

    const status = readString(text, 'status');
    if (status === 'completed') {
      const transcript = (readString(text, 'text') ?? '').trim();
      // A completed job with nothing in it is silence, not a failure — the same
      // answer the recogniser gives for a recording of a quiet room, and the
      // caller's `evaluateTranscript` is what turns that into "I didn't catch
      // that" rather than an error nobody can act on.
      return ok({ transcript, confidence: readNumber(text, 'confidence') });
    }
    if (status === 'error') {
      return err(
        new AppError('upstream', 'That recording could not be transcribed.', {
          details: readString(text, 'error') ?? undefined,
        }),
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }

  log.warn('transcript did not finish in time', { id });
  return err(
    new AppError('upstream', 'Transcription took too long.', { retryable: true }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mirrors `whisper.ts`, which mirrors the Gemini client: the user's, ours, or theirs. */
function httpError(status: number, body: string): AppError {
  const details = body.slice(0, 500);
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

function offline(cause: unknown): AppError {
  return new AppError('offline', 'Could not reach the transcription service.', {
    cause,
    retryable: true,
  });
}

function unreadable(body: string): AppError {
  return new AppError('upstream', 'The transcription service sent something unreadable.', {
    details: body.slice(0, 500),
  });
}

function readString(body: string, key: string): string | null {
  const value = readField(body, key);
  return typeof value === 'string' ? value : null;
}

function readNumber(body: string, key: string): number | null {
  const value = readField(body, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readField(body: string, key: string): unknown {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') return undefined;
    return (parsed as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}
