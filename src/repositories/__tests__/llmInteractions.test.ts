import { freezeClock, resetClock } from '@/core/clock';
import { setZoneOverride } from '@/core/time';
import { llmInteractions } from '@/db/schema';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import {
  createLlmInteractionsRepository,
  parseActions,
  LATENCY_TARGET_P95_MS,
  type LlmInteractionsRepository,
} from '@/repositories/llmInteractions';

const ZONE = 'Europe/Sofia';
const AT = Date.parse('2026-08-11T09:00:00Z');

type TurnInput = {
  id: string;
  transcript: string;
  status?: 'ok' | 'clarify' | 'error';
  actions?: unknown[] | string | null;
  latencyMs?: number | null;
  model?: string | null;
  error?: string | null;
  feedback?: string | null;
  rawResponse?: string | null;
  createdAt?: number;
};

describe('llm interactions', () => {
  let t: TestDatabase;
  let repo: LlmInteractionsRepository;

  /** Writes the shape `src/llm/orchestrator.ts` writes, not a convenient one. */
  const record = async (turn: TurnInput): Promise<void> => {
    await t.db.insert(llmInteractions).values({
      id: turn.id,
      transcript: turn.transcript,
      confidence: null,
      rawResponse: turn.rawResponse ?? null,
      actions:
        turn.actions === undefined
          ? '[]'
          : typeof turn.actions === 'string' || turn.actions === null
            ? turn.actions
            : JSON.stringify(turn.actions),
      feedback: turn.feedback ?? null,
      status: turn.status ?? 'ok',
      error: turn.error ?? null,
      latencyMs: turn.latencyMs === undefined ? 900 : turn.latencyMs,
      model: turn.model === undefined ? 'gemini-2.5-flash' : turn.model,
      createdAt: turn.createdAt ?? AT,
    });
  };

  beforeEach(() => {
    setZoneOverride(ZONE);
    freezeClock(AT);
    t = createTestDatabase();
    repo = createLlmInteractionsRepository(t.db);
  });

  afterEach(() => {
    resetClock();
    setZoneOverride(null);
    t.close();
  });

  /* A privacy-minded person opens this screen before there is anything in it,
     and an empty trail must be an answer rather than a crash. */
  it('reads an untouched table without inventing anything', async () => {
    expect(await repo.listRecent()).toEqual([]);
    expect(await repo.getById('nothing')).toBeNull();
    expect(await repo.stats()).toEqual({
      total: 0,
      ok: 0,
      clarify: 0,
      errors: 0,
      timed: 0,
      medianLatencyMs: null,
      p95LatencyMs: null,
      actionsPerTurn: null,
      models: [],
      oldestAt: null,
      newestAt: null,
    });
  });

  it('lists newest first', async () => {
    await record({ id: 'a', transcript: 'first', createdAt: AT });
    await record({ id: 'b', transcript: 'second', createdAt: AT + 60_000 });
    await record({ id: 'c', transcript: 'third', createdAt: AT + 120_000 });

    expect((await repo.listRecent()).map((row) => row.id)).toEqual(['c', 'b', 'a']);
  });

  /* Tests freeze the clock, and a burst of turns inside one millisecond is
     also perfectly possible on a real device. Ordering by the timestamp alone
     would let SQLite return them in whatever order it liked, so a page taken
     twice could disagree about what was said. */
  it('keeps insertion order when several turns share a millisecond', async () => {
    await record({ id: 'a', transcript: 'first' });
    await record({ id: 'b', transcript: 'second' });
    await record({ id: 'c', transcript: 'third' });

    expect((await repo.listRecent()).map((row) => row.id)).toEqual(['c', 'b', 'a']);
  });

  it('pages back through the trail with a limit and a cursor', async () => {
    for (let i = 0; i < 5; i++) {
      await record({ id: `t${i}`, transcript: `turn ${i}`, createdAt: AT + i * 1000 });
    }

    const page = await repo.listRecent({ limit: 2 });
    expect(page.map((row) => row.id)).toEqual(['t4', 't3']);

    const next = await repo.listRecent({ limit: 2, before: page[page.length - 1]!.createdAt });
    expect(next.map((row) => row.id)).toEqual(['t2', 't1']);
  });

  it('filters to the turns that failed', async () => {
    await record({ id: 'a', transcript: 'add milk' });
    await record({ id: 'b', transcript: 'wht is teh', status: 'error', error: 'network' });
    await record({ id: 'c', transcript: 'which Anna?', status: 'clarify' });

    const failures = await repo.listRecent({ status: 'error' });
    expect(failures.map((row) => row.transcript)).toEqual(['wht is teh']);
    expect(failures[0]!.error).toBe('network');
  });

  /* The parameters are the whole point of expanding a row: "add milk to the
     shopping list" and a `checklist_add` that wrote to "Hardware" look
     identical until you can see what the model actually asked for. */
  it('decodes what the orchestrator wrote, parameters included', async () => {
    await record({
      id: 'a',
      transcript: 'add bolts to the hardware list',
      actions: [
        {
          tool_name: 'checklist_add',
          parameters: { list_name: 'Hardware', items: ['M4 bolts'] },
          ok: true,
          summary: 'Added 1 item to Hardware',
        },
        {
          tool_name: 'task_create',
          parameters: { title: 'Return the drill' },
          ok: false,
          summary: 'Could not create that',
          error: 'validation',
        },
      ],
    });

    const [row] = await repo.listRecent();
    expect(row!.parsedActions).toEqual([
      {
        toolName: 'checklist_add',
        parameters: { list_name: 'Hardware', items: ['M4 bolts'] },
        ok: true,
        summary: 'Added 1 item to Hardware',
        error: null,
        asked: null,
      },
      {
        toolName: 'task_create',
        parameters: { title: 'Return the drill' },
        ok: false,
        summary: 'Could not create that',
        error: 'validation',
        asked: null,
      },
    ]);
  });

  it('carries the question through when the assistant asked instead of acting', async () => {
    await record({
      id: 'a',
      transcript: 'call anna',
      status: 'clarify',
      actions: [
        {
          tool_name: 'crm_log',
          parameters: { name: 'anna' },
          ok: false,
          summary: 'Which Anna?',
          asked: 'Anna Petrova or Anna Ivanova?',
        },
      ],
    });

    const [row] = await repo.listRecent();
    expect(row!.parsedActions[0]!.asked).toBe('Anna Petrova or Anna Ivanova?');
  });

  /* An audit row is evidence. A shape this app no longer writes must still
     render whatever of it can be read — losing the transcript because a JSON
     column went bad is the one failure this screen cannot have. */
  it('survives an actions column it cannot read', async () => {
    await record({ id: 'a', transcript: 'still readable', actions: 'not json at all' });
    await record({ id: 'b', transcript: 'also readable', actions: null });
    await record({ id: 'c', transcript: 'and this one', actions: '{"not":"an array"}' });

    const rows = await repo.listRecent();
    expect(rows.map((row) => row.transcript)).toEqual([
      'and this one',
      'also readable',
      'still readable',
    ]);
    expect(rows.every((row) => row.parsedActions.length === 0)).toBe(true);
  });

  it('reads one turn by id', async () => {
    await record({ id: 'a', transcript: 'log 45 minutes of workout', feedback: 'Logged that.' });

    const row = await repo.getById('a');
    expect(row?.transcript).toBe('log 45 minutes of workout');
    expect(row?.feedback).toBe('Logged that.');
  });

  describe('stats', () => {
    /* A mean would be dragged somewhere no turn ever was by one cold start or
       one repair ladder, so both numbers are latencies a real turn took. */
    it('reports the middle turn and the bad one, never a mean', async () => {
      for (const [i, ms] of [120, 400, 800, 1500, 9000].entries()) {
        await record({ id: `t${i}`, transcript: `turn ${i}`, latencyMs: ms });
      }

      const stats = await repo.stats();
      expect(stats.timed).toBe(5);
      expect(stats.medianLatencyMs).toBe(800);
      expect(stats.p95LatencyMs).toBe(9000);
    });

    it('ignores turns that never recorded a latency', async () => {
      await record({ id: 'a', transcript: 'one', latencyMs: 200 });
      await record({ id: 'b', transcript: 'two', latencyMs: null });
      await record({ id: 'c', transcript: 'three', latencyMs: null });

      const stats = await repo.stats();
      expect(stats.total).toBe(3);
      expect(stats.timed).toBe(1);
      expect(stats.medianLatencyMs).toBe(200);
      expect(stats.p95LatencyMs).toBe(200);
    });

    it('counts each outcome separately', async () => {
      await record({ id: 'a', transcript: 'one' });
      await record({ id: 'b', transcript: 'two' });
      await record({ id: 'c', transcript: 'three', status: 'error' });
      await record({ id: 'd', transcript: 'four', status: 'clarify' });

      expect(await repo.stats()).toMatchObject({ total: 4, ok: 2, errors: 1, clarify: 1 });
    });

    it('averages the tool calls behind an utterance', async () => {
      await record({ id: 'a', transcript: 'one', actions: [{ tool_name: 'task_create', ok: true }] });
      await record({
        id: 'b',
        transcript: 'two',
        actions: [
          { tool_name: 'task_create', ok: true },
          { tool_name: 'calendar_create', ok: true },
          { tool_name: 'note_create', ok: true },
        ],
      });

      expect((await repo.stats()).actionsPerTurn).toBe(2);
    });

    /* A row with unreadable JSON must not take the header down with it — the
       whole screen is built on the assumption that a bad row costs one row. */
    it('still aggregates around an unreadable actions column', async () => {
      await record({ id: 'a', transcript: 'one', actions: [{ tool_name: 'task_create', ok: true }] });
      await record({ id: 'b', transcript: 'two', actions: 'not json' });

      const stats = await repo.stats();
      expect(stats.total).toBe(2);
      expect(stats.actionsPerTurn).toBe(0.5);
    });

    it('names every model the trail was answered by, busiest first', async () => {
      await record({ id: 'a', transcript: 'one', model: 'gemini-2.5-flash' });
      await record({ id: 'b', transcript: 'two', model: 'gemini-2.5-flash' });
      await record({ id: 'c', transcript: 'three', model: 'offline' });
      await record({ id: 'd', transcript: 'four', model: null });

      expect((await repo.stats()).models).toEqual([
        { model: 'gemini-2.5-flash', turns: 2 },
        { model: 'offline', turns: 1 },
      ]);
    });

    it('reports the span the trail covers', async () => {
      await record({ id: 'a', transcript: 'one', createdAt: AT });
      await record({ id: 'b', transcript: 'two', createdAt: AT + 3_600_000 });

      expect(await repo.stats()).toMatchObject({ oldestAt: AT, newestAt: AT + 3_600_000 });
    });
  });

  /*
   * The number the app has always written and never read.
   *
   * A lifetime median is the wrong instrument for "did it get slower?" — a
   * thousand fast turns bury the hundred slow ones that came after them — so
   * this is a window, and the window is what the tests are about.
   */
  describe('latency', () => {
    it('reports the middle turn and the slow tail, never a mean', async () => {
      for (const [i, ms] of [120, 400, 800, 1500, 9000].entries()) {
        await record({ id: `t${i}`, transcript: `turn ${i}`, latencyMs: ms });
      }

      const latency = await repo.latency();
      expect(latency.timed).toBe(5);
      expect(latency.turns).toBe(5);
      expect(latency.medianMs).toBe(800);
      expect(latency.p95Ms).toBe(9000);
      expect(latency.slowestMs).toBe(9000);
    });

    /* The whole point of the window: the fast history must not hide the slow
       present. Fifty 200ms turns and then ten 6s ones is an app that got worse,
       and a lifetime median calls it 200ms. */
    it('looks only at the most recent turns', async () => {
      for (let i = 0; i < 50; i++) {
        await record({ id: `old${i}`, transcript: 'old', latencyMs: 200, createdAt: AT + i });
      }
      for (let i = 0; i < 10; i++) {
        await record({ id: `new${i}`, transcript: 'new', latencyMs: 6_000, createdAt: AT + 100 + i });
      }

      expect(await repo.latency({ window: 10 })).toMatchObject({
        window: 10,
        turns: 10,
        timed: 10,
        medianMs: 6_000,
        p95Ms: 6_000,
      });
      // And the lifetime figures are still there, still saying the other thing.
      expect((await repo.stats()).medianLatencyMs).toBe(200);
    });

    /* The window counts turns, not timed turns. Cutting the timed rows instead
       would reach further back the more turns went untimed, and "lately" would
       quietly come to mean a fortnight. */
    it('counts untimed turns against the window rather than reaching past them', async () => {
      await record({ id: 'a', transcript: 'timed', latencyMs: 5_000, createdAt: AT });
      for (let i = 0; i < 4; i++) {
        await record({ id: `n${i}`, transcript: 'untimed', latencyMs: null, createdAt: AT + 1 + i });
      }

      const latency = await repo.latency({ window: 4 });
      expect(latency.turns).toBe(4);
      expect(latency.timed).toBe(0);
      expect(latency.medianMs).toBeNull();
      expect(latency.p95Ms).toBeNull();
    });

    it('says whether the tail clears the target, and never guesses on no data', async () => {
      expect(await repo.latency()).toMatchObject({
        turns: 0,
        timed: 0,
        medianMs: null,
        p95Ms: null,
        // "We did not measure" must never render as "fine".
        withinTarget: null,
      });

      await record({ id: 'fast', transcript: 'quick', latencyMs: LATENCY_TARGET_P95_MS - 1 });
      expect((await repo.latency()).withinTarget).toBe(true);

      await record({ id: 'slow', transcript: 'crawl', latencyMs: LATENCY_TARGET_P95_MS + 1 });
      expect((await repo.latency()).withinTarget).toBe(false);
    });

    it('never reports more turns than there are', async () => {
      await record({ id: 'a', transcript: 'one', latencyMs: 300 });

      expect(await repo.latency({ window: 100 })).toMatchObject({ window: 100, turns: 1 });
    });

    /* A window of 0 or -1 would be a LIMIT that answers nothing, and the caller
       would read it as "nothing has been slow". */
    it('refuses a window that is not at least one turn', async () => {
      await record({ id: 'a', transcript: 'one', latencyMs: 300 });

      for (const window of [0, -5, 1.7]) {
        expect(await repo.latency({ window })).toMatchObject({ window: 1, medianMs: 300 });
      }
    });
  });

  describe('forgetting', () => {
    it('removes one turn and says whether there was one', async () => {
      await record({ id: 'a', transcript: 'one' });

      expect(await repo.remove('a')).toBe(true);
      expect(await repo.remove('a')).toBe(false);
      expect(await repo.listRecent()).toEqual([]);
    });

    /* "Clear" on a privacy surface has to really clear: the transcript is the
       only record of what was said, because the audio is thrown away. */
    it('clears every transcript and reports how many went', async () => {
      await record({ id: 'a', transcript: 'my salary is' });
      await record({ id: 'b', transcript: 'the doctor said' });

      expect(await repo.clear()).toBe(2);
      expect(await repo.listRecent()).toEqual([]);
      expect(await repo.stats()).toMatchObject({ total: 0, medianLatencyMs: null });
      // Not merely absent from the repository's own reads — gone from the table.
      expect(t.client.getAllSync('SELECT id FROM llm_interactions', [])).toEqual([]);
    });

    it('clears an already-empty trail without complaining', async () => {
      expect(await repo.clear()).toBe(0);
    });
  });
});

describe('parseActions', () => {
  it('reads a missing ok as a failure rather than a success', () => {
    expect(parseActions('[{"tool_name":"task_create"}]')).toEqual([
      { toolName: 'task_create', parameters: null, ok: false, summary: null, error: null, asked: null },
    ]);
  });

  it('names an action it cannot identify rather than dropping it', () => {
    expect(parseActions('[{"ok":true}]')[0]!.toolName).toBe('unknown');
  });

  it('answers nothing for nothing', () => {
    expect(parseActions(null)).toEqual([]);
    expect(parseActions('')).toEqual([]);
  });
});
