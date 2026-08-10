import { freezeClock, setClock } from '@/core/clock';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import {
  computeSessionState,
  createFocusSessionsRepository,
  encodePhases,
  focusMinutesDelivered,
  parsePhases,
  type FocusSessionsRepository,
  type SessionPhase,
  type SessionSnapshot,
} from '@/repositories/focusSessions';

const NOW = 1_780_000_000_000;
const MINUTE = 60_000;

const pomodoro = (cycles: number): SessionPhase[] =>
  Array.from({ length: cycles }, () => [
    { kind: 'focus' as const, minutes: 25 },
    { kind: 'break' as const, minutes: 5 },
  ]).flat();

const snapshot = (overrides: Partial<SessionSnapshot> & { phases: string }): SessionSnapshot => ({
  phaseIndex: 0,
  phaseStartedAt: NOW,
  pausedAt: null,
  accumulatedPauseMs: 0,
  status: 'running',
  endedAt: null,
  ...overrides,
});

describe('computeSessionState', () => {
  it('reports progress inside the current phase', () => {
    const session = snapshot({ phases: encodePhases(pomodoro(1)) });
    const state = computeSessionState(session, NOW + 10 * MINUTE);

    expect(state.phaseIndex).toBe(0);
    expect(state.phase).toEqual({ kind: 'focus', minutes: 25 });
    expect(state.phaseElapsedMs).toBe(10 * MINUTE);
    expect(state.phaseRemainingMs).toBe(15 * MINUTE);
    expect(state.totalRemainingMs).toBe(20 * MINUTE);
    expect(state.isComplete).toBe(false);
    expect(state.status).toBe('running');
  });

  it('rolls forward across several phases after a three-hour background gap', () => {
    const session = snapshot({ phases: encodePhases(pomodoro(8)) });
    const state = computeSessionState(session, NOW + 185 * MINUTE);

    // Six complete 30-minute cycles, then five minutes into the seventh focus.
    expect(state.phaseIndex).toBe(12);
    expect(state.phase).toEqual({ kind: 'focus', minutes: 25 });
    expect(state.phaseElapsedMs).toBe(5 * MINUTE);
    expect(state.phaseRemainingMs).toBe(20 * MINUTE);
    expect(state.totalRemainingMs).toBe(55 * MINUTE);
    expect(state.isComplete).toBe(false);
  });

  it('lands exactly on a phase boundary without overshooting', () => {
    const session = snapshot({ phases: encodePhases(pomodoro(8)) });
    const state = computeSessionState(session, NOW + 180 * MINUTE);

    expect(state.phaseIndex).toBe(12);
    expect(state.phaseElapsedMs).toBe(0);
    expect(state.phaseRemainingMs).toBe(25 * MINUTE);
  });

  it('reports the whole plan as complete once it has all elapsed', () => {
    const session = snapshot({ phases: encodePhases(pomodoro(2)) });
    const state = computeSessionState(session, NOW + 5 * 60 * MINUTE);

    expect(state.isComplete).toBe(true);
    expect(state.status).toBe('completed');
    expect(state.phaseIndex).toBe(3);
    expect(state.phaseRemainingMs).toBe(0);
    expect(state.totalRemainingMs).toBe(0);
  });

  it('excludes paused time from the elapsed calculation', () => {
    const session = snapshot({
      phases: encodePhases(pomodoro(8)),
      accumulatedPauseMs: 60 * MINUTE,
    });
    const state = computeSessionState(session, NOW + 185 * MINUTE);

    // 185 minutes of wall clock minus an hour of pause is 125 minutes of work.
    expect(state.phaseIndex).toBe(8);
    expect(state.phase.kind).toBe('focus');
    expect(state.phaseElapsedMs).toBe(5 * MINUTE);
  });

  it('freezes at pausedAt while paused, however long ago that was', () => {
    const session = snapshot({
      phases: encodePhases(pomodoro(4)),
      status: 'paused',
      pausedAt: NOW + 12 * MINUTE,
    });

    const soon = computeSessionState(session, NOW + 13 * MINUTE);
    const muchLater = computeSessionState(session, NOW + 5 * 60 * MINUTE);

    expect(soon).toEqual(muchLater);
    expect(soon.phaseIndex).toBe(0);
    expect(soon.phaseElapsedMs).toBe(12 * MINUTE);
    expect(soon.status).toBe('paused');
    expect(soon.isComplete).toBe(false);
  });

  it('consumes a zero-length break instantly', () => {
    const phases: SessionPhase[] = [
      { kind: 'focus', minutes: 1 },
      { kind: 'break', minutes: 0 },
      { kind: 'focus', minutes: 1 },
    ];
    const session = snapshot({ phases: encodePhases(phases) });

    const state = computeSessionState(session, NOW + MINUTE);
    expect(state.phaseIndex).toBe(2);
    expect(state.phase).toEqual({ kind: 'focus', minutes: 1 });
    expect(state.phaseElapsedMs).toBe(0);
    expect(state.totalRemainingMs).toBe(MINUTE);
  });

  it('completes a plan whose final phase has zero length', () => {
    const phases: SessionPhase[] = [
      { kind: 'focus', minutes: 1 },
      { kind: 'break', minutes: 0 },
    ];
    const state = computeSessionState(snapshot({ phases: encodePhases(phases) }), NOW + MINUTE);

    expect(state.phaseIndex).toBe(1);
    expect(state.isComplete).toBe(true);
    expect(state.totalRemainingMs).toBe(0);
  });

  it('starts from the stored phase index rather than the beginning', () => {
    const session = snapshot({
      phases: encodePhases(pomodoro(4)),
      phaseIndex: 2,
      phaseStartedAt: NOW,
    });
    const state = computeSessionState(session, NOW + MINUTE);

    expect(state.phaseIndex).toBe(2);
    expect(state.phaseElapsedMs).toBe(MINUTE);
  });

  it('treats a completed row as complete regardless of the clock', () => {
    const session = snapshot({
      phases: encodePhases(pomodoro(2)),
      status: 'completed',
      phaseIndex: 1,
      endedAt: NOW + 40 * MINUTE,
    });
    const state = computeSessionState(session, NOW + MINUTE);

    expect(state.isComplete).toBe(true);
    expect(state.phaseIndex).toBe(3);
    expect(state.totalRemainingMs).toBe(0);
  });

  it('freezes a cancelled session at the moment it ended', () => {
    const session = snapshot({
      phases: encodePhases(pomodoro(2)),
      status: 'cancelled',
      endedAt: NOW + 10 * MINUTE,
    });
    const state = computeSessionState(session, NOW + 10 * 60 * MINUTE);

    expect(state.status).toBe('cancelled');
    expect(state.isComplete).toBe(false);
    expect(state.phaseIndex).toBe(0);
    expect(state.phaseElapsedMs).toBe(10 * MINUTE);
  });

  it('refuses to decode a broken plan', () => {
    expect(() => parsePhases('[]')).toThrow(/at least one phase/i);
    expect(() => parsePhases('{oops')).toThrow(/unreadable/i);
    expect(() => parsePhases('[{"kind":"nap","minutes":5}]')).toThrow(/focus or a break/i);
    expect(() => parsePhases('[{"kind":"focus","minutes":-1}]')).toThrow(/duration in minutes/i);
  });
});

