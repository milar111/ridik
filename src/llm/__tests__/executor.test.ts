import { freezeClock } from '@/core/clock';
import { localToEpoch, setZoneOverride } from '@/core/time';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import { actionSchema, type LlmAction, type ToolName } from '@/llm/contract';
import {
  buildPhasePlan,
  candidatesFrom,
  createExecutor,
  type ActionResult,
  type ExecutorEffects,
  type ReminderRequest,
} from '@/llm/executor';
import { createRepositories, type Repositories } from '@/repositories';

const ZONE = 'Europe/Sofia';
/** Monday 09 March 2026. */
const MONDAY = '2026-03-09';
const TUESDAY = '2026-03-10';
const WEDNESDAY = '2026-03-11';

const at = (local: string): number => localToEpoch(local, ZONE);
const NOW = at(`${MONDAY}T08:00`);

/** Parses through the real contract so schema defaults are the ones under test. */
function act<T extends ToolName>(toolName: T, parameters: unknown): LlmAction {
  return actionSchema.parse({ tool_name: toolName, parameters });
}

type Recorder = {
  effects: ExecutorEffects;
  reminders: ReminderRequest[];
  cancelled: string[];
  started: string[];
  controls: string[];
  geofenceRegistrations: number;
  syncedEvents: string[];
};

function recorder(overrides: Partial<ExecutorEffects> = {}): Recorder {
  const state: Recorder = {
    effects: {},
    reminders: [],
    cancelled: [],
    started: [],
    controls: [],
    geofenceRegistrations: 0,
    syncedEvents: [],
  };
  state.effects = {
    async scheduleReminder(input) {
      state.reminders.push(input);
      return 'notification-1';
    },
    async cancelReminders(entityId) {
      state.cancelled.push(entityId);
    },
    async startFocusSession(sessionId) {
      state.started.push(sessionId);
    },
    async controlFocusSession(action) {
      state.controls.push(action);
    },
    async registerGeofences() {
      state.geofenceRegistrations += 1;
    },
    async syncCalendarEvent(eventId) {
      state.syncedEvents.push(eventId);
    },
    ...overrides,
  };
  return state;
}

describe('buildPhasePlan', () => {
  it('alternates focus and break so the phases sum to the requested total', () => {
    const phases = buildPhasePlan({ totalMinutes: 120, focusMinutes: 25, breakMinutes: 5 });

    expect(phases).toEqual([
      { kind: 'focus', minutes: 25 },
      { kind: 'break', minutes: 5 },
      { kind: 'focus', minutes: 25 },
      { kind: 'break', minutes: 5 },
      { kind: 'focus', minutes: 25 },
      { kind: 'break', minutes: 5 },
      { kind: 'focus', minutes: 25 },
      { kind: 'break', minutes: 5 },
    ]);
    expect(phases.reduce((sum, p) => sum + p.minutes, 0)).toBe(120);
  });

  it('truncates the final phase rather than overshooting the budget', () => {
    const phases = buildPhasePlan({ totalMinutes: 70, focusMinutes: 25, breakMinutes: 5 });

    expect(phases).toEqual([
      { kind: 'focus', minutes: 25 },
      { kind: 'break', minutes: 5 },
      { kind: 'focus', minutes: 25 },
      { kind: 'break', minutes: 5 },
      { kind: 'focus', minutes: 10 },
    ]);
    expect(phases.reduce((sum, p) => sum + p.minutes, 0)).toBe(70);
  });

  it('truncates a break that would run past the total', () => {
    const phases = buildPhasePlan({ totalMinutes: 27, focusMinutes: 25, breakMinutes: 5 });

    expect(phases).toEqual([
      { kind: 'focus', minutes: 25 },
      { kind: 'break', minutes: 2 },
    ]);
  });

  it('drops zero-length breaks instead of storing phases of no length', () => {
    const phases = buildPhasePlan({ totalMinutes: 120, focusMinutes: 25, breakMinutes: 0 });

    expect(phases.every((p) => p.kind === 'focus')).toBe(true);
    expect(phases.map((p) => p.minutes)).toEqual([25, 25, 25, 25, 20]);
    expect(phases.reduce((sum, p) => sum + p.minutes, 0)).toBe(120);
  });

  it('uses the long break on every nth cycle', () => {
    const phases = buildPhasePlan({
      totalMinutes: 120,
      focusMinutes: 25,
      breakMinutes: 5,
      longBreakMinutes: 15,
      cyclesBeforeLongBreak: 2,
    });

    expect(phases).toEqual([
      { kind: 'focus', minutes: 25 },
      { kind: 'break', minutes: 5 },
      { kind: 'focus', minutes: 25 },
      { kind: 'break', minutes: 15 },
      { kind: 'focus', minutes: 25 },
      { kind: 'break', minutes: 5 },
      { kind: 'focus', minutes: 20 },
    ]);
    expect(phases.reduce((sum, p) => sum + p.minutes, 0)).toBe(120);
  });

  it('is a single focus block when no total was given', () => {
    expect(buildPhasePlan({ focusMinutes: 45 })).toEqual([{ kind: 'focus', minutes: 45 }]);
    expect(buildPhasePlan({})).toEqual([{ kind: 'focus', minutes: 25 }]);
  });

  it('never emits a phase longer than the whole budget', () => {
    expect(buildPhasePlan({ totalMinutes: 10, focusMinutes: 25 })).toEqual([
      { kind: 'focus', minutes: 10 },
    ]);
  });
});

