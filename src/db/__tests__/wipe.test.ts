import { isSettingKey } from '@/repositories/settings';

import { createTestDatabase, type TestDatabase } from '../testing';
import { listUserTables, wipeAllTables, PRESERVED_SETTINGS } from '../wipe';

describe('wipeAllTables', () => {
  let database: TestDatabase;

  beforeEach(() => {
    database = createTestDatabase();
  });
  afterEach(() => database.close());

  const seed = () => {
    database.client.runSync(
      `INSERT INTO tasks (id, title, priority, is_completed, created_at, updated_at)
       VALUES (?, ?, 2, 0, 1, 1)`,
      ['t1', 'buy milk'],
    );
    database.client.runSync(
      `INSERT INTO notes_fts (note_id, title, tag, body) VALUES (?, ?, ?, ?)`,
      ['n1', 'lab notes', 'work', 'the reaction ran hot'],
    );
  };

  it('never hands SQLite an FTS shadow table', () => {
    const names = listUserTables(database.client);
    expect(names).toContain('notes_fts');
    expect(names).not.toContain('notes_fts_data');
    expect(names).not.toContain('notes_fts_config');
  });

  /* The whole wipe runs in one transaction, so a single unwritable table does
     not merely skip a row — it rolls back every delete before it and the user
     who typed ERASE keeps all their data. */
  it('actually empties the database rather than rolling back on the FTS index', () => {
    seed();

    expect(wipeAllTables(database.client)).toBeGreaterThan(0);

    expect(database.client.getAllSync('SELECT id FROM tasks', [])).toEqual([]);
    expect(
      database.client.getAllSync(`SELECT note_id FROM notes_fts WHERE notes_fts MATCH 'reaction'`, []),
    ).toEqual([]);
  });

  it('leaves the schema usable, search included', () => {
    seed();
    wipeAllTables(database.client);

    database.client.runSync(
      `INSERT INTO notes_fts (note_id, title, tag, body) VALUES (?, ?, ?, ?)`,
      ['n2', 'after', 'work', 'still searchable'],
    );
    expect(
      database.client.getAllSync<{ note_id: string }>(
        `SELECT note_id FROM notes_fts WHERE notes_fts MATCH 'searchable'`,
        [],
      ),
    ).toEqual([{ note_id: 'n2' }]);
  });

  /**
   * "Erase everything" was a full reset of every spend control in the app.
   *
   * It walks `sqlite_master`, so it took `app_settings` — the only home of the
   * free trial's lifetime counters — and `llm_usage`, the only home of the
   * spend meter. Burn the 25 free requests, tap Delete, type ERASE, and the
   * next utterance reads a fresh trial over a zeroed day and month. Repeat
   * forever, no reinstall and no developer mode. Somebody whose goal is free
   * model calls has nothing to lose by deleting notes they never wrote.
   */
  describe('what a wipe must not reset', () => {
    const spend = () => {
      database.client.runSync(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, 1)`,
        ['llmTrialRequestsUsed', '25'],
      );
      database.client.runSync(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, 1)`,
        ['llmTrialTokensUsed', '600000'],
      );
      database.client.runSync(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, 1)`,
        ['ttsEnabled', 'true'],
      );
      database.client.runSync(
        `INSERT INTO llm_usage (local_date, requests, input_tokens, output_tokens, cost_micros, updated_at)
         VALUES ('2026-08-16', 180, 1000000, 40000, 300000, 1)`,
        [],
      );
    };

    const setting = (key: string): string | undefined =>
      database.client.getFirstSync<{ value: string }>(
        'SELECT value FROM app_settings WHERE key = ?',
        [key],
      )?.value;

    it('keeps the free trial’s lifetime counters', () => {
      spend();
      wipeAllTables(database.client);

      expect(setting('llmTrialRequestsUsed')).toBe('25');
      expect(setting('llmTrialTokensUsed')).toBe('600000');
    });

    it('keeps the spend meter', () => {
      spend();
      wipeAllTables(database.client);

      const row = database.client.getFirstSync<{ requests: number }>(
        'SELECT requests FROM llm_usage WHERE local_date = ?',
        ['2026-08-16'],
      );
      expect(row?.requests).toBe(180);
    });

    /* Everything the user actually wrote still goes, preferences included —
       the exemption is two integers about somebody else's invoice, not a
       licence to keep state the user asked to be rid of. */
    it('still erases every ordinary preference', () => {
      spend();
      wipeAllTables(database.client);

      expect(setting('ttsEnabled')).toBeUndefined();
    });

    /* The list is written out as literals so `wipe.ts` stays a leaf over the
       raw client. A typo there would silently preserve nothing. */
    it('names only keys the settings repository actually has', () => {
      for (const key of PRESERVED_SETTINGS) expect(isSettingKey(key)).toBe(true);
    });

    /**
     * And the line the exemption must never be extended across.
     *
     * `llm_usage` is preserved because five integers a day are a spend control
     * rather than anything the user wrote. `llm_interactions` is the opposite
     * of that: it is the user's own words, and it is the *only* copy of them,
     * because Ridik throws the audio away. The two tables sit next to each
     * other in the schema and are one careless line in `PRESERVED_TABLES`
     * apart from a phone that will not forget what was said to it.
     */
    it('erases every transcript, which is not a spend control', () => {
      database.client.runSync(
        `INSERT INTO llm_interactions (id, transcript, status, created_at) VALUES (?, ?, 'ok', 1)`,
        ['i1', 'the doctor said the results were'],
      );

      wipeAllTables(database.client);

      expect(database.client.getAllSync('SELECT id FROM llm_interactions', [])).toEqual([]);
    });
  });

  /* Migrations key on PRAGMA user_version; a wipe that reset it would re-run
     every migration over a live schema on the next launch. */
  it('keeps the schema version so migrations do not re-run', () => {
    const before = database.client.getFirstSync<{ user_version: number }>('PRAGMA user_version', []);
    wipeAllTables(database.client);
    const after = database.client.getFirstSync<{ user_version: number }>('PRAGMA user_version', []);
    expect(after?.user_version).toBe(before?.user_version);
    expect(after?.user_version).toBeGreaterThan(0);
  });
});
