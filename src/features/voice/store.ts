import { create } from 'zustand';
import { now } from '@/core/clock';
import type { LlmAction } from '@/llm/contract';
// Type-only, so nothing of the executor is loaded here: the dock renders the
// rows a search found and has to name their shape, not build one.
import type { ResultHit } from '@/llm/executor';

export type VoiceStatus = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

/**
 * Something the user said (or typed) that never got an answer.
 *
 * The audio is gone the instant it has been transcribed, so the transcript is
 * the only record that the sentence was ever spoken. A turn that fails, or a
 * sheet that goes away mid-dictation, used to take that record with it — which
 * is the single most-upvoted complaint in the competitor reviews we read:
 * "I will dictate for a long time and then it just won't transcribe and all of
 * it will go to waste."
 *
 * So it is moved here instead of being cleared, and only two things empty this
 * slot: the user taking it back (`recoverTranscript`) or throwing it away
 * (`discardRecovered`). A turn that succeeds clears it only when what went
 * through is the same sentence.
 */
export type RecoveredTranscript = {
  /** What was heard. Never empty — an empty one is not kept. */
  text: string;
  /** When it was set aside, epoch ms. */
  at: number;
  /** `failed` — the turn errored. `unsent` — it was never sent at all. */
  reason: 'failed' | 'unsent';
};

export type VoiceOutcomeItem = {
  toolName: LlmAction['tool_name'];
  ok: boolean;
  summary: string;
  detail?: string;
  /** Route to open when the user taps the result. */
  href?: string;
  /** The row the action touched; see `undoableAction` before acting on it. */
  entityId?: string;
  /**
   * The rows behind an answer whose answer *is* a list — `search`. A question
   * answered with "found 6 matches: 3 notes and 3 tasks" is a summary of the
   * answer rather than the answer, so the sheet renders these instead.
   */
  results?: ResultHit[];
};

export type VoiceOutcome = {
  transcript: string;
  /** False suppresses TTS for this turn without hiding the text. */
  speak?: boolean;
  /** An explanation shown above the results, e.g. a spend cap or trial being spent. */
  notice?: string;
  /**
   * The one thing that would fix what the notice describes — the paywall, for
   * a spent trial. A notice about money with no way to act on it is how a user
   * ends up believing the app broke.
   */
  noticeAction?: { label: string; href: string };
  feedback?: string;
  items: VoiceOutcomeItem[];
  clarification?: { question: string; pending?: string };
};

/**
 * The pipeline (STT -> LLM -> executor -> TTS) is registered at startup rather
 * than imported here, so the dock can render — and be tested — without pulling
 * in native speech modules.
 */
export type VoicePipeline = {
  listen: (handlers: {
    onPartial: (text: string) => void;
    onFinal: (text: string, confidence: number | null) => void;
    onError: (message: string, reason?: string) => void;
  }) => Promise<void>;
  stopListening: () => Promise<void>;
  process: (
    transcript: string,
    options?: { pending?: string },
  ) => Promise<VoiceOutcome>;
  speak: (text: string) => Promise<void>;
  stopSpeaking: () => Promise<void>;
};

let pipeline: VoicePipeline | null = null;

/**
 * Which listening session the store is currently willing to hear from.
 *
 * The recogniser keeps talking after it has been stopped — a cancel usually
 * arrives as an error a moment later — so a dismissed session would otherwise
 * reach back and set `status: 'error'` on a store that had already moved on,
 * leaving the mic sitting there red with a message nobody can read because the
 * sheet it belonged to is closed. Every callback checks its ticket first.
 */
let session = 0;

export function registerVoicePipeline(impl: VoicePipeline): void {
  pipeline = impl;
  // Announced as state as well as kept in the module, because "is the mic
  // usable yet" is now a question a *screen* asks. An intent arriving from a
  // widget, a shortcut or a Control Center button lands during the bootstrap it
  // triggered, and firing it into a null pipeline turns the one thing the app
  // is for into "Voice is still starting up." on a cold launch — the only
  // launch those entry points ever produce.
  useVoiceStore.setState({ pipelineReady: true });
}

export function getVoicePipeline(): VoicePipeline | null {
  return pipeline;
}

