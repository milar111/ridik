import { freezeClock } from '@/core/clock';
import { epochToLocal, localToEpoch, setZoneOverride } from '@/core/time';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import {
  createCurriculumRepository,
  type CurriculumEntryInput,
  type CurriculumRepository,
} from '@/repositories/curriculum';

const ZONE = 'Europe/Sofia';
const HOUR = 3_600_000;

/** Wall clock in the test zone -> epoch ms. */
const at = (local: string) => localToEpoch(local, ZONE);

/**
 * March 2026 in Sofia: 2026-03-04 is a Wednesday in ISO week 10 (even), and the
 * clocks go forward on Sunday 2026-03-29.
 */
const WEDNESDAY = at('2026-03-04T12:00');

const TIMETABLE: CurriculumEntryInput[] = [
  { subject_name: 'Math', day_of_week: 1, start_time: '08:00', end_time: '09:30' },
  { subject_name: 'Math', day_of_week: 4, start_time: '10:00', end_time: '11:30' },
  {
    subject_name: 'Physics',
    day_of_week: 2,
    start_time: '09:00',
    end_time: '10:30',
    location: 'Lab 2',
    teacher: 'Petrova',
  },
  {
    subject_name: 'History',
    day_of_week: 5,
    start_time: '13:00',
    end_time: '14:00',
    week_parity: 'odd',
  },
];

