/**
 * node:sqlite shim implementing expo-sqlite's synchronous surface.
 *
 * Test-only: it lets the logic test-suite drive the *same* Drizzle driver, the
 * same migrations and the same repository code that ship to the device, against
 * a real SQLite engine. Never imported from app code.
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  SqlBindParams,
  SqliteClient,
  SqliteExecuteResult,
  SqliteRunResult,
  SqliteStatement,
} from './sqlite-client';

type AnyRow = Record<string, unknown>;

function normaliseParams(params: SqlBindParams | undefined): unknown[] {
  if (!params) return [];
  if (Array.isArray(params)) return params.map(coerce);
  // Named parameters: node:sqlite takes a single object argument.
  const out: AnyRow = {};
  for (const [k, v] of Object.entries(params)) out[k] = coerce(v);
  return [out];
}

/** node:sqlite rejects booleans and undefined; SQLite stores them as 0/1/NULL. */
function coerce(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return null;
  return value;
}

/** node:sqlite returns null-prototype objects; Drizzle expects plain ones. */
function plain<T>(row: T): T {
  return row && typeof row === 'object' ? ({ ...(row as AnyRow) } as T) : row;
}

class NodeStatement implements SqliteStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
  ) {}

  private isReadQuery(): boolean {
    // `RETURNING` makes writes readable too, so probe the prepared statement.
    const stmt = this.db.prepare(this.sql);
    try {
      return stmt.columns().length > 0;
    } catch {
      return false;
    }
  }

  executeSync<T>(params: SqlBindParams): SqliteExecuteResult<T> {
    const stmt = this.db.prepare(this.sql);
    const args = normaliseParams(params);
    if (this.isReadQuery()) {
      const rows = stmt.all(...(args as never[])).map((r) => plain(r)) as T[];
      return makeResult(rows, 0, 0);
    }
    const result = stmt.run(...(args as never[]));
    return makeResult<T>([], Number(result.changes ?? 0), Number(result.lastInsertRowid ?? 0));
  }

  executeForRawResultSync(params: SqlBindParams): SqliteExecuteResult<unknown[]> {
    const stmt = this.db.prepare(this.sql);
    const args = normaliseParams(params);
    if (!this.isReadQuery()) {
      const result = stmt.run(...(args as never[]));
      return makeResult<unknown[]>(
        [],
        Number(result.changes ?? 0),
        Number(result.lastInsertRowid ?? 0),
      );
    }
    // Positional arrays preserve duplicate column names across joins, which is
    // exactly what Drizzle's field mapper relies on.
    stmt.setReturnArrays(true);
    const rows = stmt.all(...(args as never[])) as unknown as unknown[][];
    return makeResult<unknown[]>(rows, 0, 0);
  }

  finalizeSync(): void {
    /* node:sqlite finalises on GC */
  }
}

function makeResult<T>(rows: T[], changes: number, lastInsertRowId: number): SqliteExecuteResult<T> {
  return {
    changes,
    lastInsertRowId,
    getAllSync: () => rows,
    getFirstSync: () => rows[0] ?? null,
  };
}

export class NodeSqliteClient implements SqliteClient {
  readonly raw: DatabaseSync;

  constructor(location = ':memory:') {
    this.raw = new DatabaseSync(location, { allowExtension: false });
  }

  execSync(source: string): void {
    this.raw.exec(source);
  }

  prepareSync(source: string): SqliteStatement {
    return new NodeStatement(this.raw, source);
  }

  runSync(source: string, params: SqlBindParams): SqliteRunResult {
    const result = this.raw.prepare(source).run(...(normaliseParams(params) as never[]));
    return {
      changes: Number(result.changes ?? 0),
      lastInsertRowId: Number(result.lastInsertRowid ?? 0),
    };
  }

  getAllSync<T>(source: string, params: SqlBindParams): T[] {
    return this.raw
      .prepare(source)
      .all(...(normaliseParams(params) as never[]))
      .map((r) => plain(r)) as T[];
  }

  getFirstSync<T>(source: string, params: SqlBindParams): T | null {
    const row = this.raw.prepare(source).get(...(normaliseParams(params) as never[]));
    return row === undefined ? null : (plain(row) as T);
  }

  closeSync(): void {
    this.raw.close();
  }
}
