/**
 * Focus/pomodoro session persistence.
 *
 * The row stores *when* the current phase started, not a countdown, so the
 * truth survives the app being killed: `computeSessionState` replays wall-clock
 * time against the plan and works out where the session actually is now. The
 * runtime (notifications, Live Activity) is a consumer of that function, never
 * the owner of the state.
 */
import { and, asc, desc, eq, gte, inArray, lt } from 'drizzle-orm';

import { now } from '@/core/clock';
import { AppError, fail, ok, type Result } from '@/core/result';
import { newId } from '@/db/ids';
import type { RidikDatabase } from '@/db/migrator';
import { focusSessions, type FocusSession } from '@/db/schema';

import { serialised } from './transaction';

export type SessionPhaseKind = 'focus' | 'break';
export type SessionPhase = { kind: SessionPhaseKind; minutes: number };
export type FocusSessionStatus = FocusSession['status'];

/** The subset of a row the reducer needs; a full `FocusSession` satisfies it. */
export type SessionSnapshot = Pick<
  FocusSession,
  'phases' | 'phaseIndex' | 'phaseStartedAt' | 'pausedAt' | 'accumulatedPauseMs' | 'status' | 'endedAt'
>;

export type SessionState = {
  phaseIndex: number;
  phase: SessionPhase;
  phaseElapsedMs: number;
  phaseRemainingMs: number;
  totalRemainingMs: number;
  isComplete: boolean;
  status: FocusSessionStatus;
};

export type CreateSessionInput = {
  label: string;
  subject?: string | null;
  projectId?: string | null;
  phases: SessionPhase[];
};

const MINUTE_MS = 60_000;
const ACTIVE_STATUSES = ['running', 'paused'] as const;

export function encodePhases(phases: readonly SessionPhase[]): string {
  return JSON.stringify(validatePhases(phases));
}

export function parsePhases(raw: string): SessionPhase[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new AppError('invalid_input', 'This session’s plan is unreadable.', { details: raw });
  }
  return validatePhases(decoded);
}

function validatePhases(value: unknown): SessionPhase[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AppError('invalid_input', 'A session needs at least one phase.');
  }
  return value.map((entry) => {
    const phase = entry as Partial<SessionPhase>;
    if (phase?.kind !== 'focus' && phase?.kind !== 'break') {
      throw new AppError('invalid_input', 'A phase must be a focus or a break.');
    }
    if (typeof phase.minutes !== 'number' || !Number.isFinite(phase.minutes) || phase.minutes < 0) {
      throw new AppError('invalid_input', 'A phase needs a duration in minutes.');
    }
    return { kind: phase.kind, minutes: phase.minutes };
  });
}

const durationOf = (phase: SessionPhase): number => Math.round(phase.minutes * MINUTE_MS);

/**
 * Where the session is at `nowMs`.
 *
 * Rolls forward across however many phases have elapsed since `phaseStartedAt`
 * — the app being closed for three hours must resolve to the right phase, not
 * to a timer frozen where it was backgrounded — and reports `isComplete` once
 * the whole plan is behind us. Paused sessions freeze at `pausedAt`; a
 * zero-length break is consumed instantly rather than blocking the roll.
 */
export function computeSessionState(session: SessionSnapshot, nowMs: number): SessionState {
  const phases = parsePhases(session.phases);
  const lastIndex = phases.length - 1;

  if (session.status === 'completed') {
    const phase = phases[lastIndex]!;
    return {
      phaseIndex: lastIndex,
      phase,
      phaseElapsedMs: durationOf(phase),
      phaseRemainingMs: 0,
      totalRemainingMs: 0,
      isComplete: true,
      status: 'completed',
    };
  }

  const reference =
    session.status === 'paused'
      ? session.pausedAt ?? nowMs
      : session.status === 'cancelled'
        ? session.endedAt ?? nowMs
        : nowMs;

  let index = Math.min(Math.max(session.phaseIndex, 0), lastIndex);
  let elapsed = Math.max(0, reference - session.phaseStartedAt - session.accumulatedPauseMs);
  while (index < lastIndex && elapsed >= durationOf(phases[index]!)) {
    elapsed -= durationOf(phases[index]!);
    index++;
  }

  const phase = phases[index]!;
  const duration = durationOf(phase);
  const overrun = elapsed >= duration;
  const phaseElapsedMs = overrun ? duration : elapsed;
  const phaseRemainingMs = duration - phaseElapsedMs;
  const laterMs = phases.slice(index + 1).reduce((sum, next) => sum + durationOf(next), 0);
  const isComplete = session.status !== 'cancelled' && overrun && index === lastIndex;

  return {
    phaseIndex: index,
    phase,
    phaseElapsedMs,
    phaseRemainingMs,
    totalRemainingMs: isComplete ? 0 : phaseRemainingMs + laterMs,
    isComplete,
    status: isComplete ? 'completed' : session.status,
  };
}

/** Focus minutes actually delivered — phases the session has finished. */
export function focusMinutesDelivered(session: SessionSnapshot, nowMs: number): number {
  const phases = parsePhases(session.phases);
  const state = computeSessionState(session, nowMs);
  const reached = state.isComplete ? phases.length : state.phaseIndex;
  return phases
    .slice(0, reached)
    .reduce((sum, phase) => (phase.kind === 'focus' ? sum + phase.minutes : sum), 0);
}

