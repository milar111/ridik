import { freezeClock } from '@/core/clock';
import type { ConfirmMode } from '../confirm';
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
import { createLlmInteractionsRepository } from '@/repositories/llmInteractions';
import { createNotesRepository } from '@/repositories/notes';
import { createPlacesRepository } from '@/repositories/places';
import { createProjectsRepository } from '@/repositories/projects';
import { createAppEventsRepository } from '@/repositories/appEvents';
import { LATENCY_BUCKETS } from '@/services/analytics/events';
import { createSettingsRepository } from '@/repositories/settings';
import { createSyncQueueRepository } from '@/repositories/syncQueue';
import { createTasksRepository } from '@/repositories/tasks';
import { createUsageRepository } from '@/repositories/usage';

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
    appEvents: createAppEventsRepository(db),
    calendar: createCalendarEventsRepository(db),
    checklists: createChecklistsRepository(db),
    crm: createCrmRepository(db),
    curriculum: createCurriculumRepository(db),
    focus: createFocusSessionsRepository(db),
    geofences: createGeofencesRepository(db),
    habits: createHabitsRepository(db),
    ledger: createLedgerRepository(db),
    llmInteractions: createLlmInteractionsRepository(db),
    notes: createNotesRepository(db),
    places: createPlacesRepository(db),
    projects: createProjectsRepository(db),
    settings: createSettingsRepository(db),
    syncQueue: createSyncQueueRepository(db),
    tasks: createTasksRepository(db),
    usage: createUsageRepository(db),
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

  function harness(options: MockProviderOptions, confirmMode: ConfirmMode = 'never') {
    const provider = createMockProvider(options);
    const client = createLlmClient({ provider, sleep: async () => {} });
    const orchestrator = createOrchestrator({ repos, client, zone: ZONE, confirmMode });
    return { provider, orchestrator };
  }

  const auditRows = () => t.db.select().from(llmInteractions);

  /**
   * The ledger's side of the same convergence point.
   *
   * `audit()` is where every path through a turn meets, and counting there is
   * what makes the Usage screen complete without any call site remembering to
   * report. This asserts that — one turn produces one `turn` row and one `tool`
   * row per action — and, just as importantly, that nothing the user said got
   * into either of them.
   */
  const countedEvents = async () => (await repos.appEvents.recent()).map((row) => row);

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

  it('counts the turn and its tools, and puts nothing that was said into them', async () => {
    // The same fixture the sibling test above needs: one of the three intents
    // resolves against an existing event, and without it the turn errors.
    await repos.calendar.createEvent({
      title: 'Math homework',
      startsAt: at(`${TUESDAY}T18:00`),
      endsAt: at(`${TUESDAY}T19:00`),
    });

    const { orchestrator } = harness({ responses: [THREE_INTENT_REPLY] });
    await orchestrator.interpretAndExecute({ transcript: THREE_INTENTS, confidence: 0.93 });

    const events = await countedEvents();
    const turns = events.filter((e) => e.name === 'turn');
    const tools = events.filter((e) => e.name === 'tool');

    expect(turns).toHaveLength(1);
    expect(turns[0]?.props).toMatchObject({ mode: 'model', status: 'ok', actions: 3 });
    // A bucket, never a number of milliseconds.
    expect(LATENCY_BUCKETS).toContain(turns[0]?.props.latency);
    expect(tools).toHaveLength(3);

    /*
     * The property the whole vocabulary exists for. The utterance that produced
     * these rows mentions a person, a subject and a quantity; if any of it can
     * be reconstructed from the ledger then the closed union has a hole in it,
     * and this is the test that would find it.
     */
    const serialised = JSON.stringify(events);
    for (const fragment of THREE_INTENTS.split(/\s+/).filter((w) => w.length > 4)) {
      expect(serialised.toLowerCase()).not.toContain(fragment.toLowerCase());
    }
    // And the local date is the finest time any of it records.
    for (const event of events) expect(event.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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

  /**
   * The double-ask, and the one-way rule that survives fixing it.
   *
   * RULE 4 makes the model's own question concrete — "Book it Thursday at
   * 16:00?" — so a yes to it *is* an answer to the review gate's "is this what
   * you said?". Before this, that yes bought a second identical question from
   * the gate, which reads as the app not having listened.
   */
  it('does not ask the review gate again after a yes to the model\'s own question', async () => {
    const clarify = JSON.stringify({
      conversational_feedback: 'I need a time first.',
      requires_user_input: true,
      clarification: { question: 'Book it Thursday at 16:00?', pending: 'calendar_add' },
      actions: [],
    });
    const booked = JSON.stringify({
      actions: [
        {
          tool_name: 'calendar_add',
          parameters: { title: 'Meeting with Ivo', start: '2026-03-12T16:00' },
        },
      ],
    });

    // `always`, so the gate would certainly fire if the yes did not release it.
    const { orchestrator } = harness({ responses: [clarify, booked] }, 'always');
    const first = await orchestrator.interpretAndExecute({ transcript: 'book a meeting with Ivo' });

    const second = await orchestrator.interpretAndExecute({
      transcript: 'yes',
      pending: first.clarification!.pending!,
    });

    expect(second.items[0]!.ok).toBe(true);
    // Nothing left to answer: the turn carries no further question.
    expect(second.clarification).toBeUndefined();
    expect(await repos.calendar.listBetween(0, Number.MAX_SAFE_INTEGER)).toHaveLength(1);
  });

  /**
   * The half that must not be released with it. `reviewed` answers "is this
   * what you said?" and says nothing about what the stored data looks like, so
   * a clash the proposal could not have known about still gets its own
   * question.
   */
  it('still lets a handler ask about something the proposal could not contain', async () => {
    await repos.calendar.createEvent({
      title: 'Dentist',
      startsAt: at('2026-03-12T16:00'),
      endsAt: at('2026-03-12T17:00'),
    });

    const clarify = JSON.stringify({
      requires_user_input: true,
      clarification: { question: 'Book it Thursday at 16:00?', pending: 'calendar_add' },
      actions: [],
    });
    const booked = JSON.stringify({
      actions: [
        {
          tool_name: 'calendar_add',
          parameters: { title: 'Meeting with Ivo', start: '2026-03-12T16:00' },
        },
      ],
    });

    const { orchestrator } = harness({ responses: [clarify, booked] }, 'always');
    const first = await orchestrator.interpretAndExecute({ transcript: 'book a meeting with Ivo' });
    const second = await orchestrator.interpretAndExecute({
      transcript: 'yes',
      pending: first.clarification!.pending!,
    });

    // The handler's question is hoisted onto the turn, which is where the dock
    // reads it from — the item keeps it as its summary.
    expect(second.clarification?.question).toMatch(/dentist/i);
    expect(second.items[0]!.ok).toBe(false);
    expect(await repos.calendar.listBetween(0, Number.MAX_SAFE_INTEGER)).toHaveLength(1);
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

  /* A degraded turn succeeds, so nothing else in the row would ever show that
     the model failed three times and the offline engine answered. Without this
     line in the audit trail, "why did my expense become a note?" has no answer
     anywhere in the app. */
  it('records that a turn was answered offline after the model gave up', async () => {
    const { provider, orchestrator } = harness({
      responses: ['not json', 'still not json', '{"actions": "not an array"}'],
    });
    const outcome = await orchestrator.interpretAndExecute({
      transcript: 'spent 12 leva on lunch',
      confidence: 0.9,
    });

    expect(provider.calls).toBe(3);
    // The utterance was captured rather than thrown away.
    expect(outcome.items).toHaveLength(1);
    expect(outcome.items[0]!.toolName).toBe('ledger_add');
    expect(outcome.feedback).toContain('offline');

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('ok');
    expect(rows[0]!.error).toContain('degraded to offline');
    // The raw reply kept is the model's own, not the one we substituted for it.
    expect(rows[0]!.rawResponse).toBe('{"actions": "not an array"}');
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
    expect(outcome.failed).toBe(true);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('error');
    expect(rows[0]!.error).toContain('the client broke its own contract');
  });

  /**
   * The turn that never ran has to *say* it never ran.
   *
   * `interpretAndExecute` is designed never to throw, so a dead network comes
   * back as a resolved outcome with an apology in it and no items — which is
   * byte-identical to a turn that ran and decided to do nothing. The voice
   * store was reading exactly that difference to decide whether the sentence
   * had been answered, so a long dictation that timed out was filed as answered
   * and the words were dropped on the next mic tap. The flag is the only thing
   * that tells the two apart.
   */
  it('says outright when the model was never reached', async () => {
    const provider = createMockProvider({
      // Unauthorised rather than a retryable code: one call, no ladder, and the
      // shape a dead key or a dropped connection actually takes.
      failTimes: 1,
      failWith: new LlmProviderError('unauthorized', 'the request never landed', { status: 401 }),
    });
    const orchestrator = createOrchestrator({
      repos,
      zone: ZONE,
      client: createLlmClient({ provider, sleep: async () => {} }),
    });

    const outcome = await orchestrator.interpretAndExecute({
      transcript: 'note that the lab needs 10k resistors and a new soldering tip',
    });

    expect(outcome.items).toEqual([]);
    expect(outcome.failed).toBe(true);
    // Still audited, and still carrying a sentence to say — the flag is about
    // what happened, not about going quiet.
    expect(outcome.feedback).toBeTruthy();
    const rows = await auditRows();
    expect(rows[0]!.status).toBe('error');
  });

  /* And a turn that genuinely ran and wrote nothing must not claim it failed,
     or the recovery card would appear over work that was understood. */
  it('does not flag a turn that ran and simply had nothing to do', async () => {
    const provider = createMockProvider({
      responses: [JSON.stringify({ conversational_feedback: 'Nothing to do.', actions: [] })],
    });
    const orchestrator = createOrchestrator({
      repos,
      zone: ZONE,
      client: createLlmClient({ provider, sleep: async () => {} }),
    });

    const outcome = await orchestrator.interpretAndExecute({ transcript: 'thanks' });

    expect(outcome.items).toEqual([]);
    expect(outcome.failed).toBeUndefined();
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
  /**
   * The review gate, through the real turn.
   *
   * Asserted here rather than only in `confirm.test.ts` because the unit there
   * proves the *rule* and this proves the *plumbing*: that a parked write really
   * writes nothing, that the question reaches the user with the mis-hearable
   * words in it, and that yes applies the same action rather than re-asking. The
   * yes/no path already existed for clashes and deletions; this is the first
   * thing to ride it that the model was not itself unsure about.
   */
  describe('the review gate', () => {
    const NOTE_REPLY = JSON.stringify({
      actions: [
        {
        tool_name: 'note_create',
        parameters: { title_summary: 'Shopping', category_tag: 'errands', bullets: ['milk'] },
      },
      ],
      speech: 'Saved.',
    });

    it('writes nothing and asks, naming what it heard', async () => {
      const { orchestrator } = harness({ responses: [NOTE_REPLY] }, 'irreversible');
      const outcome = await orchestrator.interpretAndExecute({ transcript: 'note milk on shopping' });

      expect(await repos.notes.listNotes()).toHaveLength(0);
      const asked = outcome.clarification?.question ?? outcome.feedback ?? '';
      expect(asked).toContain('Shopping');
      expect(asked).toContain('milk');
    });

    it('applies it once the user says yes', async () => {
      const { orchestrator } = harness({ responses: [NOTE_REPLY] }, 'irreversible');
      const asked = await orchestrator.interpretAndExecute({ transcript: 'note milk on shopping' });
      expect(await repos.notes.listNotes()).toHaveLength(0);

      await orchestrator.interpretAndExecute({
        transcript: 'yes',
        ...(asked.clarification?.pending ? { pending: asked.clarification.pending } : {}),
      });
      expect(await repos.notes.listNotes()).toHaveLength(1);
    });

    const TASK_REPLY = JSON.stringify({
      actions: [{ tool_name: 'task_add', parameters: { title: 'call Dad' } }],
      speech: 'Added.',
    });

    it('does not stand between the user and a task they can undo', async () => {
      const { orchestrator } = harness({ responses: [TASK_REPLY] }, 'irreversible');
      await orchestrator.interpretAndExecute({ transcript: 'add a task to call Dad' });
      expect(await repos.tasks.listActiveTasks()).toHaveLength(1);
    });

    /* The confidence was already measured, already carried in `TurnInput` and
       already audited; until it reached the executor it decided nothing, so a
       barely-understood sentence wrote a row exactly like a crisp one. */
    it('holds that same task back when it barely heard the words', async () => {
      const { orchestrator } = harness({ responses: [TASK_REPLY] }, 'irreversible');
      const outcome = await orchestrator.interpretAndExecute({
        transcript: 'add a task to call Dad',
        confidence: 0.72,
      });

      expect(await repos.tasks.listActiveTasks()).toHaveLength(0);
      expect(outcome.clarification?.question ?? '').toContain('call Dad');

      // And a yes still finishes the job, on the path that already existed.
      await orchestrator.interpretAndExecute({
        transcript: 'yes',
        ...(outcome.clarification?.pending ? { pending: outcome.clarification.pending } : {}),
      });
      expect(await repos.tasks.listActiveTasks()).toHaveLength(1);
    });

    it('lets it through again once the recogniser is sure', async () => {
      const { orchestrator } = harness({ responses: [TASK_REPLY] }, 'irreversible');
      await orchestrator.interpretAndExecute({
        transcript: 'add a task to call Dad',
        confidence: 0.97,
      });
      expect(await repos.tasks.listActiveTasks()).toHaveLength(1);
    });

    /* Money is the one domain where the wrong value is unnoticed rather than
       visible, so it does not get to be waved through by a good score. */
    it('shows a transaction first however cleanly it was heard', async () => {
      const { orchestrator } = harness(
        {
          responses: [
            JSON.stringify({
              actions: [
                {
                  tool_name: 'ledger_add',
                  parameters: { amount: 15, currency: 'EUR', category: 'food' },
                },
              ],
              speech: 'Logged.',
            }),
          ],
        },
        'irreversible',
      );
      const outcome = await orchestrator.interpretAndExecute({
        transcript: 'spent fifteen euros on lunch',
        confidence: 0.99,
      });

      expect(await repos.ledger.listRecent()).toHaveLength(0);
      // The amount is the thing that might be wrong, so it has to be readable.
      expect(outcome.clarification?.question ?? '').toContain('15');
    });

    /**
     * The gate must not disarm the checks that run underneath it.
     *
     * Both questions used to be released by one `confirmed` flag, so the review
     * preview — which is built before any handler has looked at the calendar and
     * therefore cannot mention a clash — swallowed the clash question whole. The
     * result was the exact inversion of the feature: an utterance heard *well*
     * kept the double-booking guard, and one heard badly lost it.
     */
    it('still asks about a clash the preview never mentioned', async () => {
      await repos.calendar.createEvent({
        title: 'Dentist',
        startsAt: at(`${WEDNESDAY}T15:00`),
        endsAt: at(`${WEDNESDAY}T16:00`),
      });

      const { orchestrator } = harness(
        {
          responses: [
            JSON.stringify({
              actions: [
                { tool_name: 'calendar_add', parameters: { title: 'Gym', start: `${WEDNESDAY}T15:00` } },
              ],
              speech: 'Booked.',
            }),
          ],
        },
        'irreversible',
      );

      // Heard badly enough for the gate to fire; `calendar_add` is reversible,
      // so nothing else would have stopped it.
      const review = await orchestrator.interpretAndExecute({
        transcript: 'book gym at three',
        confidence: 0.8,
      });
      expect(review.clarification?.question ?? '').toContain('Gym');
      expect(review.clarification?.question ?? '').not.toContain('Dentist');

      const clash = await orchestrator.interpretAndExecute({
        transcript: 'yes',
        confidence: 0.8,
        ...(review.clarification?.pending ? { pending: review.clarification.pending } : {}),
      });

      // Nothing written yet, and the second question is the one the first never
      // asked — by name.
      expect(await repos.calendar.listForLocalDate(WEDNESDAY, ZONE)).toHaveLength(1);
      expect(clash.clarification?.question ?? '').toContain('Dentist');
      expect(parsePending(clash.clarification!.pending)).toMatchObject({ kind: 'confirm' });

      // And a second yes finishes it, rather than looping on the same question.
      await orchestrator.interpretAndExecute({
        transcript: 'yes',
        confidence: 0.8,
        ...(clash.clarification?.pending ? { pending: clash.clarification.pending } : {}),
      });
      const day = await repos.calendar.listForLocalDate(WEDNESDAY, ZONE);
      expect(day.map((row) => row.title).sort()).toEqual(['Dentist', 'Gym']);
    });

    /**
     * Two blocked actions, one question, and the dock has room for exactly one.
     * Read positionally the sentence is about milk and the amount appears
     * nowhere — while the yes that answers it runs both. `ALWAYS_ASKS` exists
     * because a mis-heard fifty is invisible for ever, so it leads.
     */
    it('reads the money back, not whichever action the model listed first', async () => {
      const { orchestrator } = harness(
        {
          responses: [
            JSON.stringify({
              actions: [
                { tool_name: 'checklist_add', parameters: { list_name: 'shopping', items: ['milk'] } },
                {
                  tool_name: 'ledger_add',
                  parameters: { amount: 50, currency: 'EUR', category: 'groceries' },
                },
              ],
              speech: 'Done.',
            }),
          ],
        },
        'irreversible',
      );

      const outcome = await orchestrator.interpretAndExecute({
        transcript: 'add milk to the shopping list and log fifty euros on groceries',
        confidence: 0.97,
      });

      const question = outcome.clarification?.question ?? '';
      expect(question).toContain('50');
      expect(question).toContain('1 other thing');
      expect(await repos.ledger.listRecent()).toHaveLength(0);

      // The list still gets its item: only the *question* is re-ordered, never
      // the actions, which routinely depend on each other in source order.
      const pending = parsePending(outcome.clarification!.pending);
      expect(pending).toMatchObject({ kind: 'confirm' });
      expect(
        (pending as { actions: { tool_name: string }[] }).actions.map((a) => a.tool_name),
      ).toEqual(['checklist_add', 'ledger_add']);
    });
  });

  /*
   * The wiring for `./recall`, asserted here because the module being correct
   * and the module being *reached* are different claims, and only one of them
   * had ever been true. History used to be built for a pending clarification
   * and nothing else, so two sentences twenty seconds apart were two unrelated
   * conversations and the second one arrived with no subject.
   */
  describe('carrying the conversation', () => {
    const REPLY = JSON.stringify({
      conversational_feedback: 'Added flowers to the shopping list.',
      requires_user_input: false,
      actions: [
        { tool_name: 'checklist_add', parameters: { list_name: 'Shopping', items: ['flowers'] } },
      ],
    });
    const SECOND = JSON.stringify({
      conversational_feedback: 'On the shopping list too.',
      requires_user_input: false,
      actions: [
        {
          tool_name: 'checklist_add',
          parameters: { list_name: 'Shopping', items: ['toilet paper'] },
        },
      ],
    });

    it('hands the model what was said a moment ago, and what it wrote', async () => {
      const { provider, orchestrator } = harness({ responses: [REPLY, SECOND] });

      await orchestrator.interpretAndExecute({ transcript: 'Add flowers to my list.' });
      await orchestrator.interpretAndExecute({ transcript: 'Toilet paper.' });

      const second = provider.requests[1]!;
      const said = second.messages.filter((m) => m.role === 'user').map((m) => m.content);
      expect(said).toContain('Add flowers to my list.');
      // Last, because the current utterance is the one being answered.
      expect(said[said.length - 1]).toBe('Toilet paper.');

      // And the row that was written, which is the half the model cannot infer:
      // the user said "my list" and the executor wrote "Shopping".
      const told = second.messages.filter((m) => m.role === 'model').map((m) => m.content);
      expect(told.join(' ')).toContain('Shopping');
    });

    it('sends no history at all on the first utterance of a conversation', async () => {
      const { provider, orchestrator } = harness({ responses: [REPLY] });
      await orchestrator.interpretAndExecute({ transcript: 'Add flowers to my list.' });
      expect(provider.requests[0]!.messages.map((m) => m.content)).toEqual([
        'Add flowers to my list.',
      ]);
    });

    /*
      A clarify turn is audited like any other, so the exchange it is waiting on
      is already the newest row in the window. Appending the pending pair on top
      of it showed the model the user saying the same sentence in consecutive
      breaths — which reads as a repeat, and a repeat is a reason to act twice.
    */
    it('does not say the pending question twice', async () => {
      const ASK = JSON.stringify({
        conversational_feedback: 'I need a time first.',
        requires_user_input: true,
        clarification: { question: 'Book it tomorrow at 10:00?', pending: 'calendar_add: meeting' },
        actions: [],
      });
      const { provider, orchestrator } = harness({ responses: [ASK, REPLY] });

      const first = await orchestrator.interpretAndExecute({
        transcript: 'Book a meeting with Ivo.',
      });
      await orchestrator.interpretAndExecute({
        transcript: 'make it Thursday',
        pending: first.clarification!.pending,
      });

      const said = provider.requests[1]!.messages
        .filter((m) => m.role === 'user')
        .map((m) => m.content);
      expect(said.filter((line) => line === 'Book a meeting with Ivo.')).toHaveLength(1);
    });

    /* The trail is a convenience, never a precondition: losing the context of a
       fragment is a worse answer, not a failed turn. */
    it('still runs the turn when the trail cannot be read', async () => {
      const provider = createMockProvider({ responses: [REPLY] });
      const client = createLlmClient({ provider, sleep: async () => {} });
      const blind = {
        ...repos,
        llmInteractions: {
          ...repos.llmInteractions,
          listRecent: async () => {
            throw new Error('no such table');
          },
        },
      } as unknown as Repositories;

      const outcome = await createOrchestrator({
        repos: blind,
        client,
        zone: ZONE,
        confirmMode: 'never',
      }).interpretAndExecute({ transcript: 'Add flowers to my list.' });

      expect(outcome.items).toHaveLength(1);
      expect(outcome.items[0]!.ok).toBe(true);
    });
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
