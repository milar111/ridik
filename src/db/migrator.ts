// Import the driver entrypoint directly: `drizzle-orm/expo-sqlite` also re-exports
// `useLiveQuery`, which pulls in the expo-sqlite native module and would make this
// file unloadable in the Node test environment.
import { drizzle } from 'drizzle-orm/expo-sqlite/driver';
import type { ExpoSQLiteDatabase } from 'drizzle-orm/expo-sqlite/driver';
import { FTS_MIGRATION_VERSIONS, LATEST_VERSION, MIGRATIONS } from './migrations';
import { schema, type Schema } from './schema';
import type { SqliteClient } from './sqlite-client';

export type RidikDatabase = ExpoSQLiteDatabase<Schema> & { $client: SqliteClient };

export type MigrationReport = {
  from: number;
  to: number;
  applied: number[];
  skipped: number[];
  ftsAvailable: boolean;
};

function currentVersion(client: SqliteClient): number {
  const row = client.getFirstSync<{ user_version: number }>('PRAGMA user_version', []);
  return row?.user_version ?? 0;
}

/** FTS5 is a compile-time SQLite option; probe rather than assume. */
export function detectFts5(client: SqliteClient): boolean {
  try {
    client.execSync(
      'CREATE VIRTUAL TABLE IF NOT EXISTS __fts_probe USING fts5(x); DROP TABLE __fts_probe;',
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Applies pending migrations. Each migration runs inside its own transaction so
 * a failure halfway through cannot leave a half-built schema behind.
 */
export function runMigrations(client: SqliteClient): MigrationReport {
  client.execSync('PRAGMA journal_mode = WAL;');
  client.execSync('PRAGMA foreign_keys = ON;');
  client.execSync('PRAGMA busy_timeout = 5000;');

  const ftsAvailable = detectFts5(client);
  const from = currentVersion(client);
  const applied: number[] = [];
  const skipped: number[] = [];

  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    if (!ftsAvailable && FTS_MIGRATION_VERSIONS.has(migration.version)) {
      skipped.push(migration.version);
      // Still advance the cursor: this migration is intentionally a no-op here
      // and must not be retried on every launch.
      client.execSync(`PRAGMA user_version = ${migration.version};`);
      continue;
    }

    client.execSync('BEGIN');
    try {
      client.execSync(migration.sql);
      // PRAGMA user_version does not accept bound parameters; the value is a
      // literal number from our own migration list, never user input.
      client.execSync(`PRAGMA user_version = ${migration.version};`);
      client.execSync('COMMIT');
      applied.push(migration.version);
    } catch (error) {
      client.execSync('ROLLBACK');
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return { from, to: currentVersion(client), applied, skipped, ftsAvailable };
}

/** Wraps a raw client in Drizzle. Used identically on device and in tests. */
export function createDrizzle(client: SqliteClient): RidikDatabase {
  // Drizzle's expo driver only needs the sync statement surface, which both the
  // real expo-sqlite database and the node:sqlite test shim implement.
  return drizzle(client as never, { schema, logger: false }) as unknown as RidikDatabase;
}

export { LATEST_VERSION };
