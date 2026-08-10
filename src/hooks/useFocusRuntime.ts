/**
 * The running focus session, as a screen sees it.
 *
 * Deliberately *not* re-exported from './index': this module binds the focus
 * service, which pulls in notifications, audio and the Live Activity surface.
 * Only the Focus screen needs any of that, and putting it in the barrel would
 * load it into every screen in the app.
 *
 * Nothing here counts seconds. The runtime publishes the same snapshot the
 * lock screen renders, recomputed from the stored row on every tick, so a
 * stalled JS thread or a backgrounded app cannot make the display drift from
 * the plan. The wall-clock fallback below exists only for the frames before
 * the runtime has published anything — a cold start, or a session the voice
 * executor wrote straight to the repository.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';

import { now } from '@/core/clock';
import { createLogger } from '@/core/logger';
import { unwrap } from '@/core/result';
import {
  focusMinutesDelivered,
  parsePhases,
  type FocusSession,
  type SessionPhase,
} from '@/repositories/focusSessions';
import {
  buildPhases,
  control,
  getSnapshot,
  snapshotOf,
  startFromPlan,
  subscribe,
  type FocusControlAction,
  type FocusPlanInput,
  type FocusSnapshot,
} from '@/services/focus';

import { invalidateKeys, qk } from './keys';
import { useActiveFocusSession, useRecentFocusSessions } from './useFocus';

const log = createLogger('hooks/focus-runtime');

const FOCUS_WRITE_KEYS = [qk.focus.all, qk.today.all] as const;

export type { FocusControlAction, FocusPlanInput, FocusSnapshot, SessionPhase };

/* ------------------------------------------------------------------- reads */

/** The runtime's live snapshot, or null when nothing is being driven. */
export function useFocusSnapshot(): FocusSnapshot | null {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export type LiveFocus = {
  snapshot: FocusSnapshot | null;
  /** The whole plan, for the phase strip. Empty when the row is unreadable. */
  phases: SessionPhase[];
  isLoading: boolean;
};

/**
 * The snapshot plus the plan it belongs to.
 *
 * Also the one place that tells React Query about the writes the runtime makes
 * behind its back: phase advances and completions go straight to SQLite, so
 * without this the cached row and the Today screen would never hear about them.
 */
export function useLiveFocus(): LiveFocus {
  const client = useQueryClient();
  const live = useFocusSnapshot();
  const query = useActiveFocusSession();
  const session = query.data ?? null;

  const at = useWallClock(!live && session?.status === 'running');
  const derived = useMemo(
    () => (live || !session ? null : safeSnapshot(session, at)),
    [live, session, at],
  );
  const snapshot = live ?? derived;

  const phases = useMemo(() => safePhases(session), [session]);

  const sessionId = snapshot?.sessionId;
  const status = snapshot?.status;
  const phaseIndex = snapshot?.phaseIndex;
  useEffect(() => {
    if (!sessionId) return;
    void invalidateKeys(client, FOCUS_WRITE_KEYS);
  }, [client, sessionId, status, phaseIndex]);

  return { snapshot, phases, isLoading: query.isLoading };
}

export type FocusSessionSummary = {
  session: FocusSession;
  /** Focus minutes actually delivered, not planned. */
  minutes: number;
  /** The plan it ran, so a finished session can be repeated in one tap. */
  phases: SessionPhase[];
};

export function useRecentFocusSummaries(limit = 12): {
  summaries: FocusSessionSummary[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
} {
  const query = useRecentFocusSessions(limit);
  const rows = query.data;
  const summaries = useMemo(() => {
    const at = now();
    return (rows ?? []).map((session) => ({
      session,
      minutes: safeMinutes(session, at),
      phases: safePhases(session),
    }));
  }, [rows]);

  return {
    summaries,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: () => void query.refetch(),
  };
}

/* ------------------------------------------------------------------ writes */

/**
 * Starts a plan through the runtime rather than the repository: a row inserted
 * behind the runtime's back would have no alarms, no chimes and no Live
 * Activity until the next foreground pass noticed it.
 */
export function useStartFocusPlan(): UseMutationResult<FocusSnapshot, Error, FocusPlanInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: FocusPlanInput) => unwrap(await startFromPlan(input)),
    onSettled: () => invalidateKeys(client, FOCUS_WRITE_KEYS),
  });
}

/** Pause / resume / skip / stop, for the same reason. */
export function useFocusControl(): UseMutationResult<
  FocusSnapshot | null,
  Error,
  FocusControlAction
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (action: FocusControlAction) => unwrap(await control(action)),
    onSettled: () => invalidateKeys(client, FOCUS_WRITE_KEYS),
  });
}

/* ------------------------------------------------------------------- plans */

/** The phases a plan would produce — the preview the builder shows. */
export function previewFocusPlan(input: FocusPlanInput): SessionPhase[] {
  try {
    return buildPhases(input);
  } catch (error) {
    log.warn('unusable plan', error);
    return [];
  }
}

export function focusPlanTotals(phases: readonly SessionPhase[]): {
  focusMinutes: number;
  breakMinutes: number;
  totalMinutes: number;
} {
  let focusMinutes = 0;
  let breakMinutes = 0;
  for (const phase of phases) {
    if (phase.kind === 'focus') focusMinutes += phase.minutes;
    else breakMinutes += phase.minutes;
  }
  return { focusMinutes, breakMinutes, totalMinutes: focusMinutes + breakMinutes };
}

/* --------------------------------------------------------------- internals */

/** Re-reads the clock every second while `active`; frozen otherwise. */
function useWallClock(active: boolean, tickMs = 1000): number {
  const [at, setAt] = useState(() => now());
  useEffect(() => {
    if (!active) return;
    setAt(now());
    const handle = setInterval(() => setAt(now()), tickMs);
    return () => clearInterval(handle);
  }, [active, tickMs]);
  return at;
}

/** A corrupt plan costs the user their timer, never the whole screen. */
function safeSnapshot(session: FocusSession, at: number): FocusSnapshot | null {
  try {
    return snapshotOf(session, at);
  } catch (error) {
    log.warn('unreadable focus session plan', { id: session.id, error });
    return null;
  }
}

function safePhases(session: FocusSession | null): SessionPhase[] {
  if (!session) return [];
  try {
    return parsePhases(session.phases);
  } catch {
    return [];
  }
}

function safeMinutes(session: FocusSession, at: number): number {
  try {
    return focusMinutesDelivered(session, at);
  } catch {
    return 0;
  }
}
