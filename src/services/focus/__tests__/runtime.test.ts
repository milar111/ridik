import { resetClock, setClock } from '@/core/clock';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import {
  createFocusSessionsRepository,
  parsePhases,
  type FocusSessionsRepository,
} from '@/repositories/focusSessions';

import {
  buildPhases,
  createFocusRuntime,
  plannedTransitions,
  type ChimeKind,
  type FocusRuntime,
  type FocusSnapshot,
  type PlannedTransition,
} from '../runtime';

const NOW = 1_780_000_000_000;
const MINUTE = 60_000;

let clockAt = NOW;
const atTime = (offsetMs: number): number => {
  clockAt = NOW + offsetMs;
  return clockAt;
};

type Harness = {
  db: TestDatabase;
  repo: FocusSessionsRepository;
  runtime: FocusRuntime;
  surface: { start: FocusSnapshot[]; update: FocusSnapshot[]; end: (FocusSnapshot | null)[] };
  schedules: PlannedTransition[][];
  cancels: string[];
  chimes: ChimeKind[];
  emissions: (FocusSnapshot | null)[];
  isTicking(): boolean;
  fireTick(): Promise<void>;
  lastSchedule(): PlannedTransition[];
};

function createHarness(existing?: TestDatabase): Harness {
  const db = existing ?? createTestDatabase();
  const repo = createFocusSessionsRepository(db.db);
  const surface: Harness['surface'] = { start: [], update: [], end: [] };
  const schedules: PlannedTransition[][] = [];
  const cancels: string[] = [];
  const chimes: ChimeKind[] = [];
  const emissions: (FocusSnapshot | null)[] = [];
  let ticking = false;

  const runtime = createFocusRuntime({
    repository: repo,
    surface: {
      start: (snapshot) => void surface.start.push(snapshot),
      update: (snapshot) => void surface.update.push(snapshot),
      end: (snapshot) => void surface.end.push(snapshot),
    },
    scheduler: {
      schedule: (transitions) => void schedules.push([...transitions]),
      cancel: (sessionId) => void cancels.push(sessionId),
    },
    chime: (kind) => void chimes.push(kind),
    ticker: () => {
      ticking = true;
      return () => {
        ticking = false;
      };
    },
  });

  runtime.subscribe((snapshot) => void emissions.push(snapshot));

  return {
    db,
    repo,
    runtime,
    surface,
    schedules,
    cancels,
    chimes,
    emissions,
    isTicking: () => ticking,
    fireTick: () => runtime.tick(),
    lastSchedule: () => schedules[schedules.length - 1] ?? [],
  };
}

const pomodoroPlan = {
  label: 'Physics revision',
  subject: 'Physics',
  focusMinutes: 25,
  breakMinutes: 5,
};

describe('buildPhases', () => {
  it('defaults to a single pomodoro', () => {
    expect(buildPhases({ label: 'Read' })).toEqual([{ kind: 'focus', minutes: 25 }]);
  });

  it('never ends the plan on a break', () => {
    expect(buildPhases({ ...pomodoroPlan, cycles: 3 })).toEqual([
      { kind: 'focus', minutes: 25 },
      { kind: 'break', minutes: 5 },
      { kind: 'focus', minutes: 25 },
      { kind: 'break', minutes: 5 },
      { kind: 'focus', minutes: 25 },
    ]);
  });

  it('fits the cycles inside a total budget without overrunning it', () => {
    expect(buildPhases({ ...pomodoroPlan, totalMinutes: 60 })).toEqual([
      { kind: 'focus', minutes: 25 },
      { kind: 'break', minutes: 5 },
      { kind: 'focus', minutes: 25 },
    ]);
    expect(buildPhases({ ...pomodoroPlan, totalMinutes: 20 })).toEqual([
      { kind: 'focus', minutes: 25 },
    ]);
  });

  it('stretches the break every nth cycle when a long break is asked for', () => {
    const phases = buildPhases({
      ...pomodoroPlan,
      cycles: 3,
      longBreakMinutes: 20,
      cyclesBeforeLongBreak: 2,
    });
    expect(phases.map((p) => p.minutes)).toEqual([25, 5, 25, 20, 25]);
  });

  it('drops a zero-minute break rather than storing an empty phase', () => {
    expect(buildPhases({ label: 'Sprint', cycles: 2, breakMinutes: 0 })).toEqual([
      { kind: 'focus', minutes: 25 },
      { kind: 'focus', minutes: 25 },
    ]);
  });
});

