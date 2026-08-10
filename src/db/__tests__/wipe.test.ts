import { createTestDatabase, type TestDatabase } from '../testing';
import { listUserTables, wipeAllTables } from '../wipe';

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
