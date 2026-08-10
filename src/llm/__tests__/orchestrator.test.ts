import { freezeClock } from '@/core/clock';
import { localToEpoch, setZoneOverride } from '@/core/time';
import type { RidikDatabase } from '@/db/migrator';
import { llmInteractions } from '@/db/schema';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import { createLlmClient } from '@/llm/client';
import { buildLlmContext, CONTEXT_CAPS } from '@/llm/context';
import {
  classifyConfirmation,
  createOrchestrator,
  limitWords,
  parsePending,
  type TurnOutcome,
} from '@/llm/orchestrator';
import { createMockProvider, LlmProviderError, type MockProviderOptions } from '@/llm/provider';
import type { Repositories } from '@/repositories';
import { createActivityRepository } from '@/repositories/activity';
import { createCalendarEventsRepository } from '@/repositories/calendarEvents';
import { createChecklistsRepository } from '@/repositories/checklists';
import { createCrmRepository } from '@/repositories/crm';
import { createCurriculumRepository } from '@/repositories/curriculum';
import { createFocusSessionsRepository } from '@/repositories/focusSessions';
import { createGeofencesRepository } from '@/repositories/geofences';
import { createHabitsRepository } from '@/repositories/habits';
import { createLedgerRepository } from '@/repositories/ledger';
import { createNotesRepository } from '@/repositories/notes';
import { createPlacesRepository } from '@/repositories/places';
import { createProjectsRepository } from '@/repositories/projects';
import { createSettingsRepository } from '@/repositories/settings';
import { createSyncQueueRepository } from '@/repositories/syncQueue';
import { createTasksRepository } from '@/repositories/tasks';

const ZONE = 'Europe/Sofia';
/** Monday 09 March 2026. */
const MONDAY = '2026-03-09';
const TUESDAY = '2026-03-10';
const WEDNESDAY = '2026-03-11';

const at = (local: string): number => localToEpoch(local, ZONE);
const NOW = at(`${MONDAY}T08:00`);

/** `@/repositories` opens the on-device database at import time; assemble by hand. */
function buildRepositories(db: RidikDatabase): Repositories {
  return {
    activity: createActivityRepository(db),
    calendar: createCalendarEventsRepository(db),
    checklists: createChecklistsRepository(db),
    crm: createCrmRepository(db),
    curriculum: createCurriculumRepository(db),
    focus: createFocusSessionsRepository(db),
    geofences: createGeofencesRepository(db),
    habits: createHabitsRepository(db),
    ledger: createLedgerRepository(db),
    notes: createNotesRepository(db),
    places: createPlacesRepository(db),
    projects: createProjectsRepository(db),
    settings: createSettingsRepository(db),
    syncQueue: createSyncQueueRepository(db),
    tasks: createTasksRepository(db),
    db,
  };
}

/* ------------------------------------------------------- classifyConfirmation -- */

describe('classifyConfirmation', () => {
  it.each([
    'yes',
    'Yes.',
    'yeah',
    'yep',
    'yup',
    'sure',
    'ok',
    'okay!',
    'do it',
    'go ahead',
    'book it',
    'yes please',
    'please do',
    'sounds good',
    'go for it',
  ])('reads %p as an affirmation', (text) => {
    expect(classifyConfirmation(text)).toBe('yes');
  });

  it.each([
    'no',
    'No!',
    'nope',
    'nah',
    'cancel',
    'cancel that',
    "don't",
    "don't book it",
    'do not',
    'leave it',
    'forget it',
    'never mind',
    'no thanks',
    'stop',
  ])('reads %p as a refusal', (text) => {
    expect(classifyConfirmation(text)).toBe('no');
  });

  it('leaves anything that carries new instructions to the model', () => {
    expect(classifyConfirmation('yes but move it to Friday afternoon instead')).toBe('other');
    expect(classifyConfirmation('the one on Friday')).toBe('other');
    expect(classifyConfirmation('make it three pm')).toBe('other');
    expect(classifyConfirmation('')).toBe('other');
    expect(classifyConfirmation('nothing much happened today')).toBe('other');
    // The dangerous near-miss: an answer plus a correction is not an answer.
    expect(classifyConfirmation('book it for Friday')).toBe('other');
    expect(classifyConfirmation('cancel my dentist appointment')).toBe('other');
  });
});

