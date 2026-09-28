/**
 * Whisper, on the phone, with nothing leaving it.
 *
 * The third answer to the same question the other engines answer badly. The
 * platform recogniser is fast, free and wrong more often than anyone would
 * like. AssemblyAI is accurate and *uploads the recording*, which costs money,
 * needs a signal, and puts a third party on the consent screen. This is
 * whisper.cpp through `whisper.rn`, reading the same WAV the recogniser kept:
 * accurate, free per utterance, and — the part that matters — **it adds no
 * recipient at all**, because nothing is sent anywhere.
 *
 * It is therefore the only upgrade engine that can run when consent is
 * declined, on a plane, or on a phone that has never had a network.
 *
 * ## On an iPhone it rescues exactly the phones that need it
 *
 * iOS has two recognisers behind one door. `SpeechAnalyzer` (iOS 26, with its
 * model downloaded) measures 2.12% word error rate — *better than this model* —
 * and it runs through `./apple`, which keeps no audio at all. So on those
 * phones there is nothing to upgrade, the `audioUri` is null, and this engine
 * correctly never runs. That is the right answer rather than a gap: upgrading
 * a better engine with a worse one would make the transcript worse.
 *
 * Every other iPhone falls back to `SFSpeechRecognizer` at 9.02% — and those
 * are the ones this fixes. The setting means the same thing on both platforms
 * ("correct what the recogniser heard, on the phone"); it simply has nothing to
 * correct when the recogniser was already the good one.
 *
 * ## What it costs, stated plainly
 *
 * A model file, and time. The model is tens of megabytes and has to arrive
 * before this can answer, and transcription is not instant — it is seconds of
 * CPU on an utterance the recogniser already transcribed in real time. Both of
 * those are why this sits *behind* the caption rather than in front of it: the
 * user has already read their words and the turn is already moving, so what
 * this changes is only what gets filed.
 *
 * ## The model is fetched, never waited for
 *
 * Exactly the shape `./apple` uses for `SpeechAnalyzer`'s assets, for exactly
 * the same reason. A phone that does not have the model yet keeps the
 * recogniser's own transcript for *that* utterance and fetches in the
 * background; the turn after it lands is the better one and nobody stared at a
 * progress bar. `status()` is the whole contract: only `installed` can answer.
 *
 * And the download is a **model coming down, not a recording going up** —
 * nothing the user has said is part of the request — so it is the same
 * documented exception `modules/ridik-speech` already relies on and adds no
 * sentence to `ConsentScreen`. If a future version ever sent audio to fetch
 * something, that exception would stop covering it.
 *
 * ## One context, held open
 *
 * `initWhisper` maps a model into memory and is far too expensive to do per
 * utterance. The context is created on first use and kept; `release()` exists
 * for tests and for a deliberate teardown, and is not called per turn.
 */
import { Directory, File, Paths } from 'expo-file-system';

import { createLogger } from '@/core/logger';
import { err, fail, ok, toAppError, type Result } from '@/core/result';

const log = createLogger('whisper-local');

/**
 * Quantised `base.en`, and the size is the whole argument.
 *
 * `tiny.en` is half the download and noticeably worse on the thing this app is
 * for — proper nouns and numbers in a spoken sentence. Full `base.en` is 142MB
 * for an accuracy difference that does not survive a phone microphone. `q5_1`
 * is ~57MB, which is a download somebody will actually finish on mobile data.
 *
 * English-only on purpose: the multilingual models of this size spend a large
 * part of their capacity on languages this build does not ship, and get worse
 * at the one it does.
 */
export const WHISPER_MODEL_FILE = 'ggml-base.en-q5_1.bin';

const WHISPER_MODEL_URL =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin';

/** Where the model lives. Not the cache: a re-download is 57MB of somebody's data. */
const MODEL_DIRECTORY = 'whisper';

