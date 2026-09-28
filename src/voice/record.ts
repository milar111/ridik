/**
 * Recording one utterance to a file, for the engines that transcribe by upload.
 *
 * Extracted from `whisper.ts` when a second such engine arrived. It is not
 * shared to save lines — it is shared because the fiddly half of this is not
 * the recording, it is everything around it: taking the audio session and
 * giving it back, deleting the file whether the upload succeeded or threw, and
 * releasing a recorder that may have failed to start. A second copy of that is
 * a second place for a temporary file holding somebody's voice to survive.
 *
 * The transcriber is passed in rather than returned to, so the `finally` that
 * cleans up cannot be skipped by a caller who forgot.
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
import { Directory, File, Paths } from 'expo-file-system';

import { createLogger } from '@/core/logger';
import { err, fail, ok, toAppError, type Result } from '@/core/result';

const log = createLogger('voice-record');

export const DEFAULT_MAX_SECONDS = 60;
export const MAX_SECONDS_CEILING = 300;

/** Mono 16 kHz AAC: what every one of these services wants, at a fraction of the upload. */
export const RECORDING_OPTIONS: RecordingOptions = {
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

export type RecordOptions = {
  maxSeconds?: number;
  /** Cancels the whole operation; nothing is transcribed. */
  signal?: AbortSignal;
  /** Ends the recording early and transcribes what was captured. */
  stopSignal?: AbortSignal;
};

/**
 * Records up to `maxSeconds` and hands the file to `transcribe`.
 *
 * The temporary file is always removed, including when the upload throws.
 */
export async function recordThenTranscribe<T>(
  options: RecordOptions,
  transcribe: (uri: string) => Promise<Result<T>>,
): Promise<Result<T>> {
  if (options.signal?.aborted) return fail('invalid_input', 'Recording was cancelled.');

  const permitted = await requestRecordingPermission();
  if (!permitted.ok) return permitted;

  const maxSeconds = Math.min(
    Math.max(1, options.maxSeconds ?? DEFAULT_MAX_SECONDS),
    MAX_SECONDS_CEILING,
  );
  let recorder: InstanceType<typeof AudioModule.AudioRecorder> | null = null;
  let uri: string | null = null;

  try {
    await applyAudioMode({
      allowsRecording: true,
      playsInSilentMode: true,
      interruptionMode: 'doNotMix',
    });
    /*
     * `import/namespace` cannot see through `expo-audio`'s native module shape
     * and reports `AudioRecorder` as missing. It is there:
     * `AudioModule.types.d.ts` declares `readonly AudioRecorder: typeof
     * AudioRecorder` on the module object and TypeScript resolves it. A false
     * positive on a correct call, disabled at the one site rather than by
     * weakening the rule.
     */
    // eslint-disable-next-line import/namespace
    recorder = new AudioModule.AudioRecorder({});
    await recorder.prepareToRecordAsync(RECORDING_OPTIONS);
    recorder.record();

    const cancelled = await waitForRecording(maxSeconds, options.signal, options.stopSignal);
    await recorder.stop();
    uri = recorder.uri;

    if (cancelled) return fail('invalid_input', 'Recording was cancelled.');
    if (!uri) return fail('unknown', 'The recording produced no audio.');
    return await transcribe(uri);
  } catch (error) {
    return err(toAppError(error, 'Could not record audio.'));
  } finally {
    const path = uri ?? safeUri(recorder);
    deleteQuietly(path);
    releaseQuietly(recorder);
    await applyAudioMode({ allowsRecording: false, interruptionMode: 'mixWithOthers' });
  }
}

export async function requestRecordingPermission(): Promise<Result<void>> {
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

export function isAbort(error: unknown): boolean {
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

/**
 * Files the recognition library writes when it is asked to keep the audio.
 *
 * Its own naming, and **the two platforms do not use the same one**: Android
 * writes `recording_<epoch ms>.wav`, iOS writes `recording_<UUID>.wav`. A
 * pattern matching only digits is therefore correct on one platform and matches
 * nothing at all on the other — which is a silent leak, because a sweep that
 * finds no files looks exactly like a sweep with nothing to do.
 *
 * Still anchored and still scoped to this prefix and these extensions: the
 * point is to collect what this app asked to be written, never to tidy a cache
 * directory it shares with everything else.
 */
const KEPT_RECORDING = /^recording_[0-9A-Za-z-]+\.(wav|caf)$/;

/**
 * Deletes recordings left behind by a session that died before it could name
 * one, and it exists because of a race that only shows on a device.
 *
 * The uri reaches JS on `audiostart`. A session that fails earlier than that —
 * and the common one really is early, an on-device engine reporting
 * `language-not-supported` for the locale, which is then silently retried over
 * the network — has already had its file created natively and never tells
 * anybody what it was called. `onDiscardAudio` cannot cover it: there is
 * nothing to discard yet.
 *
 * So this runs on the way *in*, where nothing of ours is in flight and every
 * `recording_*.wav` in that directory is therefore rubbish from a previous
 * turn. Running it at the end instead would race the session that is still
 * writing one.
 *
 * Scoped hard on purpose: the app's own cache directory, non-recursive, and
 * only names the library itself generates. A sweep that took its idea of "old
 * enough" from a timestamp, or that matched more loosely, is how a cleanup
 * deletes something it did not create.
 */
export function sweepKeptRecordings(): void {
  try {
    for (const entry of new Directory(Paths.cache).list()) {
      if (entry instanceof File && KEPT_RECORDING.test(entry.name)) entry.delete();
    }
  } catch (error) {
    // Never fatal. A cache we could not read is a tidiness problem, and the
    // user is in the middle of trying to say something.
    log.warn('could not sweep leftover recordings', { error });
  }
}

export function deleteQuietly(uri: string | null): void {
  if (!uri) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch (error) {
    log.warn('could not delete the recording', { error });
  }
}

function releaseQuietly(recorder: InstanceType<typeof AudioModule.AudioRecorder> | null): void {
  if (!recorder) return;
  try {
    recorder.release();
  } catch (error) {
    log.warn('could not release the recorder', { error });
  }
}

async function applyAudioMode(mode: Partial<AudioMode>): Promise<void> {
  try {
    await setAudioModeAsync(mode);
  } catch (error) {
    log.warn('could not set the audio mode', { error });
  }
}
