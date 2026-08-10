/**
 * Pure voice logic: end-of-utterance detection, transcript hygiene, and the
 * sentence chunker the TTS layer needs.
 *
 * Nothing in this file touches a native module, a timer or a clock — every
 * decision is driven by timestamps the caller passes in. That keeps the parts
 * most likely to be wrong (silence timing, confidence gating, text cleanup)
 * testable under plain Node, and leaves `stt.ts` / `tts.ts` as thin adapters.
 */
import {
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_MIN_SPEECH_MS,
  DEFAULT_TRAILING_SILENCE_MS,
  DEFAULT_TTS_CHUNK_CHARS,
  type TranscriptEvaluation,
} from './types';

/* --------------------------------------------------------- silence detector */

export type SilenceDetectorOptions = {
  /** Silence after speech that ends the utterance. */
  trailingSilenceMs?: number;
  /** Speech below this is a cough or a door slam, not an utterance. */
  minSpeechMs?: number;
  onTimeout?: () => void;
};

export type SilenceStats = {
  speechMs: number;
  silenceMs: number;
  fired: boolean;
};

/**
 * Tracks speech/silence runs and fires once when the user has clearly stopped
 * talking.
 *
 * Silence is implicit: any time that passes after the last `noteSpeech` counts,
 * because several Android engines never emit a `speechend` event. `noteSilence`
 * only makes that boundary exact when the engine does report it.
 */
export function createSilenceDetector(options: SilenceDetectorOptions = {}) {
  const trailingSilenceMs = options.trailingSilenceMs ?? DEFAULT_TRAILING_SILENCE_MS;
  const minSpeechMs = options.minSpeechMs ?? DEFAULT_MIN_SPEECH_MS;
  let onTimeout = options.onTimeout;

  let closedSpeechMs = 0;
  let runStart: number | null = null;
  let lastSpeechAt: number | null = null;
  let silenceSince: number | null = null;
  let fired = false;
  let disposed = false;

  function closeRun(): void {
    if (runStart === null) return;
    closedSpeechMs += Math.max(0, (lastSpeechAt ?? runStart) - runStart);
    runStart = null;
  }

  function speechMs(): number {
    if (runStart === null) return closedSpeechMs;
    return closedSpeechMs + Math.max(0, (lastSpeechAt ?? runStart) - runStart);
  }

  /** When the current silence began, or null if nothing has happened yet. */
  function anchor(): number | null {
    return silenceSince ?? lastSpeechAt;
  }

  return {
    noteSpeech(at: number): void {
      if (disposed || fired) return;
      silenceSince = null;
      // Two observations closer together than the end-of-utterance threshold
      // belong to the same run — by definition the utterance did not end
      // between them, so the time in between is speech. A longer gap is real
      // silence and must not be counted, so the run is closed first.
      if (runStart !== null && lastSpeechAt !== null && at - lastSpeechAt >= trailingSilenceMs) {
        closeRun();
      }
      if (runStart === null) runStart = at;
      lastSpeechAt = lastSpeechAt === null ? at : Math.max(lastSpeechAt, at);
    },

    noteSilence(at: number): void {
      if (disposed || fired) return;
      closeRun();
      // Engines repeat `speechend`; a second one must not push the deadline out.
      if (silenceSince === null) silenceSince = at;
    },

    /** Returns true on the tick that ends the utterance. */
    tick(at: number): boolean {
      if (disposed || fired) return false;
      const since = anchor();
      if (since === null) return false;
      // The run is *not* closed here: a tick only observes time passing, and
      // closing would restart the run at the next `noteSpeech`, so an open run
      // interleaved with ticks (which is what `stt.ts` does) would never
      // accumulate any speech. `speechMs()` already measures an open run
      // correctly — it never counts past the last speech we actually saw.
      if (at - since < trailingSilenceMs) return false;
      if (speechMs() < minSpeechMs) return false;
      fired = true;
      onTimeout?.();
      return true;
    },

    stats(at: number): SilenceStats {
      const since = anchor();
      return {
        speechMs: speechMs(),
        silenceMs: since === null ? 0 : Math.max(0, at - since),
        fired,
      };
    },

    hasFired(): boolean {
      return fired;
    },

    reset(): void {
      closedSpeechMs = 0;
      runStart = null;
      lastSpeechAt = null;
      silenceSince = null;
      fired = false;
    },

    dispose(): void {
      disposed = true;
      onTimeout = undefined;
    },
  };
}

export type SilenceDetector = ReturnType<typeof createSilenceDetector>;

/* ------------------------------------------------------ transcript grading - */

export type EvaluateTranscriptInput = {
  transcript: string;
  confidence?: number | null;
  minConfidence?: number;
};

/** Below this many letters/digits there is nothing for the model to act on. */
const MIN_SUBSTANTIVE_CHARS = 2;

/**
 * Decides whether a final transcript is worth sending to the model.
 *
 * Confidence is only trusted when it is actually reported: Android engines
 * routinely return 0 or -1 ("unavailable"), and iOS returns 0 on partials.
 * Comparing those against a threshold would reject every utterance on those
 * devices, so an unknown confidence is accepted whenever the text looks real.
 */