describe('focus runtime', () => {
  let h: Harness;

  beforeEach(() => {
    clockAt = NOW;
    setClock(() => clockAt);
    h = createHarness();
  });

  afterEach(() => {
    h.runtime.dispose();
    h.db.close();
    resetClock();
  });

  const start = () => h.runtime.startPlan({ ...pomodoroPlan, cycles: 2 });

  const activeRow = async () => {
    const row = await h.repo.getActive();
    if (!row) throw new Error('expected an active session');
    return row;
  };

  describe('starting a plan', () => {
    it('persists the phases and drives them', async () => {
      const started = await start();
      if (!started.ok) throw new Error(started.error.message);

      const row = await activeRow();
      expect(parsePhases(row.phases)).toEqual([
        { kind: 'focus', minutes: 25 },
        { kind: 'break', minutes: 5 },
        { kind: 'focus', minutes: 25 },
      ]);
      expect(row.status).toBe('running');
      expect(row.phaseIndex).toBe(0);
      expect(row.phaseStartedAt).toBe(NOW);
      expect(row.subject).toBe('Physics');

      expect(started.value.phaseCount).toBe(3);
      expect(started.value.phaseRemainingMs).toBe(25 * MINUTE);
      expect(started.value.phaseEndsAt).toBe(NOW + 25 * MINUTE);
      expect(started.value.clock).toBe('25:00');
      expect(h.surface.start).toHaveLength(1);
      expect(h.isTicking()).toBe(true);
    });

    it('schedules every remaining boundary as a dated alarm', async () => {
      await start();

      expect(h.lastSchedule().map((t) => [t.at - NOW, t.kind, t.phaseIndex])).toEqual([
        [25 * MINUTE, 'break', 1],
        [30 * MINUTE, 'focus', 2],
        [55 * MINUTE, 'complete', 2],
      ]);
    });

    it('caps the chain so a long plan cannot fill the notification budget', async () => {
      await h.runtime.startPlan({ ...pomodoroPlan, cycles: 12 });
      const chain = h.lastSchedule();

      expect(chain).toHaveLength(8);
      expect(chain.every((t) => t.kind !== 'complete')).toBe(true);
      expect(chain[0]!.at).toBe(NOW + 25 * MINUTE);
      expect(chain[1]!.at).toBe(NOW + 30 * MINUTE);
    });

    it('cancels the session it displaces', async () => {
      const first = await start();
      if (!first.ok) throw new Error('expected ok');

      atTime(MINUTE);
      await h.runtime.startPlan({ label: 'Something else', cycles: 1 });

      const displaced = await h.repo.getById(first.value.sessionId);
      expect(displaced?.status).toBe('cancelled');
      expect((await activeRow()).label).toBe('Something else');
    });

    it('is a no-op when the same session is started twice', async () => {
      const started = await start();
      if (!started.ok) throw new Error('expected ok');

      const again = await h.runtime.start(started.value.sessionId);
      expect(again.ok).toBe(true);
      expect(h.surface.start).toHaveLength(1);
      expect((await activeRow()).status).toBe('running');
    });

    it('refuses a session that has already finished', async () => {
      const started = await start();
      if (!started.ok) throw new Error('expected ok');
      await h.runtime.stop();

      const restarted = await h.runtime.start(started.value.sessionId);
      expect(restarted.ok).toBe(false);
      if (restarted.ok) return;
      expect(restarted.error.code).toBe('invalid_input');
    });
  });

  describe('ticking', () => {
    it('recomputes without touching the row inside a phase', async () => {
      await start();
      atTime(10 * MINUTE);
      await h.fireTick();

      expect((await activeRow()).phaseIndex).toBe(0);
      expect(h.chimes).toEqual([]);
      expect(h.runtime.getSnapshot()?.clock).toBe('15:00');
      expect(h.surface.update.at(-1)?.phaseRemainingMs).toBe(15 * MINUTE);
    });

    it('advances at the boundary, not at the moment the tick arrived', async () => {
      await start();
      // A tick that lands 1.5s late must not push the rest of the plan back.
      atTime(25 * MINUTE + 1_500);
      await h.fireTick();

      const row = await activeRow();
      expect(row.phaseIndex).toBe(1);
      expect(row.phaseStartedAt).toBe(NOW + 25 * MINUTE);
      expect(h.chimes).toEqual(['break']);
      expect(h.lastSchedule().map((t) => t.at - NOW)).toEqual([30 * MINUTE, 55 * MINUTE]);
    });

    it('rolls across every phase a stalled thread slept through, in silence', async () => {
      await h.runtime.startPlan({ ...pomodoroPlan, cycles: 8 });
      atTime(185 * MINUTE);
      await h.fireTick();

      const row = await activeRow();
      // Six full 30-minute cycles, then five minutes into the seventh focus.
      expect(row.phaseIndex).toBe(12);
      expect(row.phaseStartedAt).toBe(NOW + 180 * MINUTE);
      expect(row.accumulatedPauseMs).toBe(0);
      // The notifications announced those phases hours ago; chiming now would
      // be a jump scare.
      expect(h.chimes).toEqual([]);
    });

    it('completes the session when the plan runs out', async () => {
      await h.runtime.startPlan({ label: 'Quick', cycles: 1, focusMinutes: 1 });
      atTime(MINUTE + 200);
      await h.fireTick();

      const row = await h.repo.listRecent(1);
      expect(row[0]?.status).toBe('completed');
      expect(row[0]?.endedAt).toBe(NOW + MINUTE);
      expect(await h.repo.getActive()).toBeNull();
      expect(h.chimes).toEqual(['complete']);
      expect(h.surface.end).toHaveLength(1);
      expect(h.isTicking()).toBe(false);
      expect(h.runtime.getSnapshot()?.isComplete).toBe(true);
    });
  });

  describe('rehydration', () => {
    it('picks a running session up mid-phase three hours later', async () => {
      await h.runtime.startPlan({ ...pomodoroPlan, cycles: 8 });
      const revived = createHarness(h.db);
      try {
        atTime(185 * MINUTE);
        const snapshot = await revived.runtime.rehydrate();

        expect(snapshot?.phaseIndex).toBe(12);
        expect(snapshot?.phase).toEqual({ kind: 'focus', minutes: 25 });
        expect(snapshot?.phaseRemainingMs).toBe(20 * MINUTE);
        expect(snapshot?.status).toBe('running');
        expect((await activeRow()).phaseIndex).toBe(12);
        expect(revived.surface.start).toHaveLength(1);
        expect(revived.isTicking()).toBe(true);
        expect(revived.lastSchedule()[0]?.at).toBe(NOW + 205 * MINUTE);
      } finally {
        revived.runtime.dispose();
      }
    });

    it('completes a session whose plan ran out while the app was gone', async () => {
      await h.runtime.startPlan({ ...pomodoroPlan, cycles: 2 });
      const revived = createHarness(h.db);
      try {
        atTime(3 * 60 * MINUTE);
        const snapshot = await revived.runtime.rehydrate();

        expect(snapshot?.isComplete).toBe(true);
        expect(snapshot?.status).toBe('completed');
        expect(await h.repo.getActive()).toBeNull();
        expect(revived.isTicking()).toBe(false);
        expect(revived.surface.end).toHaveLength(1);
      } finally {
        revived.runtime.dispose();
      }
    });

    it('honours a paused session instead of running it forward', async () => {
      await start();
      atTime(10 * MINUTE);
      await h.runtime.pause();

      const revived = createHarness(h.db);
      try {
        atTime(4 * 60 * MINUTE);
        const snapshot = await revived.runtime.rehydrate();

        expect(snapshot?.status).toBe('paused');
        expect(snapshot?.phaseIndex).toBe(0);
        expect(snapshot?.phaseElapsedMs).toBe(10 * MINUTE);
        expect(revived.isTicking()).toBe(false);
        expect(revived.lastSchedule()).toEqual([]);
      } finally {
        revived.runtime.dispose();
      }
    });

    it('reports nothing when there is no session to resume', async () => {
      expect(await h.runtime.rehydrate()).toBeNull();
      expect(h.surface.start).toHaveLength(0);
    });
  });

  describe('pause and resume', () => {
    it('excludes the paused stretch from the phase', async () => {
      const started = await start();
      if (!started.ok) throw new Error('expected ok');

      atTime(10 * MINUTE);
      const paused = await h.runtime.pause();
      if (!paused.ok) throw new Error('expected ok');
      expect(paused.value.status).toBe('paused');
      expect(paused.value.phaseRemainingMs).toBe(15 * MINUTE);
      expect(paused.value.phaseEndsAt).toBeNull();
      expect(h.isTicking()).toBe(false);
      expect(h.cancels).toContain(started.value.sessionId);
      expect(h.lastSchedule()).toEqual([]);

      atTime(40 * MINUTE);
      const resumed = await h.runtime.resume();
      if (!resumed.ok) throw new Error('expected ok');
      expect((await activeRow()).accumulatedPauseMs).toBe(30 * MINUTE);
      expect(resumed.value.phaseRemainingMs).toBe(15 * MINUTE);
      expect(h.isTicking()).toBe(true);
      // The rest of the plan slides by the half hour that was not worked.
      expect(h.lastSchedule().map((t) => t.at - NOW)).toEqual([
        55 * MINUTE,
        60 * MINUTE,
        85 * MINUTE,
      ]);

      atTime(45 * MINUTE);
      await h.fireTick();
      expect(h.runtime.getSnapshot()?.phaseElapsedMs).toBe(15 * MINUTE);
      expect((await activeRow()).phaseIndex).toBe(0);

      atTime(55 * MINUTE);
      await h.fireTick();
      expect((await activeRow()).phaseIndex).toBe(1);
    });

    it('survives being paused or resumed twice', async () => {
      await start();

      atTime(10 * MINUTE);
      await h.runtime.pause();
      atTime(12 * MINUTE);
      await h.runtime.pause();
      expect((await activeRow()).pausedAt).toBe(NOW + 10 * MINUTE);

      atTime(20 * MINUTE);
      await h.runtime.resume();
      atTime(30 * MINUTE);
      await h.runtime.resume();
      expect((await activeRow()).accumulatedPauseMs).toBe(10 * MINUTE);
    });

    it('completes a plan that ran out rather than freezing it as paused', async () => {
      await h.runtime.startPlan({ label: 'Quick', cycles: 1, focusMinutes: 25 });
      h.runtime.setForeground(false);

      // The Pause button on a notification the session already outlived.
      atTime(40 * MINUTE);
      const paused = await h.runtime.pause();

      expect(paused.ok).toBe(false);
      // A paused row is still "active": left behind, it would sit at 00:00 in
      // every future rehydration and never finish.
      expect(await h.repo.getActive()).toBeNull();
      expect((await h.repo.listRecent(1))[0]?.status).toBe('completed');
    });

    it('reports there is nothing to pause when idle', async () => {
      const result = await h.runtime.pause();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('not_found');
    });
  });

  describe('skipping', () => {
    it('advances exactly one phase, from now', async () => {
      await start();
      atTime(2 * MINUTE);
      const skipped = await h.runtime.skipPhase();
      if (!skipped.ok) throw new Error('expected ok');

      const row = await activeRow();
      expect(row.phaseIndex).toBe(1);
      expect(row.phaseStartedAt).toBe(NOW + 2 * MINUTE);
      expect(skipped.value.phase).toEqual({ kind: 'break', minutes: 5 });
      // Whoever pressed Skip does not need to be told the phase changed.
      expect(h.chimes).toEqual([]);
      expect(h.lastSchedule().map((t) => t.at - NOW)).toEqual([7 * MINUTE, 32 * MINUTE]);

      await h.runtime.skipPhase();
      expect((await activeRow()).phaseIndex).toBe(2);
    });

    it('advances from the phase the clock is in, not the one we last saw', async () => {
      // Skip arrives from the notification button with the app in the
      // background, so the held row is however many phases out of date.
      await h.runtime.startPlan({ ...pomodoroPlan, cycles: 3 });
      h.runtime.setForeground(false);

      atTime(56 * MINUTE);
      const skipped = await h.runtime.skipPhase();
      if (!skipped.ok) throw new Error(skipped.error.message);

      // 0-25 focus, 25-30 break, 30-55 focus, 55-60 break: skipping the break
      // must land on the last focus block, never back on the first one.
      expect((await activeRow()).phaseIndex).toBe(4);
      expect(skipped.value.phase).toEqual({ kind: 'focus', minutes: 25 });
    });

    it('finishes the session when the last phase is skipped', async () => {
      await h.runtime.startPlan({ label: 'Quick', cycles: 1 });
      atTime(MINUTE);
      const skipped = await h.runtime.skipPhase();
      if (!skipped.ok) throw new Error('expected ok');

      expect(skipped.value.status).toBe('completed');
      expect(await h.repo.getActive()).toBeNull();
      expect(h.surface.end).toHaveLength(1);
      expect(h.isTicking()).toBe(false);
    });
  });

  describe('stopping', () => {
    it('marks the session cancelled and clears the surface', async () => {
      const started = await start();
      if (!started.ok) throw new Error('expected ok');

      atTime(3 * MINUTE);
      const stopped = await h.runtime.stop();
      if (!stopped.ok) throw new Error('expected ok');

      const row = await h.repo.getById(started.value.sessionId);
      expect(row?.status).toBe('cancelled');
      expect(row?.endedAt).toBe(NOW + 3 * MINUTE);
      expect(await h.repo.getActive()).toBeNull();
      expect(stopped.value?.status).toBe('cancelled');
      expect(h.surface.end).toHaveLength(1);
      expect(h.cancels).toContain(started.value.sessionId);
      expect(h.isTicking()).toBe(false);
    });

    it('logs a plan that ran out while the app was away as finished, not cancelled', async () => {
      const started = await h.runtime.startPlan({ label: 'Quick', cycles: 1, focusMinutes: 25 });
      if (!started.ok) throw new Error('expected ok');
      h.runtime.setForeground(false);

      atTime(40 * MINUTE);
      await h.runtime.stop();

      expect((await h.repo.getById(started.value.sessionId))?.status).toBe('completed');
    });

    it('is quiet when there is nothing to stop', async () => {
      await start();
      atTime(3 * MINUTE);
      await h.runtime.stop();

      const again = await h.runtime.stop();
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.value).toBeNull();
      expect(h.surface.end).toHaveLength(1);
      expect(h.runtime.getSnapshot()).toBeNull();
    });
  });

  describe('subscribers', () => {
    it('receives the current value on subscribe and on every change', async () => {
      const seen: (FocusSnapshot | null)[] = [];
      const unsubscribe = h.runtime.subscribe((snapshot) => seen.push(snapshot));
      expect(seen).toEqual([null]);

      await start();
      atTime(MINUTE);
      await h.fireTick();
      expect(seen.length).toBeGreaterThan(1);
      expect(seen.at(-1)?.clock).toBe('24:00');

      unsubscribe();
      atTime(2 * MINUTE);
      await h.fireTick();
      expect(seen.at(-1)?.clock).toBe('24:00');
    });

    it('keeps ticking when a subscriber throws', async () => {
      h.runtime.subscribe(() => {
        throw new Error('render blew up');
      });
      await start();
      atTime(MINUTE);
      await expect(h.fireTick()).resolves.toBeUndefined();
      expect(h.runtime.getSnapshot()?.clock).toBe('24:00');
    });
  });

  describe('failure', () => {
    it('swallows a broken reconciliation instead of rejecting into the ticker', async () => {
      // Nothing awaits the ticker's tick, so a throw in here — a database
      // closed under us — must not surface as an unhandled rejection a second.
      await h.runtime.startPlan({ label: 'Doomed', cycles: 1, focusMinutes: 1 });
      h.db.close();

      atTime(2 * MINUTE);
      await expect(h.fireTick()).resolves.toBeUndefined();

      // Reopen so the shared afterEach teardown has something to close.
      h.db = createTestDatabase();
    });
  });

  describe('foregrounding', () => {
    it('stops the ticker in the background and catches up on return', async () => {
      await start();
      h.runtime.setForeground(false);
      expect(h.isTicking()).toBe(false);

      atTime(26 * MINUTE);
      h.runtime.setForeground(true);
      await h.fireTick();

      expect((await activeRow()).phaseIndex).toBe(1);
      expect(h.isTicking()).toBe(true);
    });
  });
});