describe('limitWords', () => {
  it('leaves a short sentence exactly as spoken', () => {
    expect(limitWords('Noted, three things.', 25)).toBe('Noted, three things.');
  });

  it('cuts a rambling one back to something sayable', () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    expect(limitWords(long, 25).split(' ')).toHaveLength(25);
    expect(limitWords(long, 25).endsWith('…')).toBe(true);
  });
});

/* ------------------------------------------------------------- orchestrator -- */

const THREE_INTENTS =
  'Call Ivo tomorrow about the CAD files, cancel my math homework, and note that I need 10k resistors.';

const THREE_INTENT_REPLY = JSON.stringify({
  conversational_feedback:
    'Three things noted: Ivo, the maths homework is cancelled, and the resistors.',
  actions: [
    {
      tool_name: 'crm_add_commitment',
      parameters: {
        entity_name: 'Ivo',
        commitment_text: 'Call about the CAD files',
        due: `${TUESDAY}T10:00`,
        direction: 'i_owe',
      },
    },
    {
      tool_name: 'calendar_delete',
      parameters: { target: { query: 'math homework' }, mode: 'cancel' },
    },
    {
      tool_name: 'note_create',
      parameters: {
        title_summary: 'Order 10k resistors',
        category_tag: 'electronics',
        bullets: ['Need 10k resistors'],
      },
    },
  ],
});

