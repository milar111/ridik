/**
 * "Erase all data" — the one destructive action in the app.
 *
 * Kept out of the hook that calls it so it can be exercised against a real
 * SQLite database in the `logic` project: this is the code path that must never
 * half-run, and a React-only home would have left it untested.
 */
import type { SqliteClient } from './sqlite-client';

/**
 * FTS5 keeps its index in shadow tables beside the virtual table. They are
 * listed in `sqlite_master` like any other table, but SQLite refuses to let
 * anything but FTS itself write to them — `DELETE FROM notes_fts_data` raises
 * "table notes_fts_data may not be modified", which inside a transaction takes
 * the entire wipe down with it. Deleting from the virtual table clears the
 * shadows anyway, so they are skipped rather than emptied.
 */
const FTS_SHADOW = /_(data|idx|content|docsize|config)$/;

/**
 * The spend ledger, which is not the user's data and does not go.
 *
 * "Erase everything" is about what the user wrote — their notes, their tasks,
 * their calendar. `llm_usage` is none of that: it is the record of what has
 * been spent on somebody else's API key, and emptying it is how a day's cap, a
 * month's plan allowance and the free trial's backstop all reset at once. The
 * button was a full reset of every spend control in the app, reachable with no
 * developer mode and no reinstall, and its cost to somebody who only wanted
 * free model calls was a database they did not care about.
 *
 * Nothing in here identifies anything: five integers and a date per day.
 */
const PRESERVED_TABLES = new Set(['llm_usage']);

/**
 * Settings rows that survive a wipe, for the same reason.
 *
 * These two are the free trial's lifetime counters. Everything else in
 * `app_settings` is a preference and goes. Kept as literals rather than
 * imported from `@/repositories/settings` so this file stays a leaf over the
 * raw client; `__tests__/wipe.test.ts` asserts they are still real keys.
 */
export const PRESERVED_SETTINGS = ['llmTrialRequestsUsed', 'llmTrialTokensUsed'] as const;

/** Every table a user's data can live in, newest schema included. */
export function listUserTables(client: SqliteClient): string[] {
  return client
    .getAllSync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      [],
    )
    .map((row) => row.name)
    .filter((name) => !FTS_SHADOW.test(name));
}

/**
 * Empties every table and reclaims the space. Returns how many were cleared.
 *
 * Foreign keys are switched off around the wipe rather than the tables being
 * ordered by dependency: an order is a list that rots the next time a table is
 * added, and every row is going anyway. The pragma is a no-op inside a
 * transaction, hence the sequencing.
 *
 * Two exceptions, both spend controls rather than anything the user wrote —
 * see `PRESERVED_TABLES` and `PRESERVED_SETTINGS`.
 */
export function wipeAllTables(client: SqliteClient): number {
  const tables = listUserTables(client).filter((name) => !PRESERVED_TABLES.has(name));
  const keep = PRESERVED_SETTINGS.map((key) => `'${key}'`).join(', ');

  client.execSync('PRAGMA foreign_keys = OFF');
  client.execSync('BEGIN');
  try {
    for (const table of tables) {
      client.execSync(
        table === 'app_settings'
          ? `DELETE FROM "app_settings" WHERE key NOT IN (${keep})`
          : `DELETE FROM "${table}"`,
      );
    }
    client.execSync('COMMIT');
  } catch (error) {
    client.execSync('ROLLBACK');
    throw error;
  } finally {
    client.execSync('PRAGMA foreign_keys = ON');
  }
  // Outside the transaction: VACUUM cannot run inside one.
  client.execSync('VACUUM');

  return tables.length;
}
