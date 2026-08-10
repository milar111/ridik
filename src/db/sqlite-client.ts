/**
 * The narrow slice of the expo-sqlite surface that Drizzle's expo driver and our
 * migrator actually touch.
 *
 * Declaring it structurally means the *same* Drizzle code path runs on device
 * (expo-sqlite) and in tests (a node:sqlite shim) — no mock database, no second
 * SQL dialect, no "works in tests, breaks on device" gap.
 */

export type SqlBindValue = string | number | boolean | null | Uint8Array;
export type SqlBindParams = SqlBindValue[] | Record<string, SqlBindValue>;

export interface SqliteRunResult {
  changes: number;
  lastInsertRowId: number;
}

export interface SqliteExecuteResult<T> extends SqliteRunResult {
  getAllSync(): T[];
  getFirstSync(): T | null;
}

export interface SqliteStatement {
  executeSync<T>(params: SqlBindParams): SqliteExecuteResult<T>;
  executeForRawResultSync<T extends object>(
    params: SqlBindParams,
  ): SqliteExecuteResult<unknown[]>;
  finalizeSync(): void;
}

export interface SqliteClient {
  execSync(source: string): void;
  prepareSync(source: string): SqliteStatement;
  runSync(source: string, params: SqlBindParams): SqliteRunResult;
  getAllSync<T>(source: string, params: SqlBindParams): T[];
  getFirstSync<T>(source: string, params: SqlBindParams): T | null;
  closeSync(): void;
}