describe('plannedTransitions', () => {
  let db: TestDatabase;
  let repo: FocusSessionsRepository;

  beforeEach(() => {
    clockAt = NOW;
    setClock(() => clockAt);
    db = createTestDatabase();
    repo = createFocusSessionsRepository(db.db);
  });

  afterEach(() => {
    db.close();
    resetClock();
  });

  it('describes each boundary in the words the notification will use', async () => {
    const session = await repo.create({
      label: 'Physics revision',
      phases: [
        { kind: 'focus', minutes: 25 },
        { kind: 'break', minutes: 5 },
      ],
    });

    expect(plannedTransitions(session, NOW)).toEqual([
      {
        sessionId: session.id,
        at: NOW + 25 * MINUTE,
        kind: 'break',
        phaseIndex: 1,
        title: 'Break time',
        body: 'Physics revision — 5 minute break.',
      },
      {
        sessionId: session.id,
        at: NOW + 30 * MINUTE,
        kind: 'complete',
        phaseIndex: 1,
        title: 'Session finished',
        body: 'Physics revision is done.',
      },
    ]);
  });

  it('measures from the phase that is actually running, not from the start', async () => {
    const session = await repo.create({
      label: 'Deep work',
      phases: [
        { kind: 'focus', minutes: 25 },
        { kind: 'break', minutes: 5 },
        { kind: 'focus', minutes: 25 },
      ],
    });

    expect(plannedTransitions(session, NOW + 10 * MINUTE).map((t) => t.at - NOW)).toEqual([
      25 * MINUTE,
      30 * MINUTE,
      55 * MINUTE,
    ]);
  });

  it('has nothing to schedule for a paused or finished session', async () => {
    const session = await repo.create({
      label: 'Paused',
      phases: [{ kind: 'focus', minutes: 25 }],
    });
    const paused = await repo.pause(session.id, NOW + MINUTE);
    if (!paused.ok) throw new Error('expected ok');

    expect(plannedTransitions(paused.value, NOW + 2 * MINUTE)).toEqual([]);

    const cancelled = await repo.cancel(session.id, NOW + 3 * MINUTE);
    if (!cancelled.ok) throw new Error('expected ok');
    expect(plannedTransitions(cancelled.value, NOW + 4 * MINUTE)).toEqual([]);
  });
});