/**
 * Roughly what the file should weigh, used only to reject a truncated one.
 *
 * A download that dies halfway leaves a plausible file that `initWhisper` then
 * fails on in native code, with an error nobody can act on. Deliberately loose:
 * the point is to catch a few hundred kilobytes of HTML error page or a
 * half-finished transfer, not to pin a byte count that a re-publish would break.
 */
const MIN_MODEL_BYTES = 20_000_000;

export type WhisperModelStatus = 'absent' | 'downloading' | 'installed';

export type WhisperTranscript = {
  transcript: string;
  /**
   * Always `null`. whisper.cpp reports no per-utterance confidence, and
   * inventing one from segment timings would be a number that looks measured
   * and is not — which is worse than the honest absence `wasPoorlyHeard`
   * already knows how to read.
   */
  confidence: null;
};

/* --------------------------------------------------------------- the model */

function modelFile(): File {
  return new File(new Directory(Paths.document, MODEL_DIRECTORY), WHISPER_MODEL_FILE);
}

/**
 * Whether the model is here, being fetched, or absent.
 *
 * Never cached. A remembered "absent" would need the app restarted before it
 * could use a model it had just finished downloading — the same reasoning that
 * keeps `./apple`'s two non-terminal statuses uncached.
 */
export function status(): WhisperModelStatus {
  if (downloading !== null) return 'downloading';
  try {
    const file = modelFile();
    if (file.exists && (file.size ?? 0) >= MIN_MODEL_BYTES) return 'installed';
  } catch (error) {
    log.warn('could not read the model file', { error });
  }
  return 'absent';
}

let downloading: Promise<void> | null = null;

/**
 * Starts fetching the model if it is not here, and **returns immediately**.
 *
 * Deliberately not awaited by any caller on the speech path. A first utterance
 * that blocked for a 57MB download would be a microphone that appears broken,
 * and the whole design is that the recogniser answers now and this engine
 * answers from the next turn onwards.
 */
export function ensureModel(): void {
  if (downloading !== null || status() === 'installed') return;
  downloading = download()
    .catch((error: unknown) => {
      log.warn('model download failed; the recogniser keeps answering', { error });
    })
    .finally(() => {
      downloading = null;
    });
}

/**
 * Fetches the model if needed **and opens the context**, both in the
 * background, so the first utterance does not pay for either.
 *
 * The second half is not tidiness. Opening a context reads a 59MB file for the
 * first time and initialises the runtime, and measured on a cold process that
 * is **14.3 seconds against 1.6 for every run after it**. Left to happen
 * lazily, the first sentence somebody speaks after choosing this engine sits in
 * `sending` for a quarter of a minute — which is exactly the impression of a
 * broken microphone that the whole "recogniser answers first" design exists to
 * avoid.
 *
 * Fire and forget, like everything else on this path: nothing awaits it, and a
 * failure leaves the recogniser answering alone.
 */
export function prepare(): void {
  ensureModel();
  if (status() !== 'installed') return;
  void open();
}

async function download(): Promise<void> {
  const directory = new Directory(Paths.document, MODEL_DIRECTORY);
  if (!directory.exists) directory.create({ intermediates: true });

  log.info('fetching the speech model', { file: WHISPER_MODEL_FILE });
  const target = await File.downloadFileAsync(WHISPER_MODEL_URL, directory);

  // A truncated download is the failure mode that otherwise surfaces as an
  // unreadable native error on first use, so it is rejected here instead.
  if ((target.size ?? 0) < MIN_MODEL_BYTES) {
    target.delete();
    throw new Error(`the model arrived truncated (${target.size ?? 0} bytes)`);
  }
  log.info('speech model installed', { bytes: target.size });
}

/* ------------------------------------------------------------- the context */

type Context = {
  transcribe: (
    path: string,
    options?: Record<string, unknown>,
  ) => { stop: () => Promise<void>; promise: Promise<{ result: string; isAborted: boolean }> };
  release: () => Promise<void>;
};

