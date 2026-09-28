import { create } from 'zustand';
import { now } from '@/core/clock';
import type { LlmAction } from '@/llm/contract';
// Type-only, so nothing of the executor is loaded here: the dock renders the
// rows a search found and has to name their shape, not build one.
import type { ResultHit } from '@/llm/executor';
import { wasPoorlyHeard } from '@/llm/confirm';
import type { ActionPreview } from '@/llm/confirm';
import type { ClarificationAnswers } from '@/llm/orchestrator';

/**
 * `sending` is the gap between the user finishing and the turn starting, and it
 * exists because that gap used to be drawn as `idle`.
 *
 * The recogniser is allowed up to `STOP_GRACE_MS` (2.5s) to return a final
 * result after being asked to stop, and for all of it the store used to say
 * `idle` — so releasing the microphone put the resting caption back, dropped
 * the words the user had just watched appear, and cooled the field, and then a
 * receipt arrived out of nowhere seconds later. It read as the app having
 * thrown the sentence away. Nothing was wrong except what the screen said.
 */
export type VoiceStatus = 'idle' | 'listening' | 'sending' | 'thinking' | 'speaking' | 'error';

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
  /**
   * Why it is being kept, which decides what the card says.
   *
   * `unanswered` is its own reason and not a flavour of `unsent`: walking away
   * from a question is a different event from a sentence that never left, and
   * telling somebody their words were "not sent" when what actually happened is
   * that they dismissed a question describes the wrong half of it.
   */
  reason: 'failed' | 'unsent' | 'unanswered';
};

/**
 * Text on its way into the composer, and what the composer should say about it.
 *
 * `recovered` — the user is taking back something that was set aside. The
 * words are theirs and the box is where they left off.
 *
 * `review` — the recogniser has just finished and nothing has been sent. The
 * words are a *claim* about what was said, and the box is the last point at
 * which correcting them is free. See `reviewBeforeSending` in
 * `src/repositories/settings.ts` for why that point is worth stopping at.
 */