describe('focusMinutesDelivered', () => {
  it('counts only the focus phases that finished', () => {
    const session = snapshot({ phases: encodePhases(pomodoro(4)) });
    expect(focusMinutesDelivered(session, NOW + 10 * MINUTE)).toBe(0);
    expect(focusMinutesDelivered(session, NOW + 30 * MINUTE)).toBe(25);
    expect(focusMinutesDelivered(session, NOW + 65 * MINUTE)).toBe(50);
  });

  it('counts the whole plan for a completed session', () => {
    const session = snapshot({
      phases: encodePhases(pomodoro(2)),
      status: 'completed',
      endedAt: NOW + 60 * MINUTE,
    });
    expect(focusMinutesDelivered(session, NOW + 60 * MINUTE)).toBe(50);
  });
});

describe('focus sessions repository', () => {
  let t: TestDatabase;
  let repo: FocusSessionsRepository;
  let restoreClock: () => void;

  beforeEach(() => {
    restoreClock = freezeClock(NOW);
    t = createTestDatabase();
    repo = createFocusSessionsRepository(t.db);
  });

  afterEach(() => {
    restoreClock();
    t.close();
  });

  const start = () =>
    repo.create({ label: 'Physics revision', subject: 'Physics', phases: pomodoro(2) });

  it('stores the plan as JSON and starts running', async () => {
    const session = await start();

    expect(session.status).toBe('running');
    expect(session.phaseIndex).toBe(0);
    expect(session.phaseStartedAt).toBe(NOW);
    expect(session.startedAt).toBe(NOW);
    expect(session.accumulatedPauseMs).toBe(0);
    expect(parsePhases(session.phases)).toHaveLength(4);
  });

  it('rejects an empty plan', async () => {
    await expect(repo.create({ label: 'Nothing', phases: [] })).rejects.toThrow(
      /at least one phase/i,
    );
  });

  it('finds the active session, running or paused, newest first', async () => {
    expect(await repo.getActive()).toBeNull();

    const first = await start();
    setClock(() => NOW + MINUTE);
    const second = await start();

    expect((await repo.getActive())?.id).toBe(second.id);

    await repo.cancel(second.id);
    expect((await repo.getActive())?.id).toBe(first.id);

    await repo.pause(first.id);
    expect((await repo.getActive())?.id).toBe(first.id);

    await repo.complete(first.id);
    expect(await repo.getActive()).toBeNull();
  });

  describe('pause and resume', () => {
    it('accumulates paused time so the phase does not run down', async () => {
      const session = await start();

      const paused = await repo.pause(session.id, NOW + 10 * MINUTE);
      expect(paused.ok).toBe(true);
      if (!paused.ok) return;
      expect(paused.value.status).toBe('paused');
      expect(paused.value.pausedAt).toBe(NOW + 10 * MINUTE);

      const resumed = await repo.resume(session.id, NOW + 40 * MINUTE);
      if (!resumed.ok) throw new Error('expected ok');
      expect(resumed.value.status).toBe('running');
      expect(resumed.value.pausedAt).toBeNull();
      expect(resumed.value.accumulatedPauseMs).toBe(30 * MINUTE);

      const state = computeSessionState(resumed.value, NOW + 45 * MINUTE);
      expect(state.phaseIndex).toBe(0);
      expect(state.phaseElapsedMs).toBe(15 * MINUTE);
    });

    it('is a no-op when the session is already in that state', async () => {
      const session = await start();
      const resumed = await repo.resume(session.id, NOW + MINUTE);
      if (!resumed.ok) throw new Error('expected ok');
      expect(resumed.value.accumulatedPauseMs).toBe(0);

      await repo.pause(session.id, NOW + MINUTE);
      const again = await repo.pause(session.id, NOW + 5 * MINUTE);
      if (!again.ok) throw new Error('expected ok');
      expect(again.value.pausedAt).toBe(NOW + MINUTE);
    });

    it('reports not_found for an unknown session', async () => {
      const result = await repo.pause('nope');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('not_found');
    });
  });

  describe('advancePhase', () => {
    it('moves to the next phase and restarts the pause accounting', async () => {
      const session = await start();
      await repo.pause(session.id, NOW + 5 * MINUTE);
      await repo.resume(session.id, NOW + 15 * MINUTE);

      const advanced = await repo.advancePhase(session.id, NOW + 40 * MINUTE);
      if (!advanced.ok) throw new Error('expected ok');
      expect(advanced.value.phaseIndex).toBe(1);
      expect(advanced.value.phaseStartedAt).toBe(NOW + 40 * MINUTE);
      expect(advanced.value.accumulatedPauseMs).toBe(0);
      expect(advanced.value.status).toBe('running');
    });

    it('completes the session when the last phase is done', async () => {
      const session = await repo.create({
        label: 'Quick',
        phases: [{ kind: 'focus', minutes: 1 }],
      });

      const advanced = await repo.advancePhase(session.id, NOW + MINUTE);
      if (!advanced.ok) throw new Error('expected ok');
      expect(advanced.value.status).toBe('completed');
      expect(advanced.value.endedAt).toBe(NOW + MINUTE);
      expect(await repo.getActive()).toBeNull();
    });

    it('refuses to advance a finished session', async () => {
      const session = await start();
      await repo.cancel(session.id, NOW + MINUTE);

      const result = await repo.advancePhase(session.id, NOW + 2 * MINUTE);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('invalid_input');
    });
  });

  it('records the live activity handle', async () => {
    const session = await start();
    const linked = await repo.setLiveActivityId(session.id, 'activity-1');
    if (!linked.ok) throw new Error('expected ok');
    expect(linked.value.liveActivityId).toBe('activity-1');

    const cleared = await repo.setLiveActivityId(session.id, null);
    if (!cleared.ok) throw new Error('expected ok');
    expect(cleared.value.liveActivityId).toBeNull();
  });

  it('lists recent sessions newest first', async () => {
    const first = await start();
    setClock(() => NOW + 60 * MINUTE);
    const second = await start();

    const recent = await repo.listRecent(10);
    expect(recent.map((row) => row.id)).toEqual([second.id, first.id]);
    expect(await repo.listRecent(1)).toHaveLength(1);
  });

  it('totals delivered focus minutes inside a window', async () => {
    const completed = await start();
    await repo.complete(completed.id, NOW + 60 * MINUTE);

    setClock(() => NOW + 2 * 60 * MINUTE);
    const partial = await repo.create({ label: 'Half done', phases: pomodoro(2) });
    await repo.advancePhase(partial.id, NOW + 2 * 60 * MINUTE + 25 * MINUTE);

    setClock(() => NOW + 10 * 24 * 60 * MINUTE);
    const outside = await repo.create({ label: 'Much later', phases: pomodoro(1) });
    await repo.complete(outside.id, NOW + 10 * 24 * 60 * MINUTE + 30 * MINUTE);

    // Evaluated three minutes after the advance, while the second session is
    // still inside its first break.
    const total = await repo.totalFocusMinutesBetween(
      NOW,
      NOW + 24 * 60 * MINUTE,
      NOW + 2 * 60 * MINUTE + 28 * MINUTE,
    );
    // 50 from the completed pair of pomodoros, 25 from the single finished phase.
    expect(total).toBe(75);
  });

  it('credits phases a running session has silently rolled past', async () => {
    const session = await repo.create({ label: 'Left running', phases: pomodoro(2) });
    // Nothing advanced the row, but 60 minutes of the plan have gone by.
    expect(
      await repo.totalFocusMinutesBetween(NOW, NOW + 24 * 60 * MINUTE, NOW + 60 * MINUTE),
    ).toBe(50);
    expect(session.phaseIndex).toBe(0);
  });

  it('counts nothing for a window with no sessions', async () => {
    await start();
    expect(await repo.totalFocusMinutesBetween(NOW - 1000, NOW - 1)).toBe(0);
  });
});