describe('curriculum repository', () => {
  let t: TestDatabase;
  let repo: CurriculumRepository;
  const restores: Array<() => void> = [];

  beforeEach(() => {
    t = createTestDatabase();
    repo = createCurriculumRepository(t.db);
  });

  afterEach(() => {
    while (restores.length) restores.pop()!();
    setZoneOverride(null);
    t.close();
  });

  /* ------------------------------------------------------------- storage -- */

  it('replaces the whole timetable atomically', async () => {
    await repo.replaceAll(TIMETABLE);
    expect(await repo.listEntries()).toHaveLength(4);

    const replaced = await repo.replaceAll([
      { subject_name: 'Chemistry', day_of_week: 3, start_time: '11:00', end_time: '12:00' },
    ]);
    expect(replaced).toHaveLength(1);

    const rows = await repo.listEntries();
    expect(rows.map((r) => r.subjectName)).toEqual(['Chemistry']);
    expect(rows[0]!.weekParity).toBe('every');
    expect(rows[0]!.isActive).toBe(true);
  });

  it('leaves the stored timetable intact when a new entry is invalid', async () => {
    await repo.replaceAll(TIMETABLE);
    await expect(
      repo.replaceAll([
        { subject_name: 'Chemistry', day_of_week: 3, start_time: '11:00', end_time: '12:00' },
        { subject_name: 'Broken', day_of_week: 9, start_time: '11:00', end_time: '12:00' },
      ]),
    ).rejects.toThrow(/day of the week/);
    expect(await repo.listEntries()).toHaveLength(4);
  });

  it('appends entries and lists them day-then-time ordered', async () => {
    await repo.addEntries(TIMETABLE);
    await repo.addEntries([
      { subject_name: 'Art', day_of_week: 1, start_time: '07:00', end_time: '07:45' },
    ]);

    const rows = await repo.listEntries();
    expect(rows.map((r) => `${r.dayOfWeek} ${r.startTime} ${r.subjectName}`)).toEqual([
      '1 07:00 Art',
      '1 08:00 Math',
      '2 09:00 Physics',
      '4 10:00 Math',
      '5 13:00 History',
    ]);
  });

  it('returns a single day and hides deactivated entries by default', async () => {
    await repo.replaceAll(TIMETABLE);
    const thursday = await repo.entriesForDay(4);
    expect(thursday.map((e) => e.subjectName)).toEqual(['Math']);

    await repo.updateEntry(thursday[0]!.id, { isActive: false });
    expect(await repo.entriesForDay(4)).toHaveLength(0);
    expect(await repo.entriesForDay(4, { activeOnly: false })).toHaveLength(1);
    expect(await repo.listEntries({ activeOnly: true })).toHaveLength(3);
  });

  it('updates and deletes single entries', async () => {
    const [entry] = await repo.addEntries([
      { subject_name: 'Math', day_of_week: 1, start_time: '08:00', end_time: '09:30' },
    ]);

    const updated = await repo.updateEntry(entry!.id, { startTime: '08:30', location: 'Room 4' });
    expect(updated.ok && updated.value.startTime).toBe('08:30');
    expect(updated.ok && updated.value.location).toBe('Room 4');

    await expect(repo.updateEntry(entry!.id, { startTime: '25:00' })).rejects.toThrow(
      /not a time of day/,
    );

    const missing = await repo.updateEntry('nope', { location: 'x' });
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.error.code).toBe('not_found');

    expect(await repo.deleteEntry(entry!.id)).toBe(true);
    expect(await repo.deleteEntry(entry!.id)).toBe(false);
  });

  it('will not blank out a subject name on update', async () => {
    const [entry] = await repo.addEntries([
      { subject_name: 'Math', day_of_week: 1, start_time: '08:00', end_time: '09:30' },
    ]);

    await expect(repo.updateEntry(entry!.id, { subjectName: '   ' })).rejects.toThrow(
      /needs a subject name/,
    );

    const renamed = await repo.updateEntry(entry!.id, { subjectName: '  Algebra  ' });
    expect(renamed.ok && renamed.value.subjectName).toBe('Algebra');
    // A row that kept its name stays reachable by voice.
    const resolved = await repo.resolveSubject('algebra');
    expect(resolved.ok && resolved.value).toBe('Algebra');
  });

  /* ------------------------------------------------------------ subjects -- */

  it('lists distinct subjects, de-duplicated case-insensitively', async () => {
    await repo.addEntries([
      ...TIMETABLE,
      { subject_name: 'math', day_of_week: 3, start_time: '15:00', end_time: '16:00' },
    ]);
    expect(await repo.distinctSubjects()).toEqual(['History', 'Math', 'Physics']);
  });

  it('resolves a subject the way the user says it', async () => {
    await repo.replaceAll(TIMETABLE);

    const hit = await repo.resolveSubject('maths');
    expect(hit.ok && hit.value).toBe('Math');

    const fuzzy = await repo.resolveSubject('phisics');
    expect(fuzzy.ok && fuzzy.value).toBe('Physics');

    const miss = await repo.resolveSubject('astronomy');
    expect(!miss.ok && miss.error.code).toBe('not_found');
  });

  it('refuses to guess between near-identical subjects', async () => {
    await repo.replaceAll([
      { subject_name: 'Math', day_of_week: 1, start_time: '08:00', end_time: '09:00' },
      { subject_name: 'Maths', day_of_week: 2, start_time: '08:00', end_time: '09:00' },
    ]);
    const outcome = await repo.resolveSubject('math');
    expect(!outcome.ok && outcome.error.code).toBe('ambiguous');
    expect(!outcome.ok && outcome.error.details).toEqual(['Math', 'Maths']);
  });

  it('reports an empty timetable rather than a bad match', async () => {
    const outcome = await repo.resolveSubject('math');
    expect(!outcome.ok && outcome.error.code).toBe('not_found');
  });

  /* --------------------------------------------------------- occurrences -- */

  it('finds the soonest Math class from a Wednesday when Math is Mon and Thu', async () => {
    await repo.replaceAll(TIMETABLE);

    const next = await repo.nextOccurrenceOf('math', { from: WEDNESDAY, zone: ZONE });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.value.subject).toBe('Math');
    expect(next.value.entry.dayOfWeek).toBe(4);
    expect(next.value.startsAt).toBe(at('2026-03-05T10:00'));
    expect(next.value.endsAt).toBe(at('2026-03-05T11:30'));
  });

  it('rolls over to next Monday once Thursday is done', async () => {
    await repo.replaceAll(TIMETABLE);
    const next = await repo.nextOccurrenceOf('math', {
      from: at('2026-03-05T12:00'),
      zone: ZONE,
    });
    expect(next.ok && next.value.startsAt).toBe(at('2026-03-09T08:00'));
  });

  it('skips deactivated slots', async () => {
    await repo.replaceAll(TIMETABLE);
    const thursday = (await repo.entriesForDay(4))[0]!;
    await repo.updateEntry(thursday.id, { isActive: false });

    const next = await repo.nextOccurrenceOf('math', { from: WEDNESDAY, zone: ZONE });
    expect(next.ok && next.value.startsAt).toBe(at('2026-03-09T08:00'));
  });

  it('honours odd and even week parity', async () => {
    await repo.replaceAll(TIMETABLE);

    // Friday 2026-03-06 falls in ISO week 10 (even), so an odd-week class must
    // wait for Friday 2026-03-13 in week 11.
    const odd = await repo.nextOccurrenceOf('history', { from: WEDNESDAY, zone: ZONE });
    expect(odd.ok && odd.value.startsAt).toBe(at('2026-03-13T13:00'));

    await repo.replaceAll([
      {
        subject_name: 'History',
        day_of_week: 5,
        start_time: '13:00',
        end_time: '14:00',
        week_parity: 'even',
      },
    ]);
    const even = await repo.nextOccurrenceOf('history', { from: WEDNESDAY, zone: ZONE });
    expect(even.ok && even.value.startsAt).toBe(at('2026-03-06T13:00'));
  });

  it('keeps the wall-clock time across a DST boundary', async () => {
    await repo.replaceAll([
      { subject_name: 'Math', day_of_week: 1, start_time: '09:00', end_time: '10:30' },
    ]);

    // Sofia moves to +03:00 on Sunday 2026-03-29.
    const next = await repo.nextOccurrenceOf('math', {
      from: at('2026-03-27T12:00'),
      zone: ZONE,
    });
    expect(next.ok).toBe(true);
    if (!next.ok) return;

    const local = epochToLocal(next.value.startsAt, ZONE);
    expect(local.toISO()).toBe('2026-03-30T09:00:00.000+03:00');
    expect(next.value.startsAt).toBe(at('2026-03-30T09:00'));
    expect(epochToLocal(next.value.endsAt, ZONE).toFormat('HH:mm')).toBe('10:30');
    // Three calendar days, but only 71 real hours: the hour lost to DST.
    expect(next.value.startsAt - at('2026-03-27T09:00')).toBe(71 * HOUR);
  });

  it('flattens a window into a time-ordered list of class instances', async () => {
    await repo.replaceAll(TIMETABLE);

    const window = await repo.upcomingOccurrences({
      from: at('2026-03-04T00:00'),
      days: 7,
      zone: ZONE,
    });

    expect(
      window.map((o) => `${o.entry.subjectName} ${epochToLocal(o.startsAt, ZONE).toFormat('ccc HH:mm')}`),
    ).toEqual([
      // Friday's History is an odd-week class and week 10 is even, so it is out.
      'Math Thu 10:00',
      'Math Mon 08:00',
      'Physics Tue 09:00',
    ]);
    expect(window.every((o) => o.endsAt > o.startsAt)).toBe(true);
  });

  it('repeats weekly slots across a longer window', async () => {
    await repo.replaceAll([
      { subject_name: 'Math', day_of_week: 4, start_time: '10:00', end_time: '11:30' },
    ]);
    const window = await repo.upcomingOccurrences({
      from: at('2026-03-04T00:00'),
      days: 21,
      zone: ZONE,
    });
    expect(window.map((o) => o.startsAt)).toEqual([
      at('2026-03-05T10:00'),
      at('2026-03-12T10:00'),
      at('2026-03-19T10:00'),
    ]);
  });

  it('returns nothing for an empty window', async () => {
    await repo.replaceAll(TIMETABLE);
    expect(await repo.upcomingOccurrences({ from: WEDNESDAY, days: 0, zone: ZONE })).toEqual([]);
  });

  /* ------------------------------------------------------------ homework -- */

  it('puts homework due one day before the next class', async () => {
    await repo.replaceAll(TIMETABLE);
    const due = await repo.dueDateForHomework('math', {
      from: at('2026-03-02T12:00'),
      zone: ZONE,
    });
    expect(due.ok).toBe(true);
    if (!due.ok) return;
    expect(due.value.classStartsAt).toBe(at('2026-03-05T10:00'));
    expect(due.value.dueAt).toBe(at('2026-03-04T10:00'));
    expect(due.value.subject).toBe('Math');
  });

  it('clamps the due date to an hour from now when the class is 3 hours away', async () => {
    await repo.replaceAll(TIMETABLE);
    const from = at('2026-03-05T07:00');

    const due = await repo.dueDateForHomework('math', { from, zone: ZONE });
    expect(due.ok).toBe(true);
    if (!due.ok) return;
    expect(due.value.classStartsAt).toBe(at('2026-03-05T10:00'));
    expect(due.value.dueAt).toBe(at('2026-03-05T08:00'));
    expect(due.value.dueAt).toBeGreaterThan(from);
  });

  it('never lands the due date after the class it belongs to', async () => {
    await repo.replaceAll(TIMETABLE);
    // Half an hour before the class: an hour's notice would fall past it.
    const from = at('2026-03-05T09:30');

    const due = await repo.dueDateForHomework('math', { from, zone: ZONE });
    expect(due.ok).toBe(true);
    if (!due.ok) return;
    expect(due.value.classStartsAt).toBe(at('2026-03-05T10:00'));
    expect(due.value.dueAt).toBe(at('2026-03-05T10:00'));
    expect(due.value.dueAt).toBeLessThanOrEqual(due.value.classStartsAt);
  });

  it('accepts a custom lead time', async () => {
    await repo.replaceAll(TIMETABLE);
    const due = await repo.dueDateForHomework('math', {
      from: at('2026-03-05T07:00'),
      zone: ZONE,
      hoursBefore: 1,
    });
    expect(due.ok && due.value.dueAt).toBe(at('2026-03-05T09:00'));
  });

  it('propagates an unresolved subject', async () => {
    await repo.replaceAll(TIMETABLE);
    const due = await repo.dueDateForHomework('astronomy', { from: WEDNESDAY, zone: ZONE });
    expect(!due.ok && due.error.code).toBe('not_found');
  });

  /* --------------------------------------------------------------- clock -- */

  it('falls back to the injected clock and zone', async () => {
    setZoneOverride(ZONE);
    restores.push(freezeClock(WEDNESDAY));
    await repo.replaceAll(TIMETABLE);

    const next = await repo.nextOccurrenceOf('math');
    expect(next.ok && next.value.startsAt).toBe(at('2026-03-05T10:00'));

    const window = await repo.upcomingOccurrences();
    expect(window[0]!.startsAt).toBe(at('2026-03-05T10:00'));

    const due = await repo.dueDateForHomework('math');
    expect(due.ok && due.value.dueAt).toBe(at('2026-03-04T13:00'));
  });
});