export function evaluateTranscript(input: EvaluateTranscriptInput): TranscriptEvaluation {
  const text = collapseWhitespace(input.transcript ?? '');
  if (text.length === 0) return { accept: false, reason: 'empty' };
  if (countWordChars(text) < MIN_SUBSTANTIVE_CHARS) return { accept: false, reason: 'too_short' };

  const { confidence } = input;
  const known = typeof confidence === 'number' && Number.isFinite(confidence) && confidence > 0;
  if (known && confidence < (input.minConfidence ?? DEFAULT_MIN_CONFIDENCE)) {
    return { accept: false, reason: 'low_confidence' };
  }
  return { accept: true, reason: 'ok' };
}

/* -------------------------------------------------------- transcript clean - */

/**
 * Openers people say before the actual command. Deliberately short: stripping
 * "well" or "right" would mangle real content ("well done", "right shoulder").
 */
const FILLER_OPENERS = new Set(['um', 'umm', 'uh', 'uhh', 'er', 'erm', 'hmm', 'so', 'okay', 'ok']);

/** "3 p.m." — a trailing dot that belongs to an abbreviation must survive. */
const ABBREVIATION_TAIL = /(?:^|\s)(?:\p{L}\.){2,}$/u;

/**
 * Turns raw recogniser output into the text we send to the model: whitespace
 * collapsed, dictation artefacts normalised, the trailing full stop the engine
 * adds removed, and leading filler words dropped.
 */
export function cleanTranscript(text: string): string {
  if (!text) return '';

  let out = text
    .replace(/[‘’ʼ]/gu, "'")
    .replace(/[“”]/gu, '"')
    .replace(/…/gu, '...');

  out = collapseWhitespace(out);
  if (!out) return '';

  out = out
    .replace(/\s+([,;:.!?])/gu, '$1')
    .replace(/([,;:!?])\1+/gu, '$1')
    .replace(/^[\s,;:.!?-]+/u, '');

  out = stripFillerOpeners(out);
  out = stripTrailingPeriod(out);
  return out.trim();
}

function stripFillerOpeners(text: string): string {
  let out = text;
  for (;;) {
    // The lookahead guarantees content survives: an utterance that is nothing
    // but filler ("ok") is left alone so a one-word confirmation still works.
    const match = /^(\p{L}+)[\s,]+(?=\S)/u.exec(out);
    if (!match || !FILLER_OPENERS.has(match[1]!.toLowerCase())) return out;
    out = out.slice(match[0].length);
  }
}

function stripTrailingPeriod(text: string): string {
  if (ABBREVIATION_TAIL.test(text)) return text;
  return text.replace(/[\s.]+$/u, '');
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function countWordChars(text: string): number {
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

/* ------------------------------------------------------------- tts chunking */

/**
 * Splits text into chunks under `maxChars`, preferring sentence boundaries,
 * then clause boundaries, then words. Android's TTS engine silently truncates
 * long utterances, so a briefing has to arrive in pieces.
 *
 * Joining the result with a single space reproduces the whitespace-collapsed
 * input, so nothing is ever dropped.
 */
export function chunkForSpeech(text: string, maxChars = DEFAULT_TTS_CHUNK_CHARS): string[] {
  const clean = collapseWhitespace(text);
  if (!clean) return [];
  const limit = Math.max(1, Math.floor(maxChars));
  if (clean.length <= limit) return [clean];

  const chunks: string[] = [];
  let current = '';
  for (const sentence of splitSentences(clean)) {
    for (const piece of fitPieces(sentence, limit)) {
      if (!current) {
        current = piece;
      } else if (current.length + 1 + piece.length <= limit) {
        current = `${current} ${piece}`;
      } else {
        chunks.push(current);
        current = piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitSentences(text: string): string[] {
  // The leading run is `*`, not `+`: a terminator that no sentence precedes
  // (a stray "..." or a "!" after a space) would otherwise match neither
  // alternative and be dropped from the output entirely.
  const matches = text.match(/[^.!?]*[.!?]+["')\]]*\s*|[^.!?]+$/gu);
  if (!matches) return [text];
  return matches.map((s) => s.trim()).filter((s) => s.length > 0);
}

function splitClauses(text: string): string[] {
  // Same shape as `splitSentences`: the leading run must be allowed to be
  // empty so a clause mark with no clause in front of it is not swallowed.
  const matches = text.match(/[^,;:]*[,;:]+\s*|[^,;:]+$/gu);
  if (!matches) return [text];
  return matches.map((s) => s.trim()).filter((s) => s.length > 0);
}

function fitPieces(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  for (const clause of splitClauses(text)) {
    if (clause.length <= limit) out.push(clause);
    else out.push(...splitWords(clause, limit));
  }
  return out;
}

function splitWords(text: string, limit: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    if (word.length > limit) {
      if (current) {
        out.push(current);
        current = '';
      }
      for (let i = 0; i < word.length; i += limit) out.push(word.slice(i, i + limit));
      continue;
    }
    if (!current) current = word;
    else if (current.length + 1 + word.length <= limit) current = `${current} ${word}`;
    else {
      out.push(current);
      current = word;
    }
  }
  if (current) out.push(current);
  return out;
}
