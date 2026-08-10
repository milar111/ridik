import { create } from 'zustand';
import type { LlmAction } from '@/llm/contract';

export type VoiceStatus = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

export type VoiceOutcomeItem = {
  toolName: LlmAction['tool_name'];
  ok: boolean;
  summary: string;
  detail?: string;
  /** Route to open when the user taps the result. */
  href?: string;
  /** The row the action touched; see `undoableAction` before acting on it. */
  entityId?: string;
};

export type VoiceOutcome = {
  transcript: string;
  /** False suppresses TTS for this turn without hiding the text. */
  speak?: boolean;
  /** A one-off explanation shown above the results, e.g. a spend cap being hit. */
  notice?: string;
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
}

export function getVoicePipeline(): VoicePipeline | null {
  return pipeline;
}

type VoiceState = {
  status: VoiceStatus;
  expanded: boolean;
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
  outcome: VoiceOutcome | null;
  pendingClarification: { question: string; pending?: string } | null;

  open: () => void;
  close: () => void;
  startListening: () => Promise<void>;
  stopListening: () => Promise<void>;
  submitText: (text: string) => Promise<void>;
  reset: () => void;
};

export const useVoiceStore = create<VoiceState>((set, get) => ({
  status: 'idle',
  expanded: false,
  partial: '',
  transcript: '',
  error: null,
  needsRetry: false,
  sttUnavailable: false,
  outcome: null,
  pendingClarification: null,

  open: () => set({ expanded: true }),
  close: () => {
    session += 1;
    void pipeline?.stopListening().catch(() => {});
    void pipeline?.stopSpeaking().catch(() => {});
    set({
      expanded: false,
      status: 'idle',
      partial: '',
      error: null,
      needsRetry: false,
      sttUnavailable: false,
    });
  },

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
      partial: '',
      transcript: '',
      error: null,
      needsRetry: false,
      sttUnavailable: false,
      outcome: null,
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
          set({
            status: 'error',
            error: message,
            needsRetry: reason === 'low_confidence' || reason === 'empty',
            sttUnavailable: reason === 'unsupported',
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
    if (!impl) {
      set({ status: 'error', error: 'Voice is still starting up.' });
      return;
    }
    const pending = get().pendingClarification?.pending;
    set({ status: 'thinking', transcript: trimmed, partial: '', error: null, needsRetry: false });
    try {
      const outcome = await impl.process(trimmed, pending ? { pending } : undefined);
      set({
        status: 'idle',
        outcome,
        pendingClarification: outcome.clarification ?? null,
      });
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
      });
    }
  },

  reset: () => {
    session += 1;
    set({
      status: 'idle',
      partial: '',
      transcript: '',
      error: null,
      needsRetry: false,
      sttUnavailable: false,
      outcome: null,
      pendingClarification: null,
    });
  },
}));
