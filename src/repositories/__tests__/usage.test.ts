import { freezeClock, resetClock } from '@/core/clock';
import { setZoneOverride } from '@/core/time';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import { createCalendarEventsRepository } from '@/repositories/calendarEvents';
import { createChecklistsRepository } from '@/repositories/checklists';
import { createHabitsRepository } from '@/repositories/habits';
import { createTasksRepository } from '@/repositories/tasks';
import { createUsageRepository, type UsageRepository } from '@/repositories/usage';

const ZONE = 'Europe/Sofia';

describe('usage counts', () => {
  let t: TestDatabase;
  let usage: UsageRepository;

  beforeEach(() => {
    setZoneOverride(ZONE);
    freezeClock(Date.parse('2026-08-11T09:00:00Z'));
    t = createTestDatabase();
    usage = createUsageRepository(t.db);
  });

  afterEach(() => {
    resetClock();
    setZoneOverride(null);
    t.close();
  });

  it('reports nothing used on a database nobody has touched', async () => {
    expect(await usage.counts()).toEqual({ events: 0, tasks: 0, habits: 0, lists: 0 });
  });

  it('counts each area independently', async () => {
    await createTasksRepository(t.db).createTask({ title: 'Post the form' });
    await createHabitsRepository(t.db).getOrCreateHabit('Read');
    await createChecklistsRepository(t.db).addItems('Hardware', ['M4 bolts', 'Threadlock']);
    await createCalendarEventsRepository(t.db).createEvent({
      title: 'Lab',
      startsAt: Date.parse('2026-08-11T09:00:00Z'),
      endsAt: Date.parse('2026-08-11T10:00:00Z'),
    });

    expect(await usage.counts()).toEqual({ events: 1, tasks: 1, habits: 1, lists: 1 });
  });

  /* Two items on one list is one list. The widget asks "have you ever made a
     list", and counting rows would say "two" for a single shopping trip. */
  it('counts lists, not the items on them', async () => {
    const checklists = createChecklistsRepository(t.db);
    await checklists.addItems('Hardware', ['Bolts', 'Glue', 'Tape']);
    await checklists.addItems('Groceries', ['Milk']);

    expect((await usage.counts()).lists).toBe(2);
  });

  /* A user whose only tasks are finished has still used tasks. Telling them
     "no tasks yet" invites them to set up what they already have. */
  it('still counts a task that has been completed', async () => {
    const tasks = createTasksRepository(t.db);
    const task = await tasks.createTask({ title: 'Return the drill' });
    await tasks.completeTask(task.id);

    expect((await usage.counts()).tasks).toBe(1);
  });

  /* A deleted event is gone, and a calendar the user emptied should read as
     unused rather than as configured-but-quiet. */
  it('does not count a deleted event', async () => {
    const calendar = createCalendarEventsRepository(t.db);
    const event = await calendar.createEvent({
      title: 'Cancelled',
      startsAt: Date.parse('2026-08-11T09:00:00Z'),
      endsAt: Date.parse('2026-08-11T10:00:00Z'),
    });
    await calendar.softDelete(event.id);

    expect((await usage.counts()).events).toBe(0);
  });
});