export function createFocusSessionsRepository(db: RidikDatabase) {
  async function getById(id: string): Promise<FocusSession | null> {
    const [row] = await db.select().from(focusSessions).where(eq(focusSessions.id, id));
    return row ?? null;
  }

  /**
   * Every write queues behind the last one. One SQLite connection serves all
   * repositories, so an unqueued insert issued while a sibling repository holds
   * a transaction open is discarded when that transaction rolls back.
   */
  async function patch(
    id: string,
    values: Partial<typeof focusSessions.$inferInsert>,
  ): Promise<Result<FocusSession>> {
    return serialised(db, async () => {
      const [row] = await db
        .update(focusSessions)
        .set(values)
        .where(eq(focusSessions.id, id))
        .returning();
      return row ? ok(row) : fail('not_found', 'That session is no longer running.');
    });
  }

  return {
    getById,

    async create(input: CreateSessionInput): Promise<FocusSession> {
      const at = now();
      // Encoded before queuing so an invalid plan throws straight away.
      const phases = encodePhases(input.phases);
      return serialised(db, async () => {
        const [row] = await db
          .insert(focusSessions)
          .values({
            id: newId(),
            label: input.label.trim(),
            subject: input.subject ?? null,
            projectId: input.projectId ?? null,
            phases,
            phaseIndex: 0,
            phaseStartedAt: at,
            pausedAt: null,
            accumulatedPauseMs: 0,
            status: 'running',
            startedAt: at,
            createdAt: at,
            updatedAt: at,
          })
          .returning();
        if (!row) throw new AppError('unknown', 'Could not start that session.');
        return row;
      });
    },

    /** Newest first, so a stray older session can never shadow the live one. */
    async getActive(): Promise<FocusSession | null> {
      const [row] = await db
        .select()
        .from(focusSessions)
        .where(inArray(focusSessions.status, [...ACTIVE_STATUSES]))
        .orderBy(desc(focusSessions.startedAt), desc(focusSessions.id))
        .limit(1);
      return row ?? null;
    },

    /**
     * Moves to the next phase, or finishes the session when the plan is done.
     * The pause accumulator is per-phase, so it resets here.
     */
    async advancePhase(id: string, at = now()): Promise<Result<FocusSession>> {
      const current = await getById(id);
      if (!current) return fail('not_found', 'That session is no longer running.');
      if (current.status === 'completed' || current.status === 'cancelled') {
        return fail('invalid_input', 'That session has already finished.');
      }

      const phases = parsePhases(current.phases);
      const next = current.phaseIndex + 1;
      if (next > phases.length - 1) {
        return patch(id, {
          phaseIndex: phases.length - 1,
          status: 'completed',
          pausedAt: null,
          endedAt: at,
          updatedAt: at,
        });
      }
      return patch(id, {
        phaseIndex: next,
        phaseStartedAt: at,
        accumulatedPauseMs: 0,
        pausedAt: null,
        status: 'running',
        updatedAt: at,
      });
    },

    async pause(id: string, at = now()): Promise<Result<FocusSession>> {
      const current = await getById(id);
      if (!current) return fail('not_found', 'That session is no longer running.');
      if (current.status !== 'running') return ok(current);
      return patch(id, { status: 'paused', pausedAt: at, updatedAt: at });
    },

    async resume(id: string, at = now()): Promise<Result<FocusSession>> {
      const current = await getById(id);
      if (!current) return fail('not_found', 'That session is no longer running.');
      if (current.status !== 'paused') return ok(current);
      const pausedFor = Math.max(0, at - (current.pausedAt ?? at));
      return patch(id, {
        status: 'running',
        pausedAt: null,
        accumulatedPauseMs: current.accumulatedPauseMs + pausedFor,
        updatedAt: at,
      });
    },

    async complete(id: string, at = now()): Promise<Result<FocusSession>> {
      return patch(id, { status: 'completed', pausedAt: null, endedAt: at, updatedAt: at });
    },

    async cancel(id: string, at = now()): Promise<Result<FocusSession>> {
      return patch(id, { status: 'cancelled', pausedAt: null, endedAt: at, updatedAt: at });
    },

    async setLiveActivityId(id: string, value: string | null): Promise<Result<FocusSession>> {
      return patch(id, { liveActivityId: value, updatedAt: now() });
    },

    async listRecent(limit = 20): Promise<FocusSession[]> {
      return db
        .select()
        .from(focusSessions)
        .orderBy(desc(focusSessions.startedAt), desc(focusSessions.id))
        .limit(limit);
    },

    async totalFocusMinutesBetween(from: number, to: number, at = now()): Promise<number> {
      const rows = await db
        .select()
        .from(focusSessions)
        .where(and(gte(focusSessions.startedAt, from), lt(focusSessions.startedAt, to)))
        .orderBy(asc(focusSessions.startedAt));
      return rows.reduce((sum, row) => sum + focusMinutesDelivered(row, at), 0);
    },
  };
}

export type FocusSessionsRepository = ReturnType<typeof createFocusSessionsRepository>;

export type { FocusSession };
