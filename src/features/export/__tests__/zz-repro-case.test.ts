import { freezeClock } from '@/core/clock';
import { createTestDatabase, type TestDatabase } from '@/db/testing';

import { applyImport, BACKUP_FORMAT, BACKUP_VERSION, type Backup } from '../json';

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

function backupOf(tables: Backup['tables']): Backup {
  const version =
    database.client.getFirstSync<{ user_version: number }>('PRAGMA user_version', [])
      ?.user_version ?? 0;
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    schemaVersion: version,
    exportedAt: AT,
    tables,
  };
}

test('habit name case variant', () => {
  database.client.runSync(
    `INSERT INTO habits (id, name, current_streak, longest_streak, unit, is_archived, created_at)
     VALUES ('h-local', 'Running', 0, 0, 'session', 0, ?)`,
    [AT],
  );
  const result = applyImport(
    database.client,
    backupOf({
      habits: [
        {
          id: 'h-remote',
          name: 'running',
          current_streak: 41,
          longest_streak: 41,
          last_completed_date: '2026-08-10',
          unit: 'session',
          target_per_week: null,
          color: null,
          is_archived: 0,
          created_at: AT,
        },
      ],
    }),
  );
  console.log('habits import result', JSON.stringify(result));
  console.log(
    'rows now',
    JSON.stringify(database.client.getAllSync('SELECT id, name, current_streak FROM habits', [])),
  );
  console.log(
    'lookup NOCASE',
    JSON.stringify(
      database.client.getAllSync(
        `SELECT id, name FROM habits WHERE name = 'running' COLLATE NOCASE`,
        [],
      ),
    ),
  );
});

test('crm entity name case variant', () => {
  database.client.runSync(
    `INSERT INTO crm_entities (id, name, created_at, updated_at)
     VALUES ('c-local', 'Sarah', ?, ?)`,
    [AT, AT],
  );
  const result = applyImport(
    database.client,
    backupOf({
      crm_entities: [
        {
          id: 'c-remote',
          name: 'sarah',
          created_at: AT,
          updated_at: AT,
        },
      ],
    }),
  );
  console.log('crm import result', JSON.stringify(result));
  console.log(
    'crm rows now',
    JSON.stringify(database.client.getAllSync('SELECT id, name FROM crm_entities', [])),
  );
});

test('same-case control still conflicts', () => {
  database.client.runSync(
    `INSERT INTO habits (id, name, current_streak, longest_streak, unit, is_archived, created_at)
     VALUES ('h-local', 'Running', 0, 0, 'session', 0, ?)`,
    [AT],
  );
  const result = applyImport(
    database.client,
    backupOf({
      habits: [
        {
          id: 'h-remote',
          name: 'Running',
          current_streak: 41,
          longest_streak: 41,
          unit: 'session',
          is_archived: 0,
          created_at: AT,
        },
      ],
    }),
  );
  console.log('control result', JSON.stringify(result));
});
