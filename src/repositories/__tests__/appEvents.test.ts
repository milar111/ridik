/**
 * The usage ledger, against real SQLite.
 *
 * The ring buffer is the only non-obvious logic in this repository and it is
 * the part that fails silently: a prune that never fires grows a behavioural
 * log on somebody's phone for ever, and a prune that fires too eagerly throws
 * away the counts before anybody reads them. Neither shows up anywhere except
 * here.
 */
import { freezeClock, resetClock } from '@/core/clock';
import { setZoneOverride } from '@/core/time';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import {
  RETAIN_DAYS,
  RETAIN_ROWS,
  createAppEventsRepository,
  type AppEventsRepository,
} from '@/repositories/appEvents';

const ZONE = 'Europe/Sofia';
const DAY = 86_400_000;
const NOW = Date.parse('2026-09-01T09:00:00Z');

describe('the usage ledger', () => {
  let t: TestDatabase;
  let events: AppEventsRepository;

  beforeEach(() => {
    setZoneOverride(ZONE);
    freezeClock(NOW);
    t = createTestDatabase();
    events = createAppEventsRepository(t.db);
  });

  afterEach(() => {
    resetClock();
    setZoneOverride(null);
    t.close();
  });

  it('records an event and reads it back with its props intact', async () => {
    await events.record('turn', {
      mode: 'model',
      input: 'voice',
      actions: 2,
      status: 'ok',
      latency: '1-2s',
      repaired: 0,
    });

    const [row] = await events.recent();
    expect(row?.name).toBe('turn');
    expect(row?.props).toMatchObject({ mode: 'model', status: 'ok', actions: 2 });
    // The local date, in the user's zone — never a clock time.
    expect(row?.localDate).toBe('2026-09-01');
    expect(row?.uploadedAt).toBeNull();
  });

  it('groups by name and by day', async () => {
    await events.record('screen', { route: 'notes' });
    await events.record('screen', { route: 'tasks' });
    await events.record('trial', { state: 'fresh' }, { at: NOW - 2 * DAY });

    expect(await events.countsByName()).toEqual([
      { name: 'screen', count: 2 },
      { name: 'trial', count: 1 },
    ]);
    expect(await events.countsByDay()).toEqual([
      { localDate: '2026-09-01', count: 2 },
      { localDate: '2026-08-30', count: 1 },
    ]);
  });

  it('breaks one event down by its own property', async () => {
    await events.record('tool', { name: 'task_add', ok: 1, confirmed: 0, undone: 0 });
    await events.record('tool', { name: 'task_add', ok: 1, confirmed: 0, undone: 0 });
    await events.record('tool', { name: 'note_create', ok: 0, confirmed: 0, undone: 0 });

    expect(await events.countsByProp('tool', 'name')).toEqual([
      { name: 'task_add', count: 2 },
      { name: 'note_create', count: 1 },
    ]);
  });

  /**
   * The date bound. Anything older than the window goes on the next write —
   * which is what makes an install that is opened twice a year self-limiting
   * without a timer anywhere.
   */
  it('drops rows past the retention window', async () => {
    // Note the window is measured from the *write*, not from the wall clock:
    // an event backdated past the cutoff prunes itself, which is what makes a
    // long-abandoned install bounded without a timer anywhere.
    await events.record('trial', { state: 'fresh' }, { at: NOW - (RETAIN_DAYS + 5) * DAY });
    await events.record('trial', { state: 'fresh' }, { at: NOW - 3 * DAY });
    const inWindow = await events.recent();
    expect(inWindow).toHaveLength(1);
    expect(inWindow[0]?.localDate).toBe('2026-08-29');

    // And a write today keeps the three-day-old one, which is inside it.
    await events.record('trial', { state: 'spent' });
    expect((await events.totals()).rows).toBe(2);
  });

  /**
   * The row bound, and it has to cut the *oldest* — a ring that dropped the
   * newest would be a ledger that stops recording once it is full, which is
   * the opposite of the intent and would look identical from the outside.
   */
  it('holds the row cap by dropping the oldest', async () => {
    // One over the cap, all inside the date window.
    for (let i = 0; i <= RETAIN_ROWS; i += 1) {
      await events.record('screen', { route: 'notes' }, { at: NOW - (RETAIN_ROWS - i) * 1000 });
    }

    const { rows } = await events.totals();
    expect(rows).toBe(RETAIN_ROWS);

    // The survivor set is the newest ones: the very first insert is gone.
    const oldest = await events.recent(RETAIN_ROWS);
    const earliest = Math.min(...oldest.map((r) => r.createdAt));
    expect(earliest).toBeGreaterThan(NOW - RETAIN_ROWS * 1000);
  });

  describe('the upload batch', () => {
    it('offers the unsent rows oldest first, without id or timestamp', async () => {
      await events.record('screen', { route: 'notes' }, { at: NOW - 2000 });
      await events.record('screen', { route: 'tasks' }, { at: NOW - 1000 });

      const batch = await events.unsent();
      expect(batch.events).toEqual([
        { name: 'screen', props: { route: 'notes' }, local_date: '2026-09-01' },
        { name: 'screen', props: { route: 'tasks' }, local_date: '2026-09-01' },
      ]);
      // What travels has no id and no `created_at`. The keys are the whole
      // assertion: the local date is the finest time that leaves the phone.
      for (const event of batch.events) {
        expect(Object.keys(event).sort()).toEqual(['local_date', 'name', 'props']);
      }
    });

    it('stops offering a row once it has been marked', async () => {
      await events.record('trial', { state: 'fresh' });
      const first = await events.unsent();
      await events.markUploaded(first.ids);

      expect((await events.unsent()).events).toHaveLength(0);
      expect((await events.totals()).unsent).toBe(0);
      // The row is still the user's to read; only its send flag moved.
      expect((await events.recent())[0]?.uploadedAt).toBe(NOW);
    });

    it('never re-marks a row, so a duplicate ack cannot rewrite history', async () => {
      await events.record('trial', { state: 'fresh' });
      const batch = await events.unsent();
      await events.markUploaded(batch.ids, NOW);
      await events.markUploaded(batch.ids, NOW + 5000);

      expect((await events.recent())[0]?.uploadedAt).toBe(NOW);
    });
  });

  it('clears everything when the user asks', async () => {
    await events.record('screen', { route: 'notes' });
    await events.record('trial', { state: 'fresh' });
    await events.clear();
    expect(await events.totals()).toEqual({ rows: 0, unsent: 0 });
  });
});
