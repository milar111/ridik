/**
 * Focus/pomodoro sessions.
 *
 * The row stores when the current phase began, not a countdown, so the timer is
 * derived rather than stored: `useFocusSessionState` replays wall-clock time
 * against the plan on every tick. That is why the app can be killed mid-session
 * and come back showing the right phase — and why the tick lives in the hook
 * rather than in a query that would hammer SQLite once a second.
 */
import { useEffect, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { now } from '@/core/clock';
import { createLogger } from '@/core/logger';
import { unwrap } from '@/core/result';
import { getRepositories } from '@/repositories';
import {
  computeSessionState,
  type CreateSessionInput,
  type FocusSession,
  type SessionState,
} from '@/repositories/focusSessions';

import { invalidateKeys, qk } from './keys';

const log = createLogger('hooks/focus');

/** A running session is the top card on Today. */
const FOCUS_WRITE_KEYS = [qk.focus.all, qk.today.all] as const;

/* ------------------------------------------------------------------- reads */

export function useActiveFocusSession(
  options: { enabled?: boolean } = {},
): UseQueryResult<FocusSession | null> {
  return useQuery({
    queryKey: qk.focus.active(),
    queryFn: () => getRepositories().focus.getActive(),
    enabled: options.enabled ?? true,
  });
}

export function useFocusSession(
  id: string | undefined,
  options: { enabled?: boolean } = {},
): UseQueryResult<FocusSession | null> {
  return useQuery({
    queryKey: qk.focus.detail(id ?? ''),
    queryFn: () => getRepositories().focus.getById(id!),
    enabled: (options.enabled ?? true) && Boolean(id),
  });
}

export function useRecentFocusSessions(limit = 20): UseQueryResult<FocusSession[]> {
  return useQuery({
    queryKey: qk.focus.recent(limit),
    queryFn: () => getRepositories().focus.listRecent(limit),
  });
}

/** Focus minutes actually delivered in `[from, to)`. */
export function useFocusMinutes(from: number, to: number): UseQueryResult<number> {
  return useQuery({
    queryKey: qk.focus.minutes(from, to),
    queryFn: () => getRepositories().focus.totalFocusMinutesBetween(from, to),
  });
}

/**
 * The live position of a session, recomputed on a timer while it runs.
 *
 * Returns null rather than throwing when the stored plan is unreadable: a
 * corrupt row must cost the user their timer, not the whole screen.
 */
export function useFocusSessionState(
  session: FocusSession | null | undefined,
  options: { tickMs?: number } = {},
): SessionState | null {
  const tickMs = options.tickMs ?? 1000;
  const [at, setAt] = useState(() => now());

  useEffect(() => {
    setAt(now());
    if (session?.status !== 'running') return;
    const handle = setInterval(() => setAt(now()), tickMs);
    return () => clearInterval(handle);
  }, [session, tickMs]);

  if (!session) return null;
  try {
    return computeSessionState(session, at);
  } catch (error) {
    log.warn('Unreadable focus session plan', { id: session.id, error });
    return null;
  }
}

/* ------------------------------------------------------------------ writes */

export function useStartFocusSession(): UseMutationResult<
  FocusSession,
  Error,
  CreateSessionInput
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSessionInput) => getRepositories().focus.create(input),
    onSettled: () => invalidateKeys(client, FOCUS_WRITE_KEYS),
  });
}

export function usePauseFocusSession(): UseMutationResult<FocusSession, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => unwrap(await getRepositories().focus.pause(id)),
    onSettled: () => invalidateKeys(client, FOCUS_WRITE_KEYS),
  });
}

export function useResumeFocusSession(): UseMutationResult<FocusSession, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => unwrap(await getRepositories().focus.resume(id)),
    onSettled: () => invalidateKeys(client, FOCUS_WRITE_KEYS),
  });
}

/** Moves to the next phase, or finishes the session when the plan is done. */
export function useAdvanceFocusPhase(): UseMutationResult<FocusSession, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => unwrap(await getRepositories().focus.advancePhase(id)),
    onSettled: () => invalidateKeys(client, FOCUS_WRITE_KEYS),
  });
}

export function useCompleteFocusSession(): UseMutationResult<FocusSession, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => unwrap(await getRepositories().focus.complete(id)),
    onSettled: () => invalidateKeys(client, FOCUS_WRITE_KEYS),
  });
}

export function useCancelFocusSession(): UseMutationResult<FocusSession, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => unwrap(await getRepositories().focus.cancel(id)),
    onSettled: () => invalidateKeys(client, FOCUS_WRITE_KEYS),
  });
}

/** Ties the row to an iOS Live Activity so the runtime can update or end it. */
export function useSetFocusLiveActivityId(): UseMutationResult<
  FocusSession,
  Error,
  { id: string; liveActivityId: string | null }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; liveActivityId: string | null }) =>
      unwrap(await getRepositories().focus.setLiveActivityId(input.id, input.liveActivityId)),
    onSettled: () => invalidateKeys(client, [qk.focus.all]),
  });
}