type VoiceState = {
  status: VoiceStatus;
  /**
   * Whether a pipeline has been registered yet — see `registerVoicePipeline`.
   *
   * Deliberately outside `reset()`: it is a fact about the process, not about
   * the turn, and a reset that cleared it would tell every waiting intent the
   * mic had gone away again.
   */
  pipelineReady: boolean;
  expanded: boolean;
  /**
   * Whether the sheet is showing its text box.
   *
   * Here rather than in `VoiceDock`'s own state because the two ways into
   * typing are not both inside it. On home the sheet only opens for something
   * that genuinely needs it — a question, an error, a notice, or typing — so
   * the mic's long-press, which only ever set `expanded`, opened a sheet whose
   * every branch was false and drew nothing at all. Typing is the state that
   * makes the sheet needed, so it has to be reachable from outside the sheet.
   */
  typing: boolean;
  partial: string;
  transcript: string;
  error: string | null;
  /** Set when the recogniser heard nothing usable, so the UI can offer typing. */
  needsRetry: boolean;
  /**
   * Set when this device has no recogniser at all — an iOS Simulator, an
   * Android without Google's speech services, dictation switched off. Speaking
   * will never work here, so the UI opens the text box instead of leaving the
   * user tapping a microphone that cannot succeed.
   */
  sttUnavailable: boolean;
  /**
   * Set when a listening session ended having produced no words at all — not a
   * final transcript and not even a partial. There is nothing to recover and
   * nothing to retry with, so this is the one failure the UI has to state
   * plainly rather than dress up as "I didn't quite catch that": the user has
   * just spoken a paragraph into a microphone that recorded none of it.
   */
  heardNothing: boolean;
  outcome: VoiceOutcome | null;
  pendingClarification: { question: string; pending?: string } | null;
  /** See `RecoveredTranscript`. Outlives `close()` and `reset()` by design. */
  recovered: RecoveredTranscript | null;
  /**
   * Text handed to the composer and waiting for the dock to pick it up.
   *
   * One-shot, and it exists because the offer to restore is drawn in two
   * places — the sheet and home — while the text box lives in only one of
   * them. `consumeDraftSeed()` is the dock taking it.
   */
  draftSeed: string | null;

  open: () => void;
  close: () => void;
  /** Opens the sheet with the text box up — the visible alternative to talking. */
  startTyping: () => void;
  setTyping: (typing: boolean) => void;
  startListening: () => Promise<void>;
  stopListening: () => Promise<void>;
  submitText: (text: string) => Promise<void>;
  /** Puts the kept transcript back in the composer. Returns it, for tests. */
  recoverTranscript: () => string | null;
  /** The explicit "no, throw it away" — the only other way this slot empties. */
  discardRecovered: () => void;
  /** Keeps an unsent draft when the sheet goes away with words still in it. */
  keepDraft: (text: string) => void;
  consumeDraftSeed: () => void;
  reset: () => void;
};

/**
 * What this turn is holding that nobody has answered yet.
 *
 * The final transcript if there is one, otherwise the last partial — a
 * recogniser that dies mid-sentence has still told us most of what was said,
 * and most of a long dictation is worth incomparably more than nothing.
 * Answered work is not kept: an outcome whose transcript is this one is the
 * definition of the sentence having landed.
 */
function unanswered(state: VoiceState): RecoveredTranscript | null {
  const text = (state.transcript || state.partial).trim();
  if (!text) return state.recovered;
  const answered = state.outcome?.transcript.trim() === text && state.error === null;
  if (answered) return state.recovered;
  return { text, at: now(), reason: state.error ? 'failed' : 'unsent' };
}