describe('orchestrator', () => {
  let t: TestDatabase;
  let repos: Repositories;
  let restoreClock: () => void;

  beforeEach(() => {
    setZoneOverride(ZONE);
    restoreClock = freezeClock(NOW);
    t = createTestDatabase();
    repos = buildRepositories(t.db);
  });

  afterEach(() => {
    restoreClock();
    setZoneOverride(null);
    t.close();
  });

  function harness(options: MockProviderOptions) {
    const provider = createMockProvider(options);
    const client = createLlmClient({ provider, sleep: async () => {} });
    const orchestrator = createOrchestrator({ repos, client, zone: ZONE });
    return { provider, orchestrator };
  }

  const auditRows = () => t.db.select().from(llmInteractions);

  it('turns one three-intent utterance into three applied actions and one audit row', async () => {
    await repos.calendar.createEvent({
      title: 'Math homework',
      startsAt: at(`${TUESDAY}T18:00`),
      endsAt: at(`${TUESDAY}T19:00`),
    });

    const { provider, orchestrator } = harness({ responses: [THREE_INTENT_REPLY] });
    const outcome = await orchestrator.interpretAndExecute({
      transcript: THREE_INTENTS,
      confidence: 0.93,
    });

    expect(provider.calls).toBe(1);
    expect(outcome.items).toHaveLength(3);
    expect(outcome.items.every((item) => item.ok)).toBe(true);
    expect(outcome.items.map((item) => item.toolName)).toEqual([
      'crm_add_commitment',
      'calendar_delete',
      'note_create',
    ]);
    expect(outcome.feedback).toBe(
      'Three things noted: Ivo, the maths homework is cancelled, and the resistors.',
    );
    expect(outcome.clarification).toBeUndefined();

    // Each intent actually landed.
    const commitments = await repos.crm.listOpenCommitments();
    expect(commitments).toHaveLength(1);
    expect(commitments[0]!.entity.name).toBe('Ivo');
    const day = await repos.calendar.listForLocalDate(TUESDAY, ZONE);
    expect(day.find((row) => row.title === 'Math homework')).toBeUndefined();
    const notes = await repos.notes.listNotes({});
    expect(notes.map((note) => note.titleSummary)).toEqual(['Order 10k resistors']);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.status).toBe('ok');
    expect(row.transcript).toBe(THREE_INTENTS);
    expect(row.confidence).toBe(0.93);
    expect(row.model).toBe('mock-1');
    expect(row.feedback).toBe(outcome.feedback);
    expect(row.rawResponse).toBe(THREE_INTENT_REPLY);
    expect(JSON.parse(row.actions!)).toEqual([
      expect.objectContaining({ tool_name: 'crm_add_commitment', ok: true }),
      expect.objectContaining({ tool_name: 'calendar_delete', ok: true }),
      expect.objectContaining({ tool_name: 'note_create', ok: true }),
    ]);
  });

  it('parks a clash as one clarification and applies it on "yes" without asking the model again', async () => {
    await repos.calendar.createEvent({
      title: 'Study group',
      startsAt: at(`${WEDNESDAY}T15:00`),
      endsAt: at(`${WEDNESDAY}T16:00`),
    });

    const reply = JSON.stringify({
      conversational_feedback: 'Added.',
      actions: [
        {
          tool_name: 'calendar_add',
          parameters: {
            title: 'Dentist',
            start: `${WEDNESDAY}T15:00`,
            duration_minutes: 45,
          },
        },
      ],
    });

    const { provider, orchestrator } = harness({ responses: [reply] });
    const first = await orchestrator.interpretAndExecute({
      transcript: 'Dentist on Wednesday at three.',
    });

    expect(first.items).toHaveLength(1);
    expect(first.items[0]!.ok).toBe(false);
    expect(first.clarification).toBeDefined();
    expect(first.clarification!.question).toContain('Study group');
    expect(first.clarification!.question).toContain('Book it anyway?');

    // Nothing was written while the question was outstanding.
    const before = await repos.calendar.listForLocalDate(WEDNESDAY, ZONE);
    expect(before.map((row) => row.title)).toEqual(['Study group']);

    const pending = parsePending(first.clarification!.pending);
    expect(pending).toMatchObject({ kind: 'confirm' });

    const second = await orchestrator.interpretAndExecute({
      transcript: 'yes',
      pending: first.clarification!.pending!,
    });

    // The whole point: the second turn costs no provider call.
    expect(provider.calls).toBe(1);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.ok).toBe(true);
    expect(second.clarification).toBeUndefined();
    expect(second.feedback).toContain('Dentist');

    const after = await repos.calendar.listForLocalDate(WEDNESDAY, ZONE);
    expect(after.map((row) => row.title).sort()).toEqual(['Dentist', 'Study group']);

    const rows = await auditRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.status).toBe('clarify');
    expect(rows[1]!.status).toBe('ok');
    // No model was involved in the confirmation turn, and the audit says so.
    expect(rows[1]!.model).toBeNull();
    expect(rows[1]!.rawResponse).toBeNull();
  });

  it('abandons the pending action on "no", still without a model call', async () => {
    await repos.calendar.createEvent({
      title: 'Study group',
      startsAt: at(`${WEDNESDAY}T15:00`),
      endsAt: at(`${WEDNESDAY}T16:00`),
    });

    const reply = JSON.stringify({
      actions: [
        {
          tool_name: 'calendar_add',
          parameters: { title: 'Dentist', start: `${WEDNESDAY}T15:00` },
        },
      ],
    });

    const { provider, orchestrator } = harness({ responses: [reply] });
    const first = await orchestrator.interpretAndExecute({ transcript: 'Dentist at three.' });
    const second = await orchestrator.interpretAndExecute({
      transcript: "no, leave it",
      pending: first.clarification!.pending!,
    });

    expect(provider.calls).toBe(1);
    expect(second.items).toHaveLength(0);
    expect(second.feedback).toBe('Alright, I left it alone.');
    const day = await repos.calendar.listForLocalDate(WEDNESDAY, ZONE);
    expect(day.map((row) => row.title)).toEqual(['Study group']);
  });

  it('sends "which one did you mean?" back to the model instead of parking it behind a yes', async () => {
    await repos.notes.upsertNoteWithBullets({
      titleSummary: 'Resistor order for the drone',
      categoryTag: 'electronics',
      bullets: ['10k'],
    });
    await repos.notes.upsertNoteWithBullets({
      titleSummary: 'Resistor order for the lab',
      categoryTag: 'electronics',
      bullets: ['1k'],
    });

    const vague = JSON.stringify({
      actions: [{ tool_name: 'note_delete', parameters: { target: { query: 'resistor order' } } }],
    });
    const sharpened = JSON.stringify({
      actions: [
        { tool_name: 'note_delete', parameters: { target: { query: 'resistor order drone' } } },
      ],
    });

    const { provider, orchestrator } = harness({ responses: [vague, sharpened] });
    const first = await orchestrator.interpretAndExecute({
      transcript: 'delete the resistor order note',
    });

    expect(first.clarification!.question).toContain('Which one?');
    // A yes cannot answer this, so it must not be parked as one: replaying the
    // same fuzzy query under `confirmed` would ask it again for ever.
    expect(parsePending(first.clarification!.pending)).toMatchObject({ kind: 'clarify' });

    const second = await orchestrator.interpretAndExecute({
      transcript: 'the drone one',
      pending: first.clarification!.pending!,
    });

    expect(provider.calls).toBe(2);
    // The question it is answering went along with it.
    expect(provider.requests[1]!.messages.map((m) => m.content)).toContain(
      first.clarification!.question,
    );

    // Now that it resolves to one note, the only thing left is the delete's own
    // yes/no — which *is* parked as a confirm, and which a yes finishes locally.
    expect(second.clarification!.question).toContain('Resistor order for the drone');
    expect(parsePending(second.clarification!.pending)).toMatchObject({ kind: 'confirm' });

    const third = await orchestrator.interpretAndExecute({
      transcript: 'yes',
      pending: second.clarification!.pending!,
    });

    expect(provider.calls).toBe(2);
    expect(third.items[0]!.ok).toBe(true);
    expect((await repos.notes.listNotes({})).map((n) => n.titleSummary)).toEqual([
      'Resistor order for the lab',
    ]);
  });

  it('never re-parks a yes/no it already applied, so a stubborn action cannot loop', async () => {
    // Two tasks the query cannot separate; `task_complete` asks which one.
    await repos.tasks.createTask({ title: 'Book ferry tickets' });
    await repos.tasks.createTask({ title: 'Cancel ferry booking' });

    const reply = JSON.stringify({
      actions: [{ tool_name: 'task_complete', parameters: { target: { query: 'ferry' } } }],
    });
    const { orchestrator } = harness({ responses: [reply] });
    const first = await orchestrator.interpretAndExecute({ transcript: 'the ferry thing is done' });

    // This repository reports the ambiguity without candidate ids, so the
    // envelope cannot be chosen by looking for them.
    expect(first.clarification!.question).toContain('Did you mean');
    expect(parsePending(first.clarification!.pending)).toMatchObject({ kind: 'clarify' });
    expect((await repos.tasks.listActiveTasks({})).length).toBe(2);
  });

  it('speaks a friendly failure and audits the error when the model cannot be reached', async () => {
    const { provider, orchestrator } = harness({
      failTimes: 10,
      failWith: new LlmProviderError('network', 'socket hang up', { retryable: false }),
    });

    const outcome = await orchestrator.interpretAndExecute({
      transcript: 'note that I need 10k resistors',
      confidence: 0.4,
    });

    expect(provider.calls).toBe(1);
    expect(outcome.items).toEqual([]);
    expect(outcome.clarification).toBeUndefined();
    expect(outcome.feedback).toBe("I couldn't reach the assistant. Check your connection.");

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('error');
    expect(rows[0]!.error).toContain('offline');
    expect(rows[0]!.confidence).toBe(0.4);
    expect(rows[0]!.feedback).toBe(outcome.feedback);
    expect(rows[0]!.rawResponse).toBeNull();
  });

  it('surfaces the model\'s own question, writes nothing, and lets the next turn answer it', async () => {
    const question = 'When should I book the meeting with Professor Dimitrov?';
    const clarify = JSON.stringify({
      conversational_feedback: 'I need a time first.',
      requires_user_input: true,
      clarification: { question, pending: 'calendar_add: meeting, time unknown' },
      actions: [],
    });
    const booked = JSON.stringify({
      conversational_feedback: 'Booked for Thursday at four.',
      actions: [
        {
          tool_name: 'calendar_add',
          parameters: { title: 'Meeting with Professor Dimitrov', start: '2026-03-12T16:00' },
        },
      ],
    });

    const { provider, orchestrator } = harness({ responses: [clarify, booked] });
    const first = await orchestrator.interpretAndExecute({
      transcript: 'Book a meeting with Professor Dimitrov.',
    });

    expect(first.items).toEqual([]);
    expect(first.clarification!.question).toBe(question);
    expect(parsePending(first.clarification!.pending)).toMatchObject({
      kind: 'clarify',
      hint: 'calendar_add: meeting, time unknown',
    });
    expect((await auditRows())[0]!.status).toBe('clarify');

    const second = await orchestrator.interpretAndExecute({
      transcript: 'Thursday at four',
      pending: first.clarification!.pending!,
    });

    expect(provider.calls).toBe(2);
    expect(second.items[0]!.ok).toBe(true);
    // The follow-up carries the abandoned turn so the fragment has a subject.
    const history = provider.requests[1]!.messages.map((m) => m.content);
    expect(history).toContain('Book a meeting with Professor Dimitrov.');
    expect(history).toContain(question);
  });

  it('summarises from the results when the model says nothing back', async () => {
    const reply = JSON.stringify({
      actions: [
        { tool_name: 'habit_log', parameters: { habit_name: 'Running', note: '5k' } },
        {
          tool_name: 'ledger_add',
          parameters: { amount: 12, currency: 'BGN', category: 'food' },
        },
      ],
    });
    const { orchestrator } = harness({ responses: [reply] });
    const outcome = await orchestrator.interpretAndExecute({ transcript: 'ran 5k, spent 12 leva' });

    expect(outcome.items).toHaveLength(2);
    expect(outcome.feedback).toBe('Done: 2 things.');
  });

  it('still speaks and still audits when a turn throws where it should not', async () => {
    const orchestrator = createOrchestrator({
      repos,
      zone: ZONE,
      client: {
        interpret: async () => {
          throw new Error('the client broke its own contract');
        },
      },
    });

    const outcome = await orchestrator.interpretAndExecute({ transcript: 'note the resistors' });

    expect(outcome.items).toEqual([]);
    expect(outcome.feedback).toBe('Something went wrong on my side. Please try that again.');
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('error');
    expect(rows[0]!.error).toContain('the client broke its own contract');
  });

  it('keeps the turn alive when the audit table cannot be written', async () => {
    const reply = JSON.stringify({
      conversational_feedback: 'Noted.',
      actions: [
        {
          tool_name: 'note_create',
          parameters: { title_summary: 'Resistors', category_tag: 'inbox', bullets: ['10k'] },
        },
      ],
    });
    const provider = createMockProvider({ responses: [reply] });
    const client = createLlmClient({ provider, sleep: async () => {} });
    const orchestrator = createOrchestrator({
      client,
      zone: ZONE,
      repos: {
        ...repos,
        db: {
          ...repos.db,
          insert: () => {
            throw new Error('database is locked');
          },
        } as unknown as RidikDatabase,
      },
    });

    const outcome = await orchestrator.interpretAndExecute({ transcript: 'note the resistors' });
    expect(outcome.items[0]!.ok).toBe(true);
    expect(outcome.feedback).toBe('Noted.');
  });
});

