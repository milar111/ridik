import { freezeClock, resetClock } from '@/core/clock';
import { localToEpoch, setZoneOverride } from '@/core/time';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import { createCalendarEventsRepository } from '@/repositories/calendarEvents';
import { createCrmRepository } from '@/repositories/crm';
import { createCurriculumRepository } from '@/repositories/curriculum';
import { createFocusSessionsRepository } from '@/repositories/focusSessions';
import { createHabitsRepository } from '@/repositories/habits';
import { createSyncQueueRepository } from '@/repositories/syncQueue';
import { createTasksRepository } from '@/repositories/tasks';
import { collectBriefing, type BriefingRepositories } from '@/features/briefing/collect';

const ZONE = 'Europe/Sofia';
const at = (local: string): number => localToEpoch(local, ZONE);
/** A Tuesday, so `day_of_week` 2 in the schema's 0=Sunday numbering. */
const NOW = at('2026-08-11T07:30');

describe('collectBriefing', () => {
  let t: TestDatabase;
  let repos: BriefingRepositories;
  let restoreClock: () => void;

  beforeEach(() => {
    setZoneOverride(ZONE);
    restoreClock = freezeClock(NOW);
    t = createTestDatabase();
    repos = {
      calendar: createCalendarEventsRepository(t.db),
      crm: createCrmRepository(t.db),
      curriculum: createCurriculumRepository(t.db),
      focus: createFocusSessionsRepository(t.db),
      habits: createHabitsRepository(t.db),
      syncQueue: createSyncQueueRepository(t.db),
      tasks: createTasksRepository(t.db),
    };
  });

  afterEach(() => {
    restoreClock();
    resetClock();
    setZoneOverride(null);
    t.close();
  });

  async function seed(): Promise<void> {
    await repos.curriculum.addEntries([
      { subject_name: 'Math', day_of_week: 2, start_time: '10:00', end_time: '11:30', location: 'Room 3' },
    ]);
    await repos.calendar.createEventWithBuffer({
      title: 'Project meeting with Ivo',
      startsAt: at('2026-08-11T15:00'),
      endsAt: at('2026-08-11T16:00'),
      location: 'Cafe Central',
    });
    await repos.tasks.createTask({ title: 'Return the book', dueDate: at('2026-08-09T12:00') });
    await repos.tasks.createTask({ title: 'Physics homework', dueDate: at('2026-08-12T08:00') });

    const chain = await repos.tasks.addDependencyByTitles({
      childTitle: 'Order the servos',
      parentTitles: ['Print the frame'],
    });
    if (!chain.ok) throw chain.error;
    const parent = chain.value.parents[0]!;

    await repos.habits.logHabit({ habitName: 'Running', onDate: '2026-08-10' });
    await repos.crm.addCommitment({
      entityName: 'Ivo',
      commitmentText: 'send the design file',
      dueDate: at('2026-08-11T17:00'),
    });
    await repos.focus.create({ label: 'Physics revision', phases: [{ kind: 'focus', minutes: 25 }] });
    await repos.syncQueue.enqueue({
      operation: 'calendar.create',
      entityTable: 'calendar_events',
      entityId: 'anything',
      payload: {},
    });

    // Completing the prerequisite is what turns "Order the servos" into the
    // unblocked-but-untouched next step the briefing should surface.
    const done = await repos.tasks.completeTask(parent.id);
    if (!done.ok) throw done.error;
  }

  it('gathers the whole day in one pass', async () => {
    await seed();
    const data = await collectBriefing({ repos, scope: 'today' });

    expect(data.date).toBe('2026-08-11');
    expect(data.window).toEqual({ start: at('2026-08-11T00:00'), end: at('2026-08-12T00:00') });

    expect(data.classes).toEqual([
      {
        subject: 'Math',
        startsAt: at('2026-08-11T10:00'),
        endsAt: at('2026-08-11T11:30'),
        location: 'Room 3',
        teacher: null,
      },
    ]);

    const buffer = data.events.find((event) => event.isBuffer);
    expect(buffer).toMatchObject({
      startsAt: at('2026-08-11T14:40'),
      bufferFor: 'Project meeting with Ivo',
    });

    expect(data.overdueTasks.map((task) => task.title)).toEqual(['Return the book']);
    expect(data.dueTasks).toEqual([]);
    expect(data.upcomingTasks.map((task) => task.title)).toEqual(['Physics homework']);
    expect(data.unlockedTasks.map((task) => task.title)).toEqual(['Order the servos']);

    expect(data.streaksAtRisk.map((habit) => habit.name)).toEqual(['Running']);
    expect(data.streaks[0]).toMatchObject({ name: 'Running', streak: 1, atRisk: true });

    expect(data.commitments).toEqual([
      {
        id: expect.any(String),
        text: 'send the design file',
        personName: 'Ivo',
        direction: 'i_owe',
        dueDate: at('2026-08-11T17:00'),
        isOverdue: false,
      },
    ]);

    expect(data.focus).toMatchObject({ label: 'Physics revision', status: 'running', phase: 'focus' });
    expect(data.unsyncedCount).toBe(1);
  });

  it('leaves blocked work out of the actionable buckets', async () => {
    const chain = await repos.tasks.addDependencyByTitles({
      childTitle: 'Assemble the arm',
      parentTitles: ['Order the servos'],
      childDue: at('2026-08-11T18:00'),
    });
    expect(chain.ok).toBe(true);

    const data = await collectBriefing({ repos, scope: 'today' });
    expect(data.dueTasks).toEqual([]);
    expect(data.unlockedTasks).toEqual([]);
  });

  it('drops a habit whose streak has already lapsed', async () => {
    await repos.habits.logHabit({ habitName: 'Running', onDate: '2026-08-01' });
    const data = await collectBriefing({ repos, scope: 'today' });
    expect(data.streaks.map((habit) => habit.atRisk)).toEqual([false]);
    expect(data.streaksAtRisk).toEqual([]);
  });

  it('moves the window a day for the tomorrow scope', async () => {
    await seed();
    const data = await collectBriefing({ repos, scope: 'tomorrow' });

    expect(data.date).toBe('2026-08-12');
    expect(data.window).toEqual({ start: at('2026-08-12T00:00'), end: at('2026-08-13T00:00') });
    expect(data.classes).toEqual([]);
    // Due at 08:00 tomorrow, which is inside tomorrow's window rather than past it.
    expect(data.dueTasks.map((task) => task.title)).toEqual(['Physics homework']);
    expect(data.upcomingTasks).toEqual([]);
  });

  it('spans the seven days ahead for the week scope', async () => {
    await seed();
    const data = await collectBriefing({ repos, scope: 'week' });

    expect(data.window).toEqual({ start: at('2026-08-11T00:00'), end: at('2026-08-18T00:00') });
    // Half-open, so the following Tuesday's slot belongs to the next week.
    expect(data.classes.map((entry) => entry.startsAt)).toEqual([at('2026-08-11T10:00')]);
    // A due date three days out is inside the week rather than merely upcoming.
    expect(data.dueTasks.map((task) => task.title)).toEqual(['Physics homework']);
  });

  it('returns an entirely empty briefing rather than throwing on a fresh install', async () => {
    const data = await collectBriefing({ repos, scope: 'today' });
    expect(data).toMatchObject({
      events: [],
      classes: [],
      overdueTasks: [],
      dueTasks: [],
      unlockedTasks: [],
      streaks: [],
      commitments: [],
      focus: null,
      unsyncedCount: 0,
    });
  });
});
