/**
 * Speech output.
 *
 * Three things the raw `expo-speech` API does not give us:
 *  - a queue, so a briefing and a confirmation cannot talk over each other;
 *  - audio focus, so music ducks while Ridik speaks and comes back afterwards;
 *  - chunking, because Android's TTS engine truncates long utterances.
 *
 * Every native call is guarded: speech is a nicety, and a failure here must
 * never take the app down.
 */
import * as Speech from 'expo-speech';
import { setAudioModeAsync, type AudioMode } from 'expo-audio';
import { createLogger } from '@/core/logger';
import { toAppError, type AppError } from '@/core/result';
import { chunkForSpeech } from './vad';

// Re-exported so callers reach the chunker through the speech API they already
// import; the implementation lives in `vad.ts` to keep it native-free (and
// therefore testable).
export { chunkForSpeech };

const log = createLogger('tts');

/** Ceiling for waiting on a chunk that never reports `onDone`. */
const MIN_CHUNK_TIMEOUT_MS = 4_000;
const MS_PER_CHARACTER = 120;

export type SpeakOptions = {
  rate?: number;
  pitch?: number;
  language?: string;
  onDone?: () => void;
  onError?: (error: AppError) => void;
};

type QueueItem = {
  chunks: string[];
  options: SpeakOptions;
  generation: number;
  resolve: () => void;
};

const queue: QueueItem[] = [];
let draining = false;
let ducked = false;
/** Bumped by `stop()` so in-flight items abandon their remaining chunks. */
let generation = 0;

/**
 * Queues `text` and resolves when it has finished (or been stopped). Long text
 * is split at sentence boundaries first.
 */
export function speak(text: string, options: SpeakOptions = {}): Promise<void> {
  const chunks = chunkForSpeech(text);
  if (chunks.length === 0) {
    options.onDone?.();
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    queue.push({ chunks, options, generation, resolve });
    void drain();
  });
}

/** Drops everything queued and silences the current utterance. */
export async function stop(): Promise<void> {
  generation++;
  for (const item of queue.splice(0)) item.resolve();
  try {
    await Speech.stop();
  } catch (error) {
    log.warn('could not stop speech', error);
  }
  await releaseAudioFocus();
}

export async function isSpeaking(): Promise<boolean> {
  try {
    return await Speech.isSpeakingAsync();
  } catch (error) {
    log.warn('could not read the speaking state', error);
    return draining || queue.length > 0;
  }
}

/* ------------------------------------------------------------- internals -- */

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    await takeAudioFocus();
    for (let item = queue.shift(); item; item = queue.shift()) {
      try {
        for (const chunk of item.chunks) {
          if (item.generation !== generation) break;
          await speakChunk(chunk, item.options);
        }
        item.options.onDone?.();
      } catch (error) {
        const appError = toAppError(error, 'Could not speak that.');
        log.warn('speech failed', appError);
        item.options.onError?.(appError);
      } finally {
        item.resolve();
      }
    }
  } finally {
    await releaseAudioFocus();
    draining = false;
    // Anything queued while we were releasing focus would otherwise be stranded.
    if (queue.length > 0) void drain();
  }
}

function speakChunk(chunk: string, options: SpeakOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const failed = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    // Some Android engines never call back. Rather than wedge the queue for
    // good, give up on the chunk after a generous, length-based deadline.
    const timer = setTimeout(() => {
      log.warn('speech callback never arrived; moving on');
      done();
    }, Math.max(MIN_CHUNK_TIMEOUT_MS, chunk.length * MS_PER_CHARACTER));

    try {
      Speech.speak(chunk, {
        language: options.language,
        rate: options.rate,
        pitch: options.pitch,
        onDone: done,
        onStopped: done,
        onError: failed,
      });
    } catch (error) {
      failed(error);
    }
  });
}

async function takeAudioFocus(): Promise<void> {
  if (ducked) return;
  ducked = true;
  await applyAudioMode({
    playsInSilentMode: true,
    interruptionMode: 'duckOthers',
    allowsRecording: false,
  });
}

async function releaseAudioFocus(): Promise<void> {
  if (!ducked) return;
  ducked = false;
  await applyAudioMode({ playsInSilentMode: true, interruptionMode: 'mixWithOthers' });
}

async function applyAudioMode(mode: Partial<AudioMode>): Promise<void> {
  try {
    await setAudioModeAsync(mode);
  } catch (error) {
    log.warn('could not change the audio mode', error);
  }
}