describe('candidatesFrom', () => {
  it('reads both the wrapped and bare shapes repositories report', () => {
    expect(candidatesFrom({ matches: [{ id: 'a', title: 'Dentist' }] })).toEqual([
      { id: 'a', label: 'Dentist' },
    ]);
    expect(candidatesFrom([{ id: 'p1', name: 'Greece trip' }])).toEqual([
      { id: 'p1', label: 'Greece trip' },
    ]);
    expect(candidatesFrom({ candidates: [{ id: 'n1', titleSummary: 'Robotics' }] })).toEqual([
      { id: 'n1', label: 'Robotics' },
    ]);
  });

  it('reports nothing when the details carry no ids the UI could act on', () => {
    expect(candidatesFrom({ titles: ['one', 'two'] })).toBeUndefined();
    expect(candidatesFrom(undefined)).toBeUndefined();
  });
});

describe('executor', () => {
  let t: TestDatabase;
  let repos: Repositories;
  let restoreClock: () => void;
  let fx: Recorder;
  let executor: ReturnType<typeof createExecutor>;

  beforeEach(() => {
    setZoneOverride(ZONE);
    restoreClock = freezeClock(NOW);
    t = createTestDatabase();
    // `createRepositories` is safe to call here: `@/repositories` only reaches
    // for the on-device handle inside `getRepositories()`, which this never hits.
    repos = createRepositories(t.db);
    fx = recorder();
    executor = createExecutor({ repos, zone: ZONE, now: NOW, effects: fx.effects });
  });

  afterEach(() => {
    restoreClock();
    setZoneOverride(null);
    t.close();
  });

  /* ------------------------------------------------------------- calendar -- */

  describe('calendar_add', () => {
    it('books the event, adds the travel buffer, queues the push and sets a reminder', async () => {
      const result = await executor.execute(
        act('calendar_add', {
          title: 'Dentist',
          start: `${WEDNESDAY}T15:00`,
          duration_minutes: 45,
          location: 'Clinic on Vitosha',
        }),
      );

      expect(result.ok).toBe(true);
      expect(result.summary).toContain('Dentist');
      expect(result.href).toBe('/calendar');
      expect(result.entityId).toBeDefined();

      const day = await repos.calendar.listForLocalDate(WEDNESDAY, ZONE);
      const event = day.find((row) => row.title === 'Dentist');
      expect(event).toBeDefined();
      expect(event!.startsAt).toBe(at(`${WEDNESDAY}T15:00`));
      expect(event!.endsAt).toBe(at(`${WEDNESDAY}T15:45`));
      expect(event!.timezone).toBe(ZONE);

      const buffer = day.find((row) => row.kind === 'buffer');
      expect(buffer).toBeDefined();
      expect(buffer!.endsAt).toBe(event!.startsAt);
      expect(buffer!.startsAt).toBe(at(`${WEDNESDAY}T14:40`));

      const queued = await repos.syncQueue.listByStatus('pending');
      expect(queued.map((row) => row.entityId)).toContain(event!.id);
      expect(fx.syncedEvents).toContain(event!.id);

      expect(fx.reminders).toHaveLength(1);
      expect(fx.reminders[0]!.at).toBe(at(`${WEDNESDAY}T14:50`));
    });

    it('queues the outbox row in the vocabulary the sync worker drains', async () => {
      const result = await executor.execute(
        act('calendar_add', { title: 'Dentist', start: `${WEDNESDAY}T15:00` }),
      );

      const [queued] = await repos.syncQueue.listByStatus('pending');
      expect(queued!.operation).toBe('calendar.push');
      expect(queued!.entityTable).toBe('calendar_events');
      expect(queued!.entityId).toBe(result.entityId);
      // The worker re-reads the row to push it, but a retraction cannot: these
      // three ids are all it has left to delete the remote copies with.
      expect(JSON.parse(queued!.payload)).toEqual({
        googleEventId: null,
        googleCalendarId: null,
        nativeEventId: null,
      });
    });

    it('collapses an edit into the push already queued rather than racing it', async () => {
      await executor.execute(
        act('calendar_add', { title: 'Dentist', start: `${WEDNESDAY}T15:00` }),
      );
      await executor.execute(
        act('calendar_update', { target: { query: 'dentist' }, start: `${WEDNESDAY}T17:00` }),
      );

      expect(await repos.syncQueue.listByStatus('pending')).toHaveLength(1);
    });

    it('does not promise a reminder the device could not schedule', async () => {
      const denied = createExecutor({
        repos,
        zone: ZONE,
        now: NOW,
        effects: { async scheduleReminder() { return null; } },
      });

      const result = await denied.execute(
        act('calendar_add', { title: 'Dentist', start: `${WEDNESDAY}T15:00` }),
      );

      expect(result.ok).toBe(true);
      expect(result.detail ?? '').not.toContain('Reminder');
    });

    it('defaults an event with no end and no duration to an hour', async () => {
      await executor.execute(
        act('calendar_add', { title: 'Standup', start: `${WEDNESDAY}T09:00` }),
      );

      const [event] = await repos.calendar.listForLocalDate(WEDNESDAY, ZONE);
      expect(event!.endsAt - event!.startsAt).toBe(60 * 60_000);
    });

    it('gives an exam an hour of notice instead of ten minutes', async () => {
      await executor.execute(
        act('calendar_add', { title: 'Physics exam', start: `${WEDNESDAY}T09:00`, kind: 'exam' }),
      );

      expect(fx.reminders[0]!.at).toBe(at(`${WEDNESDAY}T08:00`));
    });

    it('refuses to book over a clash and offers the next free slot', async () => {
      await repos.calendar.createEvent({
        title: 'Math class',
        startsAt: at(`${MONDAY}T15:00`),
        endsAt: at(`${MONDAY}T16:00`),
      });

      const result = await executor.execute(
        act('calendar_add', { title: 'Dentist', start: `${MONDAY}T15:30`, duration_minutes: 60 }),
      );

      expect(result.ok).toBe(false);
      expect(result.error).toBeUndefined();
      expect(result.needsConfirmation?.question).toContain('Math class');
      expect(result.needsConfirmation?.question).toContain('4 PM');
      expect(result.needsConfirmation?.candidates).toHaveLength(1);

      const day = await repos.calendar.listForLocalDate(MONDAY, ZONE);
      expect(day.map((row) => row.title)).toEqual(['Math class']);
      expect(fx.reminders).toHaveLength(0);
    });

    it('books over the clash once the user has confirmed', async () => {
      await repos.calendar.createEvent({
        title: 'Math class',
        startsAt: at(`${MONDAY}T15:00`),
        endsAt: at(`${MONDAY}T16:00`),
      });

      const result = await executor.execute(
        act('calendar_add', { title: 'Dentist', start: `${MONDAY}T15:30`, duration_minutes: 60 }),
        { confirmed: true },
      );

      expect(result.ok).toBe(true);
      const day = await repos.calendar.listForLocalDate(MONDAY, ZONE);
      expect(day.map((row) => row.title).sort()).toEqual(['Dentist', 'Math class']);
    });

    it('turns an unparseable wall clock into an invalid_input result rather than throwing', async () => {
      const result = await executor.execute(
        act('calendar_add', { title: 'Nowhen', start: '2026-13-01T10:00' }),
      );

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('invalid_input');
      expect(await repos.calendar.listBetween(0, Number.MAX_SAFE_INTEGER)).toHaveLength(0);
    });

    it('spans the whole local day for an all-day event and never asks about clashes', async () => {
      await repos.calendar.createEvent({
        title: 'Math class',
        startsAt: at(`${MONDAY}T15:00`),
        endsAt: at(`${MONDAY}T16:00`),
      });

      const result = await executor.execute(
        act('calendar_add', { title: 'Public holiday', start: `${MONDAY}T09:30`, all_day: true }),
      );

      expect(result.ok).toBe(true);
      const event = (await repos.calendar.listForLocalDate(MONDAY, ZONE)).find(
        (row) => row.title === 'Public holiday',
      );
      expect(event!.startsAt).toBe(at(`${MONDAY}T00:00`));
      expect(event!.endsAt).toBe(at(`${TUESDAY}T00:00`));
    });

    it('falls back to the timetable when the model gave a day but no time', async () => {
      await repos.curriculum.addEntries([
        { subject_name: 'Math', day_of_week: 3, start_time: '10:00', end_time: '11:00' },
      ]);

      const result = await executor.execute(
        act('calendar_add', { title: 'Math homework, problems 4-9', start: `${MONDAY}T00:00` }),
      );

      expect(result.ok).toBe(true);
      expect(result.detail).toContain('next Math class');
      const event = (await repos.calendar.listBetween(0, Number.MAX_SAFE_INTEGER))[0];
      // The next Math class is Wednesday 10:00, so the work is due Tuesday 10:00.
      expect(event!.startsAt).toBe(at(`${TUESDAY}T10:00`));
    });
  });

  describe('calendar_update / calendar_delete', () => {
    it('keeps the original length when only the start moves', async () => {
      await repos.calendar.createEvent({
        title: 'Meeting with Ivo',
        startsAt: at(`${MONDAY}T10:00`),
        endsAt: at(`${MONDAY}T10:30`),
      });

      const result = await executor.execute(
        act('calendar_update', {
          target: { query: 'meeting with Ivo' },
          start: `${MONDAY}T15:00`,
        }),
      );

      expect(result.ok).toBe(true);
      const [event] = await repos.calendar.listForLocalDate(MONDAY, ZONE);
      expect(event!.startsAt).toBe(at(`${MONDAY}T15:00`));
      expect(event!.endsAt).toBe(at(`${MONDAY}T15:30`));
      expect(fx.cancelled).toContain(event!.id);
    });

    it('asks which one instead of guessing, and changes nothing', async () => {
      const monday = await repos.calendar.createEvent({
        title: 'Meeting with Ivo',
        startsAt: at(`${MONDAY}T10:00`),
        endsAt: at(`${MONDAY}T11:00`),
      });
      const wednesday = await repos.calendar.createEvent({
        title: 'Meeting with Ivo',
        startsAt: at(`${WEDNESDAY}T10:00`),
        endsAt: at(`${WEDNESDAY}T11:00`),
      });

      const result = await executor.execute(
        act('calendar_update', { target: { query: 'meeting with Ivo' }, start: `${MONDAY}T15:00` }),
      );

      expect(result.ok).toBe(false);
      expect(result.needsConfirmation).toBeDefined();
      expect(result.needsConfirmation!.candidates?.map((c) => c.id).sort()).toEqual(
        [monday.id, wednesday.id].sort(),
      );

      expect((await repos.calendar.getById(monday.id))!.startsAt).toBe(at(`${MONDAY}T10:00`));
      expect((await repos.calendar.getById(wednesday.id))!.startsAt).toBe(at(`${WEDNESDAY}T10:00`));
    });

    it('says so plainly when there is nothing matching to update', async () => {
      const result = await executor.execute(
        act('calendar_update', { target: { query: 'the thing on Friday' }, start: `${MONDAY}T15:00` }),
      );

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('not_found');
      expect(result.needsConfirmation).toBeUndefined();
    });

    it('drags the travel buffer along when the event moves', async () => {
      await executor.execute(
        act('calendar_add', {
          title: 'Dentist',
          start: `${WEDNESDAY}T15:00`,
          location: 'Clinic on Vitosha',
        }),
      );

      await executor.execute(
        act('calendar_update', { target: { query: 'dentist' }, start: `${WEDNESDAY}T17:00` }),
      );

      const day = await repos.calendar.listForLocalDate(WEDNESDAY, ZONE);
      const event = day.find((row) => row.title === 'Dentist')!;
      const buffer = day.find((row) => row.kind === 'buffer')!;
      expect(event.startsAt).toBe(at(`${WEDNESDAY}T17:00`));
      expect(buffer.endsAt).toBe(event.startsAt);
      expect(buffer.startsAt).toBe(at(`${WEDNESDAY}T16:40`));
    });

    it('retracts the buffer with the event it was created for', async () => {
      const added = await executor.execute(
        act('calendar_add', {
          title: 'Dentist',
          start: `${WEDNESDAY}T15:00`,
          location: 'Clinic on Vitosha',
        }),
      );
      const buffer = (await repos.calendar.listBuffersFor(added.entityId!))[0]!;

      await executor.execute(act('calendar_delete', { target: { query: 'dentist' } }));

      const retractions = (await repos.syncQueue.listByStatus('pending')).filter(
        (row) => row.operation === 'calendar.delete',
      );
      expect(retractions.map((row) => row.entityId).sort()).toEqual(
        [added.entityId!, buffer.id].sort(),
      );
    });

    it('cancels an event as a tombstone and cancels its reminders', async () => {
      const event = await repos.calendar.createEvent({
        title: 'Math homework',
        startsAt: at(`${TUESDAY}T18:00`),
        endsAt: at(`${TUESDAY}T19:00`),
      });

      const result = await executor.execute(
        act('calendar_delete', { target: { query: 'math homework' }, mode: 'cancel' }),
      );

      expect(result.ok).toBe(true);
      expect((await repos.calendar.getById(event.id))!.deletedAt).toBe(NOW);
      expect(fx.cancelled).toContain(event.id);
    });
  });

  /* ---------------------------------------------------------------- notes -- */

  describe('notes', () => {
    it('appends to the note that already owns the title and tag instead of forking one', async () => {
      await executor.execute(
        act('note_create', {
          title_summary: 'Robotics',
          category_tag: 'hardware',
          bullets: ['Need 10k resistors'],
        }),
      );
      const second = await executor.execute(
        act('note_create', {
          title_summary: 'robotics',
          category_tag: 'Hardware',
          bullets: ['Order M3 screws'],
        }),
      );

      expect(second.summary).toContain('Added 1 line');
      const notes = await repos.notes.listNotes();
      expect(notes).toHaveLength(1);
      expect(notes[0]!.bullets.map((b) => b.content)).toEqual([
        'Need 10k resistors',
        'Order M3 screws',
      ]);
    });

    it('reports a fresh note as created', async () => {
      const result = await executor.execute(
        act('note_create', {
          title_summary: 'Order 10k resistors',
          category_tag: 'electronics',
          bullets: ['Need 10k resistors'],
        }),
      );

      expect(result.ok).toBe(true);
      expect(result.summary).toContain('Noted');
      expect(result.href).toBe(`/note/${result.entityId}`);
    });

    it('appends through note_update using the words the user said', async () => {
      await executor.execute(
        act('note_create', {
          title_summary: 'Robotics build log',
          category_tag: 'hardware',
          bullets: ['Frame printed'],
        }),
      );

      const result = await executor.execute(
        act('note_update', {
          target: { query: 'robotics note' },
          append_bullets: ['Servos ordered'],
        }),
      );

      expect(result.ok).toBe(true);
      const [note] = await repos.notes.listNotes();
      expect(note!.bullets.map((b) => b.content)).toEqual(['Frame printed', 'Servos ordered']);
    });

    it('asks before deleting a note, and deletes it once confirmed', async () => {
      const created = await executor.execute(
        act('note_create', {
          title_summary: 'Scratch',
          category_tag: 'misc',
          bullets: ['Nothing important'],
        }),
      );

      const asked = await executor.execute(act('note_delete', { target: { query: 'scratch' } }));
      expect(asked.ok).toBe(false);
      expect(asked.needsConfirmation?.question).toContain('Delete the note');
      expect(await repos.notes.getNote(created.entityId!)).not.toBeNull();

      const confirmed = await executor.execute(
        act('note_delete', { target: { query: 'scratch' } }),
        { confirmed: true },
      );
      expect(confirmed.ok).toBe(true);
      expect(await repos.notes.getNote(created.entityId!)).toBeNull();
    });
  });

  /* ---------------------------------------------------------------- tasks -- */

  describe('tasks', () => {
    it('creates the prerequisite, locks the child and reports what unlocked later', async () => {
      const added = await executor.execute(
        act('task_add', {
          title: 'Assemble hardware build',
          depends_on: ['Print the brackets'],
        }),
      );

      expect(added.ok).toBe(true);
      expect(added.summary).toContain('blocked until');
      expect(added.detail).toContain('Print the brackets');

      const child = await repos.tasks.getTask(added.entityId!);
      expect(child!.isLocked).toBe(true);
      expect(await repos.tasks.listActiveTasks()).toHaveLength(1);

      const completed = await executor.execute(
        act('task_complete', { target: { query: 'print the brackets' } }),
      );
      expect(completed.ok).toBe(true);
      expect(completed.detail).toBe('Unlocked: Assemble hardware build.');
      expect((await repos.tasks.getTask(added.entityId!))!.isLocked).toBe(false);
    });

    it('rejects a dependency cycle without crashing the turn', async () => {
      await executor.execute(
        act('task_add_dependency', { child: 'Assemble frame', parents: ['Print brackets'] }),
      );

      const result = await executor.execute(
        act('task_add_dependency', { child: 'Print brackets', parents: ['Assemble frame'] }),
      );

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('cycle');
      expect(result.summary).toMatch(/loops back/i);
    });

    it('infers a homework deadline from the timetable when the model gave none', async () => {
      await repos.curriculum.addEntries([
        { subject_name: 'Math', day_of_week: 3, start_time: '10:00', end_time: '11:00' },
      ]);

      const result = await executor.execute(
        act('task_add', { title: 'Math homework, problems 4 to 9' }),
      );

      expect(result.ok).toBe(true);
      expect(result.detail).toContain('next Math class');
      expect((await repos.tasks.getTask(result.entityId!))!.dueDate).toBe(at(`${TUESDAY}T10:00`));
    });

    it('leaves an unrelated task undated', async () => {
      await repos.curriculum.addEntries([
        { subject_name: 'Math', day_of_week: 3, start_time: '10:00', end_time: '11:00' },
      ]);

      const result = await executor.execute(act('task_add', { title: 'Buy milk' }));

      expect((await repos.tasks.getTask(result.entityId!))!.dueDate).toBeNull();
      expect(result.detail).toBeUndefined();
    });
  });

  /* ------------------------------------------------------------- projects -- */

  describe('projects', () => {
    it('creates the project on demand and ticks the packing items', async () => {
      const result = await executor.execute(
        act('project_add_item', {
          project: 'Greece trip',
          items: [
            { content: 'Sunscreen', kind: 'todo' },
            { content: 'Beach towel', section: 'Packing' },
            { content: 'Ferry route ideas', kind: 'idea' },
          ],
        }),
      );

      expect(result.ok).toBe(true);
      expect(result.summary).toContain('Greece trip');
      expect(result.href).toBe(`/project/${result.entityId}`);

      const items = await repos.projects.listItems(result.entityId!);
      const byContent = new Map(items.map((item) => [item.content, item]));
      expect(byContent.get('Sunscreen')!.isCheckbox).toBe(true);
      expect(byContent.get('Beach towel')!.isCheckbox).toBe(true);
      expect(byContent.get('Ferry route ideas')!.isCheckbox).toBe(false);
    });

    it('refuses to invent a project when the model said not to', async () => {
      const result = await executor.execute(
        act('project_add_item', {
          project: 'Mars mission',
          items: [{ content: 'Rocket' }],
          create_if_missing: false,
        }),
      );

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('not_found');
      expect(await repos.projects.listProjects()).toHaveLength(0);
    });

    it('runs a batch in order so a later action can use what an earlier one created', async () => {
      const results = await executor.executeAll([
        act('project_create', { name: 'Greece trip', kind: 'trip', sections: ['Packing'] }),
        act('project_add_item', {
          project: 'Greece trip',
          items: [{ content: 'Sunscreen', section: 'Packing' }],
        }),
      ]);

      expect(results.map((r) => r.ok)).toEqual([true, true]);
      expect(await repos.projects.listProjects()).toHaveLength(1);
      expect(results[0]!.entityId).toBe(results[1]!.entityId);
    });

    it('asks which item rather than ticking off the wrong one', async () => {
      const project = await repos.projects.getOrCreateProject('Greece trip');
      await repos.projects.addItems(project.id, [
        { content: 'Book the ferry' },
        { content: 'Book the hotel' },
      ]);

      const result = await executor.execute(
        act('project_item_toggle', { project: 'Greece trip', item_query: 'book the' }),
      );

      expect(result.ok).toBe(false);
      expect(result.needsConfirmation?.candidates).toHaveLength(2);
      expect((await repos.projects.listItems(project.id)).every((i) => !i.isCompleted)).toBe(true);
    });
  });

  /* ------------------------------------------------------ ledger & speech -- */

  describe('ledger', () => {
    it('reads a spending total back the way a person would say it', async () => {
      for (const amount of [100, 48]) {
        await repos.ledger.addTransaction({ amount, category: 'hardware', currency: 'EUR', zone: ZONE });
      }
      await repos.ledger.addTransaction({ amount: 9, category: 'food', currency: 'EUR', zone: ZONE });

      const result = await executor.execute(
        act('ledger_query', { category: 'hardware', period: 'month' }),
      );

      expect(result.ok).toBe(true);
      expect(result.summary).toBe('You spent 148 euros on hardware this month.');
      expect(result.href).toBe('/ledger');
    });

    it('says nothing was spent rather than reading out a zero', async () => {
      const result = await executor.execute(
        act('ledger_query', { category: 'hardware', period: 'month' }),
      );

      expect(result.ok).toBe(true);
      expect(result.summary).toBe('You have not spent anything on hardware this month.');
    });

    it('logs an expense with the currency the user spoke', async () => {
      const result = await executor.execute(
        act('ledger_add', { amount: 12, currency: 'leva', category: 'food', description: 'Lunch' }),
      );

      expect(result.ok).toBe(true);
      expect(result.summary).toContain('12.00');
      const [row] = await repos.ledger.listRecent();
      expect(row!.currency).toBe('BGN');
    });
  });

  /* ------------------------------------------------------------- the rest -- */

  describe('checklists, habits, timers, places and people', () => {
    it('adds items and reports what was already on the list', async () => {
      await executor.execute(act('checklist_add', { list_name: 'shopping', items: ['Milk'] }));
      const result = await executor.execute(
        act('checklist_add', {
          list_name: 'Shopping',
          items: ['Milk', { text: 'Bread', quantity: '2' }],
        }),
      );

      expect(result.summary).toContain('Added 1 item');
      expect(result.detail).toContain('Milk');
      // The Lists pane of the Notes tab is the only screen a checklist has.
      expect(result.href).toBe('/notes?pane=lists&list=Shopping');
      expect(await repos.checklists.itemsForList('shopping')).toHaveLength(2);
    });

    it('asks which item to tick off when the words fit two of them', async () => {
      await repos.checklists.addItems('shopping', ['Almond milk', 'Oat milk']);

      const result = await executor.execute(
        act('checklist_toggle', { list_name: 'shopping', item_query: 'milk' }),
      );

      expect(result.ok).toBe(false);
      expect(result.needsConfirmation?.candidates).toHaveLength(2);
      expect(
        (await repos.checklists.itemsForList('shopping')).every((row) => !row.isCompleted),
      ).toBe(true);
    });

    it('logs a habit and reports the streak', async () => {
      const result = await executor.execute(
        act('habit_log', { habit_name: 'Running', note: '5k', duration_minutes: 30 }),
      );

      expect(result.ok).toBe(true);
      expect(result.summary).toContain('Running');
      expect(await repos.habits.findHabitByName('Running')).not.toBeNull();
    });

    it('persists the phase plan and hands the session to the runtime', async () => {
      const result = await executor.execute(
        act('timer_start', {
          label: 'Physics',
          subject: 'Physics',
          total_minutes: 90,
          focus_minutes: 25,
          break_minutes: 5,
        }),
      );

      expect(result.ok).toBe(true);
      const session = await repos.focus.getActive();
      expect(session!.id).toBe(result.entityId);
      // Spelled out rather than compared against `buildPhasePlan`: both sides of
      // that assertion would move together and it would prove only that the row
      // holds whatever the planner returned.
      expect(JSON.parse(session!.phases)).toEqual([
        { kind: 'focus', minutes: 25 },
        { kind: 'break', minutes: 5 },
        { kind: 'focus', minutes: 25 },
        { kind: 'break', minutes: 5 },
        { kind: 'focus', minutes: 25 },
        { kind: 'break', minutes: 5 },
      ]);
      expect(fx.started).toEqual([session!.id]);
    });

    it('retires the session already running before starting another', async () => {
      const first = await executor.execute(act('timer_start', { label: 'Maths' }));
      const second = await executor.execute(act('timer_start', { label: 'Physics' }));

      expect(second.detail).toContain('Maths');
      expect((await repos.focus.getById(first.entityId!))!.status).toBe('cancelled');
      expect((await repos.focus.getActive())!.id).toBe(second.entityId);
    });

    it('says there is nothing to pause when no session is running', async () => {
      const result = await executor.execute(act('timer_control', { action: 'pause' }));

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('not_found');
      expect(fx.controls).toHaveLength(0);
    });

    it('asks the user to pin an unknown place rather than inventing coordinates', async () => {
      const result = await executor.execute(
        act('geofence_add', {
          label: 'the lab',
          action_description: 'Pick up the printed brackets',
          trigger_type: 'ENTER',
        }),
      );

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('not_found');
      expect(result.href).toBe('/places');
      expect(await repos.geofences.listAllTriggers()).toHaveLength(0);
      expect(fx.geofenceRegistrations).toBe(0);
    });

    it('attaches the reminder to a place that is already saved', async () => {
      await repos.places.upsertPlace({ label: 'The Lab', latitude: 42.65, longitude: 23.37 });

      const result = await executor.execute(
        act('geofence_add', {
          label: 'the lab',
          action_description: 'Pick up the printed brackets',
          trigger_type: 'ENTER',
        }),
      );

      expect(result.ok).toBe(true);
      expect(await repos.geofences.listAllTriggers()).toHaveLength(1);
      expect(fx.geofenceRegistrations).toBe(1);
    });

    it('creates the person, the promise and the task, and wires them together', async () => {
      const result = await executor.execute(
        act('crm_add_commitment', {
          entity_name: 'Ivo',
          commitment_text: 'Send the CAD files',
          due: `${TUESDAY}T18:00`,
          interaction_summary: 'Promised to send the CAD files by Friday.',
        }),
      );

      expect(result.ok).toBe(true);
      const profile = await repos.crm.getEntityProfile(result.entityId!);
      expect(profile.ok).toBe(true);
      if (!profile.ok) throw profile.error;

      expect(profile.value.openCommitments).toHaveLength(1);
      expect(profile.value.interactions).toHaveLength(1);

      const taskId = profile.value.openCommitments[0]!.taskId;
      expect(taskId).not.toBeNull();
      const task = await repos.tasks.getTask(taskId!);
      expect(task!.title).toBe('Send the CAD files');
      expect(task!.dueDate).toBe(at(`${TUESDAY}T18:00`));
    });
  });

  /* ---------------------------------------------------------- read-only -- */

  describe('read-only tools', () => {
    it('falls back to a locally computed briefing when no generator is wired up', async () => {
      await repos.calendar.createEvent({
        title: 'Dentist',
        startsAt: at(`${MONDAY}T15:00`),
        endsAt: at(`${MONDAY}T16:00`),
      });
      await repos.tasks.createTask({ title: 'Finish the report', dueDate: at(`${MONDAY}T20:00`) });

      const bare = createExecutor({ repos, zone: ZONE, now: NOW });
      const result = await bare.execute(act('briefing_generate', { scope: 'today' }));

      expect(result.ok).toBe(true);
      expect(result.summary).toContain('Today:');
      expect(result.summary).toContain('Dentist');
      expect(result.summary).toContain('1 task due');
    });

    it('prefers the injected briefing generator', async () => {
      const custom = createExecutor({
        repos,
        zone: ZONE,
        now: NOW,
        effects: { async generateBriefing() { return 'Your day is wide open.'; } },
      });

      const result = await custom.execute(act('briefing_generate', { scope: 'today' }));
      expect(result.summary).toBe('Your day is wide open.');
    });

    it('searches across scopes and deep-links the best hit', async () => {
      await repos.notes.upsertNoteWithBullets({
        titleSummary: 'Resistor stock',
        categoryTag: 'electronics',
        bullets: ['10k resistors running low'],
      });
      await repos.tasks.createTask({ title: 'Order resistors' });

      const result = await executor.execute(act('search', { query: 'resistors' }));

      expect(result.ok).toBe(true);
      expect(result.summary).toContain('resistors');
      expect(result.href).toBeDefined();
    });
  });

  /* ---------------------------------------------------------- the batch -- */

  describe('executeAll', () => {
    it('applies three unrelated intents from one utterance', async () => {
      await repos.calendar.createEvent({
        title: 'Math homework',
        startsAt: at(`${TUESDAY}T18:00`),
        endsAt: at(`${TUESDAY}T19:00`),
      });

      const results = await executor.executeAll([
        act('crm_add_commitment', {
          entity_name: 'Ivo',
          commitment_text: 'Call about the CAD files',
          due: `${TUESDAY}T10:00`,
        }),
        act('calendar_delete', { target: { query: 'math homework' }, mode: 'cancel' }),
        act('note_create', {
          title_summary: 'Order 10k resistors',
          category_tag: 'electronics',
          bullets: ['Need 10k resistors'],
        }),
      ]);

      expect(results.map((r) => r.toolName)).toEqual([
        'crm_add_commitment',
        'calendar_delete',
        'note_create',
      ]);
      expect(results.every((r) => r.ok)).toBe(true);

      expect((await repos.crm.listOpenCommitments())).toHaveLength(1);
      expect(await repos.calendar.listForLocalDate(TUESDAY, ZONE)).toHaveLength(0);
      expect(await repos.notes.listNotes()).toHaveLength(1);
    });

    it('carries on after a failure and reports one result per action', async () => {
      const results = await executor.executeAll([
        act('note_create', { title_summary: 'First', category_tag: 'misc', bullets: ['one'] }),
        act('calendar_update', { target: { query: 'a meeting that does not exist' }, start: `${MONDAY}T15:00` }),
        act('habit_log', { habit_name: 'Running' }),
      ]);

      expect(results).toHaveLength(3);
      expect(results.map((r) => r.ok)).toEqual([true, false, true]);
      expect(results[1]!.error?.code).toBe('not_found');
      expect(await repos.notes.listNotes()).toHaveLength(1);
      expect(await repos.habits.findHabitByName('Running')).not.toBeNull();
    });

    it('never lets a broken side effect fail the mutation it decorates', async () => {
      const brittle = createExecutor({
        repos,
        zone: ZONE,
        now: NOW,
        effects: {
          async scheduleReminder(): Promise<string | null> {
            throw new Error('notifications are not available');
          },
        },
      });

      const result = await brittle.execute(
        act('calendar_add', { title: 'Dentist', start: `${WEDNESDAY}T15:00` }),
      );

      expect(result.ok).toBe(true);
      expect(await repos.calendar.listForLocalDate(WEDNESDAY, ZONE)).toHaveLength(1);
    });
  });
});

/** Compile-time guard: the result shape the UI consumes must not drift. */
const _shape: ActionResult = { toolName: 'search', ok: true, summary: 'ok' };
void _shape;
