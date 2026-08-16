/**
 * The backup, against a real SQLite database — the only way this is worth
 * anything. Every interesting case here is a *collision*: the same id already
 * present, a different row wearing the same unique name, a parent that did not
 * make it. None of those can be exercised against a mock.
 */
import { freezeClock } from '@/core/clock';
import { createTestDatabase, type TestDatabase } from '@/db/testing';

import {
  applyImport,
  backupTables,
  buildBackup,
  countRows,
  describeImport,
  orderTables,
  parseBackup,
  planImport,
  serialiseBackup,
  BACKUP_FORMAT,
  BACKUP_VERSION,
  type Backup,
} from '../json';

const AT = Date.UTC(2026, 7, 11, 9, 0, 0);

let database: TestDatabase;
let restoreClock: () => void;

beforeEach(() => {
  database = createTestDatabase();
  restoreClock = freezeClock(AT);
});

afterEach(() => {
  restoreClock();
  database.close();
});

/* A little of everything that can collide: a natural unique key (the habit
   name, the project name), a foreign key (the task's project), and a row with
   no relationships at all. */
function seed(db: TestDatabase, suffix = ''): void {
  db.client.runSync(
    `INSERT INTO projects (id, name, kind, status, created_at, updated_at)
     VALUES (?, ?, 'project', 'active', ?, ?)`,
    [`p${suffix}`, `Thesis${suffix}`, AT, AT],
  );
  db.client.runSync(
    `INSERT INTO tasks (id, title, project_id, priority, is_completed, created_at, updated_at, source)
     VALUES (?, ?, ?, 2, 0, ?, ?, 'voice')`,
    [`t${suffix}`, `write chapter${suffix}`, `p${suffix}`, AT, AT],
  );
  db.client.runSync(
    `INSERT INTO habits (id, name, longest_streak, unit, is_archived, created_at)
     VALUES (?, ?, 3, 'session', 0, ?)`,
    [`h${suffix}`, `Gym${suffix}`, AT],
  );
  db.client.runSync(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)`, [
    `speakReplies${suffix}`,
    'true',
    AT,
  ]);
}

function fresh(): TestDatabase {
  return createTestDatabase();
}

describe('what travels', () => {
  it('carries the user’s tables and leaves the spend ledger and the outbox behind', () => {
    const tables = backupTables(database.client);

    expect(tables).toContain('tasks');
    expect(tables).toContain('notes');
    expect(tables).toContain('app_settings');
    expect(tables).toContain('llm_interactions');
    // Not the user's: an operator's meter, and a queue of half-finished calls
    // to somebody else's calendar.
    expect(tables).not.toContain('llm_usage');
    expect(tables).not.toContain('sync_queue');
  });

  /* Writing rows into an FTS5 table by hand is wrong, and writing into its
     shadow tables is refused outright by SQLite — which inside a transaction
     takes the whole restore down with it. The index is rebuilt from `notes`. */
  it('never carries the search index or its shadow tables', () => {
    const tables = backupTables(database.client);
    expect(tables).not.toContain('notes_fts');
    expect(tables.filter((name) => name.startsWith('notes_fts'))).toEqual([]);
  });

  it('orders parents before children, so a task never meets an absent project', () => {
    const order = orderTables(database.client, backupTables(database.client));
    expect(order.indexOf('projects')).toBeLessThan(order.indexOf('tasks'));
    expect(order.indexOf('projects')).toBeLessThan(order.indexOf('project_items'));
    expect(order.indexOf('crm_entities')).toBeLessThan(order.indexOf('crm_commitments'));
    expect(order.indexOf('tasks')).toBeLessThan(order.indexOf('task_dependencies'));
  });
});

describe('the file', () => {
  it('stamps the format, both versions and the moment it was taken', () => {
    seed(database);
    const backup = buildBackup(database.client, { app: '1.0.0' });

    expect(backup.format).toBe(BACKUP_FORMAT);
    expect(backup.version).toBe(BACKUP_VERSION);
    expect(backup.schemaVersion).toBe(database.report.to);
    expect(backup.exportedAt).toBe(AT);
    expect(backup.app).toBe('1.0.0');
    expect(countRows(backup)).toBe(4);
  });

  it('round-trips through text without losing a row', () => {
    seed(database);
    const parsed = parseBackup(serialiseBackup(buildBackup(database.client)));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.tables.tasks).toEqual([
      expect.objectContaining({ id: 't', title: 'write chapter', project_id: 'p' }),
    ]);
  });

  it('refuses a file that is not a backup, and says which kind of not', () => {
    expect(parseBackup('not json at all')).toMatchObject({
      ok: false,
      error: { userMessage: expect.stringContaining('not even JSON') },
    });
    expect(parseBackup(JSON.stringify({ hello: 'world' }))).toMatchObject({
      ok: false,
      error: { userMessage: 'That file is not a Ridik backup.' },
    });
  });

  /* The whole point of the version field: a file this build cannot read is
     named as such rather than half-decoded into the database. */
  it('refuses a file written by a newer Ridik', () => {
    const future = JSON.stringify({
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION + 1,
      schemaVersion: 5,
      exportedAt: AT,
      tables: {},
    });

    expect(parseBackup(future)).toMatchObject({
      ok: false,
      error: { userMessage: expect.stringContaining('newer version of Ridik') },
    });
  });

  it('refuses rows that are not rows', () => {
    const broken = JSON.stringify({
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      schemaVersion: 5,
      exportedAt: AT,
      tables: { tasks: [{ id: { nested: true } }] },
    });

    expect(parseBackup(broken)).toMatchObject({
      ok: false,
      error: { userMessage: expect.stringContaining('"tasks" rows') },
    });
  });
});

describe('restoring onto an empty phone', () => {
  it('puts everything back', () => {
    seed(database);
    const backup = buildBackup(database.client);

    const target = fresh();
    try {
      const result = applyImport(target.client, backup);

      expect(result).toMatchObject({ ok: true, value: { inserted: 4, existing: 0 } });
      expect(target.client.getAllSync('SELECT id, title, project_id FROM tasks', [])).toEqual([
        { id: 't', title: 'write chapter', project_id: 'p' },
      ]);
      expect(target.client.getAllSync('SELECT name FROM habits', [])).toEqual([{ name: 'Gym' }]);
    } finally {
      target.close();
    }
  });
});

describe('restoring onto a phone that already has data', () => {
  /* Merge, and the copy on the phone wins. The alternative — replace — is a
     one-tap way to lose a month of work to a stale file, with no undo under
     it. */
  it('leaves a row that is already here exactly as it is', () => {
    seed(database);
    const backup = buildBackup(database.client);

    const target = fresh();
    try {
      seed(target);
      target.client.runSync('UPDATE tasks SET title = ? WHERE id = ?', ['edited since', 't']);

      const result = applyImport(target.client, backup);

      expect(result).toMatchObject({ ok: true, value: { inserted: 0, existing: 4 } });
      expect(target.client.getFirstSync('SELECT title FROM tasks WHERE id = ?', ['t'])).toEqual({
        title: 'edited since',
      });
    } finally {
      target.close();
    }
  });

  it('adds only what is missing and counts the rest', () => {
    seed(database);
    seed(database, '2');
    const backup = buildBackup(database.client);

    const target = fresh();
    try {
      seed(target);
      const result = applyImport(target.client, backup);

      expect(result).toMatchObject({ ok: true, value: { inserted: 4, existing: 4 } });
      expect(target.client.getAllSync('SELECT id FROM tasks ORDER BY id', [])).toEqual([
        { id: 't' },
        { id: 't2' },
      ]);
    } finally {
      target.close();
    }
  });

  /* A different row wearing the same unique name. Nothing may overwrite the
     habit that is here, and the clash may not take the transaction with it. */
  it('skips a row that clashes with a different one and keeps going', () => {
    database.client.runSync(
      `INSERT INTO habits (id, name, longest_streak, unit, is_archived, created_at)
       VALUES ('h-from-old-phone', 'Gym', 9, 'session', 0, ?)`,
      [AT],
    );
    database.client.runSync(
      `INSERT INTO habits (id, name, longest_streak, unit, is_archived, created_at)
       VALUES ('h-unrelated', 'Reading', 1, 'session', 0, ?)`,
      [AT],
    );
    const backup = buildBackup(database.client);

    const target = fresh();
    try {
      target.client.runSync(
        `INSERT INTO habits (id, name, longest_streak, unit, is_archived, created_at)
         VALUES ('h-on-this-phone', 'Gym', 40, 'session', 0, ?)`,
        [AT],
      );

      const result = applyImport(target.client, backup);

      expect(result).toMatchObject({ ok: true, value: { inserted: 1, conflicted: 1 } });
      expect(
        target.client.getAllSync('SELECT id, longest_streak FROM habits ORDER BY id', []),
      ).toEqual([
        { id: 'h-on-this-phone', longest_streak: 40 },
        { id: 'h-unrelated', longest_streak: 1 },
      ]);
    } finally {
      target.close();
    }
  });

  /* The consequence of the rule above: the child of a row that was skipped has
     nothing to point at. A nullable link is cleared, and the row survives —
     losing the project is not worth losing the task. */
  it('clears a link whose parent did not survive rather than dropping the row', () => {
    seed(database);
    const backup = buildBackup(database.client);

    const target = fresh();
    try {
      // Same project name, different id: the incoming project cannot be
      // inserted, so the incoming task's `project_id` points at nothing.
      target.client.runSync(
        `INSERT INTO projects (id, name, kind, status, created_at, updated_at)
         VALUES ('p-here', 'Thesis', 'project', 'active', ?, ?)`,
        [AT, AT],
      );

      const result = applyImport(target.client, backup);

      expect(result).toMatchObject({ ok: true, value: { conflicted: 1 } });
      expect(target.client.getFirstSync('SELECT project_id FROM tasks WHERE id = ?', ['t'])).toEqual(
        { project_id: null },
      );
    } finally {
      target.close();
    }
  });

  /* And where the link cannot be cleared, the row goes rather than the
     database gaining a reference to something that is not there. */
  it('drops a row whose required parent did not survive', () => {
    database.client.runSync(
      `INSERT INTO crm_entities (id, name, created_at, updated_at) VALUES ('e1', 'Ana', ?, ?)`,
      [AT, AT],
    );
    database.client.runSync(
      `INSERT INTO crm_commitments (id, entity_id, commitment_text, direction, is_completed, created_at)
       VALUES ('c1', 'e1', 'send the notes', 'i_owe', 0, ?)`,
      [AT],
    );
    const backup = buildBackup(database.client);

    const target = fresh();
    try {
      target.client.runSync(
        `INSERT INTO crm_entities (id, name, created_at, updated_at) VALUES ('e-here', 'Ana', ?, ?)`,
        [AT, AT],
      );

      const result = applyImport(target.client, backup);

      expect(result).toMatchObject({ ok: true, value: { conflicted: 1, orphaned: 1 } });
      expect(target.client.getAllSync('SELECT id FROM crm_commitments', [])).toEqual([]);
    } finally {
      target.close();
    }
  });
});

describe('a restore that goes wrong', () => {
  /* All of it or none of it. A half-restored database is worse than a failed
     restore, because the user cannot tell which half they are looking at. */
  it('writes nothing at all when a table cannot be read', () => {
    seed(database);
    const backup = buildBackup(database.client);
    const target = fresh();

    try {
      // A fault rather than a clash: the value is not something SQLite can
      // bind, so the statement throws with a message that is not a constraint.
      const corrupt: Backup = {
        ...backup,
        tables: {
          ...backup.tables,
          habits: [{ ...backup.tables.habits![0]!, created_at: Number.NaN }],
        },
      };
      // NaN survives `JSON.stringify` as null, so the corruption is injected
      // after parsing — which is exactly where a driver-level fault appears.
      const result = applyImport(target.client, {
        ...corrupt,
        tables: {
          ...corrupt.tables,
          habits: [{ ...corrupt.tables.habits![0]!, created_at: Symbol.iterator as never }],
        },
      });

      expect(result.ok).toBe(false);
      // Not one row: the projects and tasks that went in before the bad habit
      // came out again with it.
      expect(target.client.getAllSync('SELECT id FROM projects', [])).toEqual([]);
      expect(target.client.getAllSync('SELECT id FROM tasks', [])).toEqual([]);
    } finally {
      target.close();
    }
  });

  it('refuses a backup from a newer schema rather than dropping half of it', () => {
    seed(database);
    const backup = { ...buildBackup(database.client), schemaVersion: 999 };

    const target = fresh();
    try {
      const result = applyImport(target.client, backup);

      expect(result).toMatchObject({
        ok: false,
        error: { userMessage: expect.stringContaining('newer version of Ridik') },
      });
      expect(target.client.getAllSync('SELECT id FROM projects', [])).toEqual([]);
    } finally {
      target.close();
    }
  });

  /* Migrations are append-only, so an older file is missing columns rather
     than carrying wrong ones: they take their declared defaults. */
  it('accepts a backup from an older schema and lets the new columns default', () => {
    seed(database);
    const backup = buildBackup(database.client);
    const older: Backup = {
      ...backup,
      schemaVersion: 1,
      tables: {
        ...backup.tables,
        tasks: backup.tables.tasks!.map(({ updated_at: _updated, ...rest }) => rest),
      },
    };

    const target = fresh();
    try {
      expect(applyImport(target.client, older)).toMatchObject({ ok: true });
      expect(target.client.getFirstSync('SELECT updated_at FROM tasks WHERE id = ?', ['t'])).toEqual(
        { updated_at: 0 },
      );
    } finally {
      target.close();
    }
  });

  it('ignores a table this build has never heard of', () => {
    seed(database);
    const backup = buildBackup(database.client);
    const withExtras: Backup = {
      ...backup,
      tables: { ...backup.tables, dreams: [{ id: 'd1', text: 'flying' }] },
    };

    const target = fresh();
    try {
      expect(applyImport(target.client, withExtras)).toMatchObject({ ok: true, value: { inserted: 4 } });
      expect(planImport(target.client, withExtras).unknownTables).toEqual(['dreams']);
    } finally {
      target.close();
    }
  });
});

describe('what the user is told before it runs', () => {
  it('counts what is new and what is already here', () => {
    seed(database);
    seed(database, '2');
    const backup = buildBackup(database.client);

    const target = fresh();
    try {
      seed(target);
      const plan = planImport(target.client, backup);

      expect(plan).toMatchObject({
        verdict: 'same',
        incoming: 8,
        fresh: 4,
        existing: 4,
        unknownTables: [],
      });
      expect(plan.tables.map((t) => t.table).sort()).toEqual([
        'app_settings',
        'habits',
        'projects',
        'tasks',
      ]);
    } finally {
      target.close();
    }
  });

  /* "Restore" means *replace* in most software anybody has ever used. Being
     wrong about which one this is costs a database, so the sentence says it
     every single time. */
  it('always says that nothing is deleted', () => {
    seed(database);
    const backup = buildBackup(database.client);

    const target = fresh();
    try {
      seed(target);
      const sentence = describeImport(planImport(target.client, backup));

      expect(sentence).toContain('already on this phone');
      expect(sentence).toContain('Nothing is deleted');
    } finally {
      target.close();
    }
  });

  it('names the refusal instead of counting rows when the file is too new', () => {
    seed(database);
    const plan = planImport(database.client, {
      ...buildBackup(database.client),
      schemaVersion: 999,
    });

    expect(plan.verdict).toBe('newer');
    expect(describeImport(plan)).toContain('Update the app');
  });

  it('says plainly when there is nothing to do', () => {
    const plan = planImport(database.client, buildBackup(database.client));
    expect(describeImport(plan)).toBe('There is nothing in that backup to restore.');
  });
});
