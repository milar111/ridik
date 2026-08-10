/**
 * Test-only database factory. Produces a fully migrated, in-memory SQLite
 * database behind the exact Drizzle handle the app uses.
 */
import { NodeSqliteClient } from './node-client';
import { createDrizzle, runMigrations, type MigrationReport, type RidikDatabase } from './migrator';
import type { SqliteClient } from './sqlite-client';

export type TestDatabase = {
  db: RidikDatabase;
  client: SqliteClient;
  report: MigrationReport;
  close(): void;
};

export function createTestDatabase(location = ':memory:'): TestDatabase {
  const client = new NodeSqliteClient(location);
  const report = runMigrations(client);
  const db = createDrizzle(client);
  return { db, client, report, close: () => client.closeSync() };
}