export const useVoiceStore = create<VoiceState>((set, get) => ({
  status: 'idle',
  pipelineReady: getVoicePipeline() != null,
  expanded: false,
  typing: false,
  partial: '',
  transcript: '',
  error: null,
  needsRetry: false,
  sttUnavailable: false,
  heardNothing: false,
  outcome: null,
  pendingClarification: null,
  recovered: null,
  draftSeed: null,

  open: () => set({ expanded: true }),
  close: () => {
    session += 1;
    void pipeline?.stopListening().catch(() => {});
    void pipeline?.stopSpeaking().catch(() => {});
    set({
      expanded: false,
      typing: false,
      status: 'idle',
      partial: '',
      error: null,
      needsRetry: false,
      sttUnavailable: false,
      heardNothing: false,
      // Closing the sheet is not an answer. Whatever was in it is set aside
      // rather than dropped — the whole point of `recovered`.
      recovered: unanswered(get()),
    });
  },

  startTyping: () => set({ expanded: true, typing: true }),
  setTyping: (typing: boolean) => set({ typing }),

  startListening: async () => {
    const impl = pipeline;
    if (!impl) {
      set({ status: 'error', error: 'Voice is still starting up.', expanded: true });
      return;
    }
    const ticket = ++session;
    set({
      status: 'listening',
      expanded: true,
      // Speaking replaces typing: the box and the microphone are two answers to
      // the same question, and a box left up over a live session is the one
      // that catches the keyboard.
      typing: false,
      partial: '',
      transcript: '',
      error: null,
      needsRetry: false,
      sttUnavailable: false,
      heardNothing: false,
      outcome: null,
      // Speaking again over a turn that failed must not be what loses it: the
      // new session clears `transcript`, so anything unanswered moves first.
      recovered: unanswered(get()),
    });
    try {
      await impl.listen({
        onPartial: (text) => {
          if (ticket !== session) return;
          set({ partial: text });
        },
        onFinal: (text) => {
          if (ticket !== session) return;
          set({ partial: '' });
          void get().submitText(text);
        },
        onError: (message, reason) => {
          if (ticket !== session) return;
          // The partials are the only thing left of a session that failed at
          // the end, and "the end" is where long dictations fail. Keeping them
          // turns a lost paragraph into an editable one.
          const heard = get().partial.trim();
          set({
            status: 'error',
            error: message,
            needsRetry: reason === 'low_confidence' || reason === 'empty',
            sttUnavailable: reason === 'unsupported',
            heardNothing: heard.length === 0 && reason === 'empty',
            ...(heard ? { recovered: { text: heard, at: now(), reason: 'failed' as const } } : {}),
          });
        },
      });
    } catch (error) {
      if (ticket !== session) return;
      set({
        status: 'error',
        error: error instanceof Error ? error.message : 'Could not start listening.',
      });
    }
  },

  stopListening: async () => {
    await pipeline?.stopListening().catch(() => {});
    if (get().status === 'listening') set({ status: 'idle' });
  },

  submitText: async (text: string) => {
    const impl = pipeline;
    const trimmed = text.trim();
    if (!trimmed) {
      set({ status: 'error', error: 'Nothing to send.', needsRetry: true });
      return;
    }
    // One turn at a time. Nothing above this stopped a second `process()`
    // starting while the first was still waiting on the model: the Send button
    // is enabled on a non-empty draft alone, so ten taps in a second ran ten
    // turns in parallel. Every one of them passed the budget check against the
    // same counters and every one of them billed, which turned "worst case the
    // trial overruns by one" into an unbounded overrun and let a spent trial be
    // walked past by firing the batch before the last increment landed. The
    // counters are atomic now too; this is the half that stops the calls being
    // made at all.
    if (get().status === 'thinking') return;
    if (!impl) {
      set({ status: 'error', error: 'Voice is still starting up.' });
      return;
    }
    const pending = get().pendingClarification?.pending;
    set({
      status: 'thinking',
      transcript: trimmed,
      partial: '',
      error: null,
      needsRetry: false,
      heardNothing: false,
    });
    try {
      const outcome = await impl.process(trimmed, pending ? { pending } : undefined);
      set((s) => ({
        status: 'idle',
        outcome,
        pendingClarification: outcome.clarification ?? null,
        // Cleared only by the sentence itself going through. A *different*
        // utterance succeeding says nothing about the one still waiting, and
        // clearing on any success is how the kept text would quietly vanish
        // the next time the user said anything at all.
        recovered: s.recovered?.text.trim() === trimmed ? null : s.recovered,
      }));
      const toSpeak =
        outcome.speak === false ? undefined : (outcome.clarification?.question ?? outcome.feedback);
      if (toSpeak) {
        set({ status: 'speaking' });
        await impl.speak(toSpeak).catch(() => {});
        set((s) => (s.status === 'speaking' ? { ...s, status: 'idle' } : s));
      }
      // A clarification keeps the sheet open so the user can answer immediately.
      if (outcome.clarification) set({ expanded: true });
    } catch (error) {
      set({
        status: 'error',
        error: error instanceof Error ? error.message : 'That did not go through.',
        // The turn is what failed, not the sentence. Keeping it is the
        // difference between "try again" and "say all of that again".
        recovered: { text: trimmed, at: now(), reason: 'failed' },
      });
    }
  },

  recoverTranscript: () => {
    const state = get();
    const kept = state.recovered;
    if (!kept) return null;
    // Out of the slot and into the composer in one move: it is no longer lost,
    // and if the sheet is dismissed with it still unsent `keepDraft` puts it
    // straight back.
    //
    // The failure is cleared with it, but only if that is what the store is
    // showing: this card outlives its own turn, so it can be pressed while a
    // *later* one is still thinking, and blanking the status then would report
    // an in-flight turn as finished.
    set({
      recovered: null,
      draftSeed: kept.text,
      expanded: true,
      ...(state.status === 'error'
        ? { status: 'idle' as const, error: null, needsRetry: false, heardNothing: false }
        : {}),
    });
    return kept.text;
  },

  discardRecovered: () => set({ recovered: null, draftSeed: null }),

  keepDraft: (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    set({ recovered: { text: trimmed, at: now(), reason: 'unsent' } });
  },

  consumeDraftSeed: () => set({ draftSeed: null }),

  reset: () => {
    session += 1;
    set({
      status: 'idle',
      typing: false,
      partial: '',
      transcript: '',
      error: null,
      needsRetry: false,
      sttUnavailable: false,
      heardNothing: false,
      outcome: null,
      pendingClarification: null,
      // Deliberately **not** cleared, and neither is it in `close()`. This is
      // the reset a new turn does, and a new turn is not the user saying they
      // are finished with the last one. `discardRecovered()` is that.
      recovered: unanswered(get()),
      draftSeed: null,
    });
  },
}));