let context: Context | null = null;
let opening: Promise<Context | null> | null = null;

/**
 * The native module, resolved lazily and never at import time.
 *
 * `whisper.rn` is a native module: requiring it from module scope makes this
 * file unloadable anywhere the native side is absent, which is every test in
 * the `logic` project and every build that has not been prebuilt since it was
 * added. Import failure is a normal answer here, not a crash.
 */
async function loadModule(): Promise<{
  initWhisper: (options: { filePath: string }) => Promise<Context>;
} | null> {
  try {
    // `whisper.rn/index`, not `whisper.rn`. The package's `exports` map has a
    // `./*` pattern and no `.` entry, so the bare specifier resolves through
    // neither `moduleResolution: bundler` nor Metro's package-exports support.
    // The subpath is covered and points at the same module.
    return (await import('whisper.rn/index')) as never;
  } catch (error) {
    log.warn('whisper.rn is not available in this build', { error });
    return null;
  }
}

async function open(): Promise<Context | null> {
  if (context !== null) return context;
  if (opening !== null) return opening;

  opening = (async () => {
    const module = await loadModule();
    if (module === null) return null;
    try {
      const file = modelFile();
      // `initWhisper` maps the model into memory; doing it per utterance would
      // cost more than the transcription it is for.
      context = await module.initWhisper({ filePath: file.uri });
      // `gpu` is worth a line in the log for the same reason `source` is on a
      // transcript: it is the difference between a fast engine and a slow one,
      // and nothing else says which you got. The simulator reports
      // "Metal is not supported in simulator" and runs on the CPU.
      log.info('whisper context opened', {
        gpu: (context as unknown as { gpu?: boolean }).gpu,
        reasonNoGPU: (context as unknown as { reasonNoGPU?: string }).reasonNoGPU,
      });
      return context;
    } catch (error) {
      log.warn('could not open a whisper context', { error });
      return null;
    } finally {
      opening = null;
    }
  })();

  return opening;
}

/** Drops the context and the model mapping. For tests and teardown, not per turn. */
export async function release(): Promise<void> {
  const current = context;
  context = null;
  if (current === null) return;
  try {
    await current.release();
  } catch (error) {
    log.warn('could not release the whisper context', { error });
  }
}

/* ---------------------------------------------------------------- the work */

/**
 * Transcribes a WAV the recogniser kept.
 *
 * The format is already right and that is not a coincidence: the recognition
 * library writes 16 kHz mono 16-bit PCM because that is what it feeds the
 * recognition service, and it is exactly what whisper.cpp wants. No
 * conversion, no resample, no second recording.
 *
 * Every failure is a `Result`. The caller's rule is that an upgrade may
 * improve a turn and must never cost one, so "the model is not here yet" and
 * "the context would not open" are ordinary answers rather than errors worth
 * showing anybody.
 */
export async function transcribeFile(uri: string): Promise<Result<WhisperTranscript>> {
  if (status() !== 'installed') {
    // Asked for while absent is the signal that somebody has chosen this
    // engine, which is the only moment worth spending 57MB of their data on.
    ensureModel();
    return fail('unsupported', 'The offline speech model is still downloading.');
  }

  const ready = await open();
  if (ready === null) return fail('unsupported', 'Offline transcription is not available.');

  try {
    const { promise } = ready.transcribe(uri, {
      // English-only model, so saying so skips the detection pass entirely.
      language: 'en',
      // A transcript, not a translation: the model will happily translate into
      // English if asked, and an utterance silently translated is a sentence
      // the user never said.
      translate: false,
    });
    const outcome = await promise;
    if (outcome.isAborted) return fail('unknown', 'Transcription was interrupted.');
    return ok({ transcript: outcome.result.trim(), confidence: null });
  } catch (error) {
    return err(toAppError(error, 'Could not transcribe that offline.'));
  }
}
