import { eq } from 'drizzle-orm';
import { freezeClock, resetClock } from '@/core/clock';
import { localToEpoch, setZoneOverride } from '@/core/time';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import { activityFeed } from '@/db/schema';
import { createHabitsRepository, type HabitsRepository } from '@/repositories/habits';

const ZONE = 'Europe/Sofia';

/** Puts "now" at noon on a local date, so the clock agrees with the calendar. */
function travelTo(date: string): void {
  freezeClock(localToEpoch(`${date}T12:00`, ZONE));
}

describe('habits repository', () => {
  let t: TestDatabase;
  let repo: HabitsRepository;

  beforeEach(() => {
    setZoneOverride(ZONE);
    t = createTestDatabase();
    repo = createHabitsRepository(t.db);
    travelTo('2026-03-10');
  });

  afterEach(() => {
    resetClock();
    setZoneOverride(null);
    t.close();
  });

  it('creates a habit once and matches its name case-insensitively', async () => {
    const created = await repo.getOrCreateHabit('Running', { unit: 'minutes', targetPerWeek: 3 });
    const again = await repo.getOrCreateHabit('  running  ');

    expect(again.id).toBe(created.id);
    expect(again.unit).toBe('minutes');
    expect(again.targetPerWeek).toBe(3);
    expect(await repo.listHabits()).toHaveLength(1);
  });

  it('writes an activity_feed row with the habit and the local date on every log', async () => {
    const { habit, entry, streak, streakChanged } = await repo.logHabit({
      habitName: 'running',
      durationMinutes: 32,
      note: 'easy 5k',
    });

    expect(streak).toBe(1);
    expect(streakChanged).toBe(true);
    expect(habit.lastCompletedDate).toBe('2026-03-10');
    expect(habit.longestStreak).toBe(1);
    expect(entry.habitId).toBe(habit.id);
    expect(entry.localDate).toBe('2026-03-10');
    expect(entry.durationMinutes).toBe(32);
    expect(entry.description).toBe('easy 5k');
  });

  it('falls back to the habit name when no note is given', async () => {
    const { entry } = await repo.logHabit({ habitName: 'Yoga' });
    expect(entry.description).toBe('Yoga');
  });

  it('does not double-count the streak when the same day is logged twice', async () => {
    await repo.logHabit({ habitName: 'running' });
    const second = await repo.logHabit({ habitName: 'running' });

    expect(second.streak).toBe(1);
    expect(second.streakChanged).toBe(false);
    expect(second.habit.longestStreak).toBe(1);

    // both logs are still recorded, the streak just did not move
    const entries = await t.db
      .select()
      .from(activityFeed)
      .where(eq(activityFeed.habitId, second.habit.id));
    expect(entries).toHaveLength(2);
  });

  it('increments on consecutive local days', async () => {
    await repo.logHabit({ habitName: 'running' });
    travelTo('2026-03-11');
    const second = await repo.logHabit({ habitName: 'running' });
    travelTo('2026-03-12');
    const third = await repo.logHabit({ habitName: 'running' });

    expect(second.streak).toBe(2);
    expect(third.streak).toBe(3);
    expect(third.habit.lastCompletedDate).toBe('2026-03-12');
  });

  it('resets to 1 after a gap of two or more local days and keeps the longest', async () => {
    await repo.logHabit({ habitName: 'running' });
    travelTo('2026-03-11');
    await repo.logHabit({ habitName: 'running' });
    travelTo('2026-03-12');
    await repo.logHabit({ habitName: 'running' });

    travelTo('2026-03-14'); // one day skipped
    const after = await repo.logHabit({ habitName: 'running' });

    expect(after.streak).toBe(1);
    expect(after.streakChanged).toBe(true);
    expect(after.habit.longestStreak).toBe(3);
  });

  it('survives a DST spring-forward: three consecutive Sofia days are a streak of three', async () => {
    // 2026-03-29 is 23 hours long in Sofia; a naive 24h day would break the chain.
    expect(
      localToEpoch('2026-03-30T00:00', ZONE) - localToEpoch('2026-03-29T00:00', ZONE),
    ).toBe(23 * 60 * 60 * 1000);

    travelTo('2026-03-28');
    await repo.logHabit({ habitName: 'running' });
    travelTo('2026-03-29');
    await repo.logHabit({ habitName: 'running' });
    travelTo('2026-03-30');
    const last = await repo.logHabit({ habitName: 'running' });

    expect(last.streak).toBe(3);
    expect(last.habit.longestStreak).toBe(3);
  });

  it('backfilling the previous day extends the streak instead of corrupting it', async () => {
    const first = await repo.logHabit({ habitName: 'running' });
    expect(first.streak).toBe(1);

    const backfilled = await repo.logHabit({ habitName: 'running', onDate: '2026-03-09' });

    expect(backfilled.streak).toBe(2);
    expect(backfilled.streakChanged).toBe(true);
    expect(backfilled.habit.longestStreak).toBe(2);
    expect(backfilled.habit.lastCompletedDate).toBe('2026-03-10');
    expect(backfilled.entry.localDate).toBe('2026-03-09');
  });

  it('backfilling a distant date does not inflate the current streak', async () => {
    await repo.logHabit({ habitName: 'running' });
    const old = await repo.logHabit({ habitName: 'running', onDate: '2026-02-01' });

    expect(old.streak).toBe(1);
    expect(old.streakChanged).toBe(false);
    expect(old.habit.lastCompletedDate).toBe('2026-03-10');
    expect(await repo.habitHistory(old.habit.id)).toEqual(['2026-02-01', '2026-03-10']);
  });

  it('backfilling a whole week in reverse rebuilds the full streak', async () => {
    await repo.logHabit({ habitName: 'reading' });
    for (const date of ['2026-03-09', '2026-03-07', '2026-03-08', '2026-03-06']) {
      await repo.logHabit({ habitName: 'reading', onDate: date });
    }

    const habit = (await repo.listHabits())[0]!;
    expect(habit.currentStreak).toBe(5);
    expect(habit.longestStreak).toBe(5);
    expect(habit.lastCompletedDate).toBe('2026-03-10');
  });

  it('recomputeStreak derives current and longest from the distinct dates in the feed', async () => {
    const habit = await repo.getOrCreateHabit('swimming');
    for (const date of ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-09', '2026-03-10']) {
      await repo.logHabit({ habitName: 'swimming', onDate: date });
    }
    // a duplicate day must not count twice
    await repo.logHabit({ habitName: 'swimming', onDate: '2026-03-10' });

    const recomputed = await repo.recomputeStreak(habit.id);
    expect(recomputed.currentStreak).toBe(2);
    expect(recomputed.longestStreak).toBe(3);
    expect(recomputed.lastCompletedDate).toBe('2026-03-10');

    // idempotent
    const again = await repo.recomputeStreak(habit.id);
    expect(again.currentStreak).toBe(2);
    expect(again.longestStreak).toBe(3);
  });

  it('derives the longest streak from the feed alone, not from the cached value', async () => {
    const habit = await repo.getOrCreateHabit('swimming');
    // Written straight to the feed, so `longest_streak` is still 0 and the only
    // possible source for it is the run scan.
    const dates = ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-09'];
    for (const date of dates) {
      await t.db.insert(activityFeed).values({
        id: `seed-${date}`,
        habitId: habit.id,
        description: 'swim',
        loggedAt: localToEpoch(`${date}T12:00`, ZONE),
        localDate: date,
        source: 'habit',
      });
    }

    const recomputed = await repo.recomputeStreak(habit.id);
    // The longest run is the early one, not the run the feed ends on.
    expect(recomputed.currentStreak).toBe(1);
    expect(recomputed.longestStreak).toBe(4);
  });

  it('does not create the habit when the log itself fails', async () => {
    t.client.execSync(`
      CREATE TRIGGER reject_boom BEFORE INSERT ON activity_feed
      WHEN NEW.description = 'boom'
      BEGIN SELECT RAISE(ABORT, 'boom'); END;
    `);

    await expect(repo.logHabit({ habitName: 'cold plunge', note: 'boom' })).rejects.toThrow();

    expect(await repo.listHabits({ includeArchived: true })).toHaveLength(0);
    expect(await t.db.select().from(activityFeed)).toHaveLength(0);
  });

  it('rejects a malformed backfill date', async () => {
    await expect(repo.logHabit({ habitName: 'running', onDate: '10/03/2026' })).rejects.toThrow(
      /YYYY-MM-DD/,
    );
  });

  it('returns the logged dates in a range for a streak grid', async () => {
    const habit = await repo.getOrCreateHabit('running');
    for (const date of ['2026-03-01', '2026-03-05', '2026-03-10']) {
      await repo.logHabit({ habitName: 'running', onDate: date });
    }

    expect(await repo.habitHistory(habit.id, { from: '2026-03-02', to: '2026-03-10' })).toEqual([
      '2026-03-05',
      '2026-03-10',
    ]);
    expect(await repo.habitHistory(habit.id, { to: '2026-03-04' })).toEqual(['2026-03-01']);
  });

  it('hides archived habits unless they are asked for', async () => {
    const running = await repo.getOrCreateHabit('running');
    await repo.getOrCreateHabit('reading');

    const archived = await repo.archiveHabit(running.id);
    expect(archived?.isArchived).toBe(true);

    expect((await repo.listHabits()).map((h) => h.name)).toEqual(['reading']);
    expect((await repo.listHabits({ includeArchived: true })).map((h) => h.name)).toEqual([
      'reading',
      'running',
    ]);
  });

  it('deleting a habit keeps what was actually done', async () => {
    const { habit } = await repo.logHabit({ habitName: 'running', note: 'hill repeats' });

    expect(await repo.deleteHabit(habit.id)).toBe(true);
    expect(await repo.deleteHabit(habit.id)).toBe(false);

    const entries = await t.db.select().from(activityFeed);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.habitId).toBeNull();
    expect(entries[0]!.description).toBe('hill repeats');
  });

  it('resolves a habit by voice and refuses to guess between two close names', async () => {
    await repo.getOrCreateHabit('running');
    await repo.getOrCreateHabit('reading');

    const hit = await repo.resolveHabit('runing');
    expect(hit.ok).toBe(true);
    if (hit.ok) expect(hit.value.name).toBe('running');

    const miss = await repo.resolveHabit('scuba diving');
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.error.code).toBe('not_found');

    await repo.getOrCreateHabit('reading fiction');
    const unclear = await repo.resolveHabit('reading');
    expect(unclear.ok).toBe(false);
    if (!unclear.ok) expect(unclear.error.code).toBe('ambiguous');
  });

  it('brings an archived habit back when it is logged again', async () => {
    const habit = await repo.getOrCreateHabit('Workout');
    await repo.archiveHabit(habit.id, true);
    expect((await repo.listHabits({})).map((h) => h.name)).not.toContain('Workout');

    // Archiving is the only exit from the list, so saying "logged a workout"
    // has to be the way back in — otherwise the log lands on a row nothing
    // renders and the streak grows where the user cannot see it.
    const logged = await repo.logHabit({ habitName: 'Workout' });
    expect(logged.habit.isArchived).toBe(false);
    expect((await repo.listHabits({})).map((h) => h.name)).toContain('Workout');
  });
});