/* ------------------------------------------------------------------ context -- */

describe('buildLlmContext', () => {
  let t: TestDatabase;
  let repos: Repositories;
  let restoreClock: () => void;

  beforeEach(() => {
    setZoneOverride(ZONE);
    restoreClock = freezeClock(NOW);
    t = createTestDatabase();
    repos = buildRepositories(t.db);
  });

  afterEach(() => {
    restoreClock();
    setZoneOverride(null);
    t.close();
  });

  it('fills every section the prompt renders, from the repositories', async () => {
    await repos.curriculum.addEntries([
      {
        subject_name: 'Physics',
        day_of_week: 2,
        start_time: '08:00',
        end_time: '09:30',
        location: 'Lab 2',
      },
    ]);
    const { event } = await repos.calendar.createEventWithBuffer(
      {
        title: 'Dentist',
        startsAt: at(`${MONDAY}T15:00`),
        endsAt: at(`${MONDAY}T16:00`),
        location: 'Clinic on Vitosha',
      },
      { bufferMinutes: 30 },
    );
    expect(event.title).toBe('Dentist');
    await repos.calendar.createEvent({
      title: 'Football',
      startsAt: at(`${TUESDAY}T18:00`),
      endsAt: at(`${TUESDAY}T19:30`),
    });

    const project = await repos.projects.createProject({ name: 'Greece trip', kind: 'trip' });
    await repos.tasks.createTask({ title: 'Book ferry tickets', projectId: project.id });
    await repos.notes.upsertNoteWithBullets({
      titleSummary: 'Order 10k resistors',
      categoryTag: 'electronics',
      bullets: ['Need 10k resistors'],
    });
    await repos.checklists.addItems('Groceries', ['Milk']);
    await repos.crm.getOrCreateEntity('Ivo');
    await repos.places.upsertPlace({ label: 'Home', latitude: 42.7, longitude: 23.3 });
    await repos.ledger.addTransaction({ amount: 12, category: 'food' });
    await repos.habits.getOrCreateHabit('Running');
    await repos.focus.create({ label: 'Physics', phases: [{ kind: 'focus', minutes: 25 }] });

    const context = await buildLlmContext({ repos, now: NOW, zone: ZONE, weekStart: 'monday' });

    expect(context).toMatchObject({ now: NOW, zone: ZONE, weekStart: 'monday' });
    expect(context.upcomingClasses).toEqual([
      {
        subject: 'Physics',
        startsAt: at(`${TUESDAY}T08:00`),
        endsAt: at(`${TUESDAY}T09:30`),
        location: 'Lab 2',
      },
    ]);
    // The travel block the app wrote itself is not an appointment.
    expect(context.todayEvents!.map((e) => e.title)).toEqual(['Dentist']);
    expect(context.tomorrowEvents!.map((e) => e.title)).toEqual(['Football']);
    expect(context.openTasks).toEqual([
      { title: 'Book ferry tickets', dueAt: null, project: 'Greece trip' },
    ]);
    expect(context.projects).toEqual([{ name: 'Greece trip', kind: 'trip' }]);
    expect(context.notes).toEqual([{ title: 'Order 10k resistors', tag: 'electronics' }]);
    expect(context.checklistNames).toEqual(['Groceries']);
    expect(context.crmNames).toEqual(['Ivo']);
    expect(context.placeLabels).toEqual(['Home']);
    expect(context.ledgerCategories).toEqual(['food']);
    expect(context.habitNames).toEqual(['Running']);
    expect(context.focusSession).toMatchObject({ label: 'Physics', status: 'running' });
  });

  it('respects the prompt\'s caps and keeps the soonest tasks', async () => {
    for (let i = 0; i < 30; i++) {
      await repos.tasks.createTask({ title: `Task ${i}`, dueDate: NOW + (i + 1) * 3_600_000 });
    }
    const context = await buildLlmContext({ repos, now: NOW, zone: ZONE });

    expect(context.openTasks).toHaveLength(CONTEXT_CAPS.tasks);
    expect(context.openTasks![0]!.title).toBe('Task 0');
    expect(context.weekStart).toBe('monday');
  });

  /**
   * The tasks cap above is enforced by the repository's own LIMIT, so it would
   * hold with every `slice` in the context deleted. These two are the context's
   * alone: the repositories behind them return everything they have.
   */
  it('caps the sections no repository limits, keeping the soonest classes', async () => {
    await repos.curriculum.addEntries(
      // 3 classes a day, every day: 21 occurrences in the seven-day window.
      [0, 1, 2, 3, 4, 5, 6].flatMap((day) =>
        ['09:00', '11:00', '13:00'].map((start) => ({
          subject_name: `Subject ${day}-${start}`,
          day_of_week: day,
          start_time: start,
          end_time: '23:30',
        })),
      ),
    );
    for (let i = 0; i < 30; i++) await repos.crm.getOrCreateEntity(`Person ${i}`);

    const context = await buildLlmContext({ repos, now: NOW, zone: ZONE });

    expect(context.upcomingClasses).toHaveLength(CONTEXT_CAPS.classes);
    const starts = context.upcomingClasses!.map((c) => c.startsAt);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    // The soonest survives the slice and the latest of the 21 does not.
    expect(starts[0]).toBe(at(`${MONDAY}T09:00`));
    expect(Math.max(...starts)).toBeLessThan(at(`${MONDAY}T08:00`) + 7 * 86_400_000);

    expect(context.crmNames).toHaveLength(CONTEXT_CAPS.crm);
  });

  it('degrades to an empty section rather than failing the turn', async () => {
    const broken = {
      ...repos,
      tasks: {
        ...repos.tasks,
        listActiveTasks: async () => {
          throw new Error('no such table');
        },
      },
    } as unknown as Repositories;

    const context = await buildLlmContext({ repos: broken, now: NOW, zone: ZONE });
    expect(context.openTasks).toEqual([]);
    expect(context.now).toBe(NOW);
  });
});