export type DraftSeed = { text: string; reason: 'recovered' | 'review' };

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
  /**
   * A question the turn stopped on, and how it can be answered.
   *
   * `answers` is the half the screen needs. A confirmation is always a yes/no
   * — the actions are parked and a yes replays them without calling the model
   * at all — so it gets buttons, and answering costs nothing. An open question
   * is the model asking for something it genuinely could not default, and only
   * a sentence will do.
   *
   * It exists because the sheet had one answer box for both, so the fastest
   * possible reply to "Add to calendar — Robotics report, 3 Sep 14:00?" was to
   * type the word "yes" at a keyboard, on the screen of an app whose entire
   * premise is not having to.
   */
  clarification?: {
    question: string;
    pending?: string;
    answers?: ClarificationAnswers;
    preview?: ActionPreview;
  };
  /**
   * The turn never ran — a transport failure, a 401, a timeout, an internal
   * throw. See `TurnOutcome.failed`.
   *
   * `process()` resolves for these, with a sentence to say and no items, so
   * without this the store cannot tell "asked and answered with nothing" from
   * "never asked at all". Only the second one still owes the user their words.
   */
  failed?: boolean;
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
  pendingClarification: {
    question: string;
    pending?: string;
    answers?: ClarificationAnswers;
    preview?: ActionPreview;
  } | null;
  /** See `RecoveredTranscript`. Outlives `close()` and `reset()` by design. */
  recovered: RecoveredTranscript | null;
  /**
   * Text handed to the composer and waiting for the dock to pick it up.
   *
   * One-shot, and it exists because the offer to restore is drawn in two
   * places — the sheet and home — while the text box lives in only one of
   * them. `consumeDraftSeed()` is the dock taking it.
   *
   * It carries **why** as well as what, because the same box says two
   * different things. `recovered` is "this was lost, here it is back" and the
   * words are already the user's own. `review` is "this is what I heard, is it
   * right?" — the words are the *recogniser's* claim about what was said, and
   * the box is a chance to correct it before anybody is charged for it. A box
   * labelled "Type what you would have said" over a sentence the app just
   * heard reads as a failure, which is exactly what this path is not.
   */
  draftSeed: DraftSeed | null;

  open: () => void;
  /**
   * Dismiss the sheet.
   *
   * `draft` is whatever was still in the text box, and it **outranks** the
   * transcript rather than being kept beside it. The dock used to call
   * `keepDraft(draft)` and then `close()`, and `close()` recomputed the slot
   * from `state.transcript` — so a user who pressed "Edit", changed the
   * sentence and then tapped the backdrop got the *pre-edit* words handed back
   * and their correction destroyed by the one feature whose entire job is not
   * losing typed words. One call, one decision, newest wins.
   */
  close: (draft?: string) => void;
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
  /**
   * Puts text straight into the keeping place.
   *
   * The primitive under `close(draft)`, and the way anything outside the sheet
   * sets a sentence aside. The sheet itself goes through `close()` instead:
   * two calls let `close()`'s own recomputation win over what was just kept.
   */
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
  // A resolved outcome is not the same thing as an answer. A turn whose model
  // call never landed comes back resolved, carrying an apology and no items,
  // and reading only `transcript === transcript` counted that as answered.
  const failed = state.outcome?.failed === true;
  // A parked question is not an answer either.
  //
  // This conjunct was missing and it lost whole utterances. On the default
  // `irreversible` confirm mode, "add milk to my shopping list" opens a
  // question; dismissing it — by the backdrop, which this file's own comment
  // calls an easy tap to make by accident, or the grabber, or a drag, or
  // Android Back — left an idle microphone and nothing whatsoever on screen.
  // Milk was not added and there was no evidence the sentence had ever been
  // spoken. All three of the other conditions hold on a clarification turn:
  // the outcome carries the transcript, there is no error, and nothing failed.
  const parked = state.pendingClarification !== null;
  const answered =
    state.outcome?.transcript.trim() === text && state.error === null && !failed && !parked;
  if (answered) return state.recovered;
  // Already kept, and keeping it again would only move its timestamp — which
  // is what the "NOT SENT — KEPT" card sorts and ages by.
  if (state.recovered?.text.trim() === text) return state.recovered;
  const reason: RecoveredTranscript['reason'] =
    state.error || failed ? 'failed' : parked ? 'unanswered' : 'unsent';
  return { text, at: now(), reason };
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
  close: (draft?: string) => {
    session += 1;
    void pipeline?.stopListening().catch(() => {});
    void pipeline?.stopSpeaking().catch(() => {});
    const typed = draft?.trim();
    set({
      expanded: false,
      typing: false,
      status: 'idle',
      partial: '',
      error: null,
      needsRetry: false,
      sttUnavailable: false,
      heardNothing: false,
      // Dismissing a question is how a user abandons it — there is no "forget
      // it" control, and there cannot be a second door for something this
      // destructive. Left parked, the envelope was echoed back on the *next*
      // utterance, so a `note_delete` the user walked away from could be fired
      // hours later by an unrelated "sounds good"; the abandoned question also
      // re-opened the sheet on home every turn and was injected into the next
      // request as history. Only `close()` clears it: `startListening()` must
      // not, or answering a clarification out loud would stop working.
      pendingClarification: null,
      // Closing the sheet is not an answer. Whatever was in it is set aside
      // rather than dropped — the whole point of `recovered`.
      recovered: typed
        ? { text: typed, at: now(), reason: 'unsent' as const }
        : unanswered(get()),
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
        /*
          A finished utterance is sent, unless the recogniser says it may have
          got it wrong.

          ## What this was, and why it changed

          Every utterance used to stop here and seed the composer, so the words
          landed in a text box behind a full-screen scrim and the user pressed
          Send. The reasoning was sound and is kept below; what it missed is
          that it charged *every* sentence for the mistakes of a few, on the one
          screen whose whole premise is not having to look.

          That reasoning: sending is one tap and unsending is not a thing that
          exists. There is no "rewind my last request" — `LastAction` undoes a
          *single* row through an allow-list (`src/features/home/undo.ts`), so a
          mis-heard sentence that filed three actions is three separate
          corrections, some of which cannot be made at all. And this is the only
          check in the app that fires before the model is called: `confirmMode`,
          the executor's review gate and the handlers' own questions all read a
          *reply*, so by the time any of them can ask, the turn is already spent.

          ## What replaces it

          All of that is still true, and none of it argues for asking about a
          sentence the recogniser is confident about. The check was never really
          "may I spend a turn" — it was "are these the words you said".
          `wasPoorlyHeard` is this app's own existing answer to exactly that
          question, at a documented 0.85, already used by the confirmation gate,
          and already careful about the platforms that measure nothing: Android
          reports 0 or -1, and those read as *unknown* rather than as bad, or
          every write on that fleet would stop here for ever.

          So the review survives where it was earning its place and gets out of
          the way where it was not.

          The other half of the argument is that the words are no longer unseen
          when they go: the caption under the microphone *is* the live
          transcript, and what commits is releasing a button the user is already
          holding while reading it. The look happens during the utterance rather
          than after it — the same trade the Stream ring makes by having no
          screen to put a draft on at all.

          `submitText` is the only path out of here, so a spoken answer to a
          pending question still carries its token: that function reads
          `pendingClarification` itself.
        */
        onFinal: (text, confidence) => {
          if (ticket !== session) return;

          if (!wasPoorlyHeard(confidence)) {
            // Not `status: 'idle'` on the way past — `submitText` sets
            // `thinking` itself, and an idle frame in between is the blink this
            // whole path was rewritten to remove.
            set({ partial: '', error: null, needsRetry: false, heardNothing: false });
            void get().submitText(text);
            return;
          }

          set({
            partial: '',
            status: 'idle',
            error: null,
            needsRetry: false,
            heardNothing: false,
            expanded: true,
            draftSeed: { text, reason: 'review' as const },
          });
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
    // Set before the await, not after: this is the frame the finger lifts on,
    // and the recogniser can take another 2.5s to hand the words over. The
    // partial is deliberately left alone so the sentence stays on screen the
    // whole way through rather than blinking out and coming back.
    if (get().status === 'listening') set({ status: 'sending' });
    await pipeline?.stopListening().catch(() => {});
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
    //
    // Refusing is not the same as discarding. The dock clears its box on Send
    // and the box stays mounted through a turn whenever a clarification is
    // pending, so a user correcting themselves while the model was slow
    // watched the sentence vanish with no error, no receipt and nothing kept.
    // The refusal puts it in the one place that survives.
    if (get().status === 'thinking') {
      set({ recovered: { text: trimmed, at: now(), reason: 'unsent' } });
      return;
    }
    if (!impl) {
      set({
        status: 'error',
        error: 'Voice is still starting up.',
        recovered: { text: trimmed, at: now(), reason: 'unsent' },
      });
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
        // A turn that resolved without ever reaching the model has not answered
        // anything — see `VoiceOutcome.failed`. It keeps the sentence exactly
        // as the `catch` below does; the only difference is that this one came
        // back with an apology to say rather than an Error to translate.
        //
        // Otherwise: cleared only by the sentence itself going through. A
        // *different* utterance succeeding says nothing about the one still
        // waiting, and clearing on any success is how the kept text would
        // quietly vanish the next time the user said anything at all.
        recovered: outcome.failed
          ? { text: trimmed, at: now(), reason: 'failed' as const }
          : s.recovered?.text.trim() === trimmed
            ? null
            : s.recovered,
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
    // and if the sheet is dismissed with it still unsent `close(draft)` puts it
    // straight back — including any edit made to it in between, which is why
    // the dock hands the text to `close()` rather than keeping it separately.
    //
    // The failure is cleared with it, but only if that is what the store is
    // showing: this card outlives its own turn, so it can be pressed while a
    // *later* one is still thinking, and blanking the status then would report
    // an in-flight turn as finished.
    set({
      recovered: null,
      draftSeed: { text: kept.text, reason: 'recovered' as const },
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
