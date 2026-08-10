import * as SQLite from 'expo-sqlite';
import { createDrizzle, runMigrations, type MigrationReport, type RidikDatabase } from './migrator';
import type { SqliteClient } from './sqlite-client';

export * from './schema';
export { newId, idTimestamp } from './ids';
export type { RidikDatabase, MigrationReport };

const DATABASE_NAME = 'ridik.db';

type Handle = {
  client: SqliteClient;
  db: RidikDatabase;
  report: MigrationReport;
};

let handle: Handle | null = null;

/**
 * Opens (once) and migrates the on-device database.
 *
 * Synchronous by design: expo-sqlite's sync API is what Drizzle's expo driver
 * uses, and every query in this app touches small local tables. Doing it once
 * at startup keeps every read afterwards a plain function call, which is what
 * makes the UI feel instant offline.
 */
export function openDatabase(): Handle {
  if (handle) return handle;
  const client = SQLite.openDatabaseSync(DATABASE_NAME, {
    enableChangeListener: true,
  }) as unknown as SqliteClient;
  const report = runMigrations(client);
  const db = createDrizzle(client);
  handle = { client, db, report };
  return handle;
}

export function getDb(): RidikDatabase {
  return openDatabase().db;
}

export function getClient(): SqliteClient {
  return openDatabase().client;
}

export function getMigrationReport(): MigrationReport {
  return openDatabase().report;
}

/** Test/maintenance hook — closes the handle so the next call reopens. */
export function closeDatabase(): void {
  handle?.client.closeSync();
  handle = null;
}