describe('dailyHabitCounts', () => {
  let t: TestDatabase;
  let repo: HabitsRepository;

  beforeEach(() => {
    setZoneOverride(ZONE);
    t = createTestDatabase();
    repo = createHabitsRepository(t.db);
    travelTo('2026-03-10');
  });

  afterEach(() => {
    resetClock();
    setZoneOverride(null);
    t.close();
  });

  it('counts how many habits were kept on each day', async () => {
    await repo.logHabit({ habitName: 'Read', onDate: '2026-03-08' });
    await repo.logHabit({ habitName: 'Walk', onDate: '2026-03-08' });
    await repo.logHabit({ habitName: 'Read', onDate: '2026-03-10' });

    expect(await repo.dailyHabitCounts({ from: '2026-03-01', to: '2026-03-31' })).toEqual([
      { date: '2026-03-08', count: 2 },
      { date: '2026-03-10', count: 1 },
    ]);
  });

  /* The grid asks "how much of the day did you keep". Logging the same habit
     twice is enthusiasm, not progress, and counting it twice would darken a
     cell that should be half-lit. */
  it('counts a habit logged twice in a day once', async () => {
    await repo.logHabit({ habitName: 'Water', onDate: '2026-03-09' });
    await repo.logHabit({ habitName: 'Water', onDate: '2026-03-09' });

    expect(await repo.dailyHabitCounts({ from: '2026-03-09', to: '2026-03-09' })).toEqual([
      { date: '2026-03-09', count: 1 },
    ]);
  });

  /* Absent, not zero: the caller knows the range it asked for and can fill the
     gaps, and sending 90 zeroes would triple a payload that crosses a process
     boundary on every publish. */
  it('leaves days with nothing logged out of the result', async () => {
    await repo.logHabit({ habitName: 'Read', onDate: '2026-03-10' });

    const counts = await repo.dailyHabitCounts({ from: '2026-03-01', to: '2026-03-31' });

    expect(counts).toHaveLength(1);
    expect(counts[0]!.date).toBe('2026-03-10');
  });

  it('does not reach outside the range it was given', async () => {
    await repo.logHabit({ habitName: 'Read', onDate: '2026-02-27' });
    await repo.logHabit({ habitName: 'Read', onDate: '2026-03-10' });

    expect(await repo.dailyHabitCounts({ from: '2026-03-01', to: '2026-03-31' })).toEqual([
      { date: '2026-03-10', count: 1 },
    ]);
  });

  /* Activity entries can exist with no habit attached — a plain "spent an hour
     on the bench" is one. Those are not habits kept and must not light a cell. */
  it('ignores activity that is not a habit log', async () => {
    await t.db.insert(activityFeed).values({
      id: 'plain',
      habitId: null,
      description: 'Tidied the bench',
      loggedAt: localToEpoch('2026-03-09T18:00', ZONE),
      localDate: '2026-03-09',
      source: 'voice',
    });

    expect(await repo.dailyHabitCounts({ from: '2026-03-01', to: '2026-03-31' })).toEqual([]);
  });
});
