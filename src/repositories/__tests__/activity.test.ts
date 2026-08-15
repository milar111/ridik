import { freezeClock, resetClock } from '@/core/clock';
import { dayRange, localToEpoch, setZoneOverride } from '@/core/time';
import { newId } from '@/db/ids';
import { projects } from '@/db/schema';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import { createActivityRepository, type ActivityRepository } from '@/repositories/activity';
import { createHabitsRepository, type HabitsRepository } from '@/repositories/habits';

const ZONE = 'Europe/Sofia';
const at = (local: string): number => localToEpoch(local, ZONE);


describe('activity repository', () => {
  let t: TestDatabase;
  let repo: ActivityRepository;
  let habitsRepo: HabitsRepository;

  beforeEach(() => {
    setZoneOverride(ZONE);
    t = createTestDatabase();
    repo = createActivityRepository(t.db);
    habitsRepo = createHabitsRepository(t.db);
    freezeClock(at('2026-03-10T09:15'));
  });

  afterEach(() => {
    resetClock();
    setZoneOverride(null);
    t.close();
  });

  async function makeProject(name: string): Promise<string> {
    const id = newId();
    const stamp = at('2026-01-01T00:00');
    await t.db.insert(projects).values({ id, name, createdAt: stamp, updatedAt: stamp });
    return id;
  }

  describe('provenance', () => {
    it('records how the entry got here, defaulting to spoken', async () => {
      const spoken = await repo.log({ description: 'read a chapter' });
      const typed = await repo.log({ description: 'fixed the printer', source: 'manual' });

      const rows = t.client.getAllSync<{ description: string; source: string }>(
        'SELECT description, source FROM activity_feed',
        [],
      );
      const bySource = new Map(rows.map((r) => [r.description, r.source]));

      expect(spoken.description).toBe('read a chapter');
      expect(typed.description).toBe('fixed the printer');
      // The feed used to hardcode 'voice', so a typed entry claimed the user had
      // said it. Nothing reads this column yet; it is still the wrong fact to store.
      expect(bySource.get('read a chapter')).toBe('voice');
      expect(bySource.get('fixed the printer')).toBe('manual');
    });
  });

  it('stamps the local date from the epoch in the user zone', async () => {
    const entry = await repo.log({ description: 'Wrote the report', durationMinutes: 45 });

    expect(entry.loggedAt).toBe(at('2026-03-10T09:15'));
    expect(entry.localDate).toBe('2026-03-10');
    expect(entry.durationMinutes).toBe(45);
    expect(entry.habitId).toBeNull();
    expect(entry.projectId).toBeNull();
  });

  it('uses the supplied instant rather than the clock', async () => {
    const entry = await repo.log({ description: 'Late night fix', at: at('2026-03-08T23:50') });
    expect(entry.localDate).toBe('2026-03-08');
  });

  it('rejects an empty description', async () => {
    await expect(repo.log({ description: '   ' })).rejects.toThrow(/description/);
  });

  it('creates and links a habit, keeping its cached streak in step', async () => {
    await repo.log({ description: 'Ran 5k', habitName: 'running', at: at('2026-03-09T07:00') });
    await repo.log({ description: 'Ran 8k', habitName: 'Running', at: at('2026-03-10T07:00') });

    const habits = await habitsRepo.listHabits();
    expect(habits).toHaveLength(1);
    expect(habits[0]!.currentStreak).toBe(2);
    expect(habits[0]!.lastCompletedDate).toBe('2026-03-10');
    expect(await habitsRepo.habitHistory(habits[0]!.id)).toEqual(['2026-03-09', '2026-03-10']);
  });

  it('does not create the habit when the entry itself fails', async () => {
    await expect(
      repo.log({ description: 'Ran 5k', habitName: 'trail running', projectId: 'no-such-project' }),
    ).rejects.toThrow();

    expect(await habitsRepo.listHabits({ includeArchived: true })).toEqual([]);
    expect(await repo.listRecent()).toEqual([]);
  });

  it('lists a half-open epoch range in chronological order', async () => {
    await repo.log({ description: 'before', at: at('2026-03-09T23:59') });
    await repo.log({ description: 'first', at: at('2026-03-10T08:00') });
    await repo.log({ description: 'second', at: at('2026-03-10T18:00') });
    await repo.log({ description: 'after', at: at('2026-03-11T00:00') });

    const { start, end } = dayRange('2026-03-10', ZONE);
    const entries = await repo.listBetween(start, end);
    expect(entries.map((e) => e.description)).toEqual(['first', 'second']);
  });

  it('lists one local day and the most recent entries', async () => {
    await repo.log({ description: 'monday', at: at('2026-03-09T10:00') });
    await repo.log({ description: 'tuesday am', at: at('2026-03-10T08:00') });
    await repo.log({ description: 'tuesday pm', at: at('2026-03-10T20:00') });

    expect((await repo.listForLocalDate('2026-03-10')).map((e) => e.description)).toEqual([
      'tuesday am',
      'tuesday pm',
    ]);
    expect((await repo.listRecent(2)).map((e) => e.description)).toEqual([
      'tuesday pm',
      'tuesday am',
    ]);
  });

  it('buckets a summary by local date across a DST boundary', async () => {
    // Sofia springs forward at 03:00 on 2026-03-29, making that day 23 hours long.
    expect(at('2026-03-30T00:00') - at('2026-03-29T00:00')).toBe(23 * 60 * 60 * 1000);

    await repo.log({ description: 'late saturday', durationMinutes: 30, at: at('2026-03-28T23:30') });
    await repo.log({ description: 'before the jump', durationMinutes: 60, at: at('2026-03-29T02:30') });
    await repo.log({ description: 'after the jump', durationMinutes: 15, at: at('2026-03-29T04:30') });
    await repo.log({ description: 'early monday', durationMinutes: 10, at: at('2026-03-30T00:30') });

    const summary = await repo.summarise({ from: '2026-03-28', to: '2026-03-30' });

    expect(summary.byDay.map((d) => [d.date, d.entries.length, d.minutes])).toEqual([
      ['2026-03-28', 1, 30],
      ['2026-03-29', 2, 75],
      ['2026-03-30', 1, 10],
    ]);
    expect(summary.byDay[1]!.entries.map((e) => e.description)).toEqual([
      'before the jump',
      'after the jump',
    ]);
    expect(summary.totalMinutes).toBe(115);
    expect(summary.entries).toHaveLength(4);
  });

  it('groups a summary by project and habit, with names and minutes', async () => {
    const thesis = await makeProject('Thesis');

    await repo.log({
      description: 'Chapter 2',
      durationMinutes: 90,
      projectId: thesis,
      at: at('2026-03-09T10:00'),
    });
    await repo.log({
      description: 'Chapter 3',
      durationMinutes: 30,
      projectId: thesis,
      at: at('2026-03-10T10:00'),
    });
    await habitsRepo.logHabit({ habitName: 'running', durationMinutes: 40, onDate: '2026-03-10' });
    await repo.log({ description: 'Unfiled admin', at: at('2026-03-10T16:00') });

    const summary = await repo.summarise({ from: '2026-03-09', to: '2026-03-10' });

    expect(summary.totalMinutes).toBe(160);
    expect(summary.byProject).toEqual([
      { id: thesis, name: 'Thesis', count: 2, minutes: 120 },
    ]);
    expect(summary.byHabit).toEqual([
      { id: expect.any(String), name: 'running', count: 1, minutes: 40 },
    ]);
    expect(summary.byDay.map((d) => d.date)).toEqual(['2026-03-09', '2026-03-10']);
  });

  it('excludes entries outside the summary range and validates the range', async () => {
    await repo.log({ description: 'inside', at: at('2026-03-10T10:00') });
    await repo.log({ description: 'outside', at: at('2026-03-12T10:00') });

    const summary = await repo.summarise({ from: '2026-03-09', to: '2026-03-11' });
    expect(summary.entries.map((e) => e.description)).toEqual(['inside']);

    await expect(repo.summarise({ from: 'last monday', to: '2026-03-11' })).rejects.toThrow(
      /YYYY-MM-DD/,
    );
    await expect(repo.summarise({ from: '2026-03-11', to: '2026-03-09' })).rejects.toThrow(
      /starts after/,
    );
  });

  it('summarises an empty range without inventing days', async () => {
    const summary = await repo.summarise({ from: '2026-01-01', to: '2026-01-07' });
    expect(summary).toEqual({
      entries: [],
      totalMinutes: 0,
      byDay: [],
      byProject: [],
      byHabit: [],
    });
  });

  it('removes an entry by id', async () => {
    const entry = await repo.log({ description: 'typo' });

    expect(await repo.removeEntry(entry.id)).toBe(true);
    expect(await repo.removeEntry(entry.id)).toBe(false);
    expect(await repo.listRecent()).toHaveLength(0);
  });
});
