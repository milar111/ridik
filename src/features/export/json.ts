/**
 * The backup: every row this phone holds, in one file that can come back.
 *
 * The markdown export next door is for reading — you can paste it anywhere and
 * still have your life if this app disappears. It cannot be re-imported, which
 * means "your data is yours" has so far meant *readable*, not *portable*. With
 * no account, and a server that never receives any of this, an export is the
 * only backup that exists, and a backup you cannot restore is a printout.
 *
 * So this is the machine-readable half: table dumps rather than prose, keyed on
 * the schema version they were taken at, and an importer that can put them back
 * on a phone that already has data on it.
 *
 * ## Import MERGES. It never replaces.
 *
 * This is the decision, and it is the one that has to be stated before the
 * button is pressed rather than in a changelog afterwards. Restoring adds what
 * is missing and leaves everything else exactly as it is:
 *
 * - A row whose id is already here is **skipped**. The copy on the phone wins,
 *   always. Nothing in this file can overwrite a note you have edited since.
 * - A row that clashes with a *different* row — a habit with the same name, a
 *   place with the same label — is **skipped** too, and counted, so the summary
 *   can say so rather than the collision being silent.
 * - A row whose parent did not make it (a task in a project that clashed) has
 *   its link cleared if the column allows it, and is skipped if it does not. A
 *   restore may not leave a dangling reference behind.
 * - Nothing is ever deleted or updated. Not one `UPDATE`, not one `DELETE`.
 *
 * The alternative — replace — is a one-tap way to destroy a month of work with
 * a stale file, and there is no undo underneath it. Merge can be run twice by
 * mistake and cost nothing but a second of CPU.
 *
 * ## All of it, or none of it
 *
 * The whole restore is one transaction. A row that cannot go in is skipped and
 * counted; anything that is not a constraint — a corrupt value, a table that
 * vanished under us — rolls the entire thing back. A half-restored database is
 * worse than a failed restore, because the user cannot tell which half.
 *
 * Pure by construction: this file talks to `SqliteClient` and nothing else, so
 * every path in it runs under plain Node against real SQLite in the `logic`
 * project. The file writing, the share sheet and the picker are in the hook.
 *
 * One thing it deliberately does not do: rebuild the notes search index.
 * `notes_fts` is maintained by the notes repository rather than by triggers,
 * and this module is a leaf over the raw client that must not know that.
 * `useRestoreBackup` calls `rebuildSearchIndex()` after a successful restore.
 */
import { now } from '@/core/clock';
import { fail, ok, toAppError, type Result } from '@/core/result';
import type { SqlBindValue, SqliteClient } from '@/db/sqlite-client';

/** Stamped into every file, so a JSON file from something else is caught. */
export const BACKUP_FORMAT = 'ridik.backup';

/**
 * The shape of *this file's* envelope, not of the database.
 *
 * Bump it when the envelope changes — when `tables` stops meaning "rows exactly
 * as SQLite holds them", say. The database's own version travels separately in
 * `schemaVersion`, because the two move for completely different reasons.
 */
export const BACKUP_VERSION = 1;

/**
 * Tables that are not the user's data and do not travel.
 *
 * `llm_usage` is the spend ledger — five integers and a date per day, counting
 * what has been spent on somebody else's API key. `db/wipe.ts` preserves it for
 * the same reason: it is an operator's meter, not a possession, and a file that
 * could write it is a file that could be edited to unspend a trial.
 *
 * `sync_queue` is an outbox of half-finished calls to Google. Restoring one
 * onto another phone replays writes against a calendar that has moved on.
 *
 * `app_events` is the local usage ledger, and it does not travel for the
 * opposite reason to `llm_usage`: it *is* the user's, but it is a record of one
 * phone being used, and somebody else's counts restored onto yours are not a
 * possession, they are noise in your own Usage screen. A file that could write
 * this table could also be edited to fake a funnel, which matters the moment
 * layer 2 uploads it. `db/wipe.ts` does erase it — that distinction between
 * "yours to delete" and "yours to carry" is the whole point of having both
 * lists.
 */
const NOT_YOURS = new Set(['llm_usage', 'sync_queue', 'app_events']);

/** FTS5 keeps its index in shadow tables beside the virtual table. */
const FTS_SHADOW = /_(data|idx|content|docsize|config)$/;

export type JsonValue = string | number | boolean | null;
export type BackupRow = Record<string, JsonValue>;

export type Backup = {
  format: typeof BACKUP_FORMAT;
  /** See `BACKUP_VERSION`. */
  version: number;
  /** `PRAGMA user_version` when the file was written. */
  schemaVersion: number;
  /** Epoch ms, UTC, like every other timestamp in this app. */
  exportedAt: number;
  /** The app version that wrote it. Diagnostic only; never branched on. */
  app?: string;
  tables: Record<string, BackupRow[]>;
};

/* ------------------------------------------------------------------ schema -- */

type ColumnInfo = { name: string; notNull: boolean; hasDefault: boolean; pk: number };
type ForeignKeyInfo = { from: string; parent: string; to: string };

function userVersion(client: SqliteClient): number {
  return client.getFirstSync<{ user_version: number }>('PRAGMA user_version', [])?.user_version ?? 0;
}

/**
 * Every table worth backing up.
 *
 * Virtual tables are excluded by their DDL rather than by name: `notes_fts` is
 * a derived index that is rebuilt from `notes`, and writing rows into an FTS5
 * table by hand is both wrong and, for its shadow tables, refused outright by
 * SQLite — which inside a transaction takes the whole restore down with it.
 */
export function backupTables(client: SqliteClient): string[] {
  return client
    .getAllSync<{ name: string; sql: string | null }>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      [],
    )
    .filter((row) => !/^\s*CREATE\s+VIRTUAL/i.test(row.sql ?? ''))
    .map((row) => row.name)
    .filter((name) => !FTS_SHADOW.test(name) && !NOT_YOURS.has(name));
}

function columnsOf(client: SqliteClient, table: string): ColumnInfo[] {
  // The name comes from sqlite_master or from a table we have already matched
  // against it, never from the file being imported.
  return client
    .getAllSync<{ name: string; notnull: number; dflt_value: unknown; pk: number }>(
      `PRAGMA table_info("${table}")`,
      [],
    )
    .map((row) => ({
      name: row.name,
      notNull: row.notnull === 1,
      hasDefault: row.dflt_value !== null && row.dflt_value !== undefined,
      pk: row.pk,
    }));
}

function primaryKeyOf(client: SqliteClient, table: string): string[] {
  return columnsOf(client, table)
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);
}

/**
 * `PRAGMA foreign_key_list` leaves `to` null when the reference is to the
 * parent's primary key implicitly, so it is resolved here rather than by every
 * caller.
 */
function foreignKeysOf(client: SqliteClient, table: string): ForeignKeyInfo[] {
  const rows = client.getAllSync<{ from: string; table: string; to: string | null }>(
    `PRAGMA foreign_key_list("${table}")`,
    [],
  );
  return rows.flatMap((row) => {
    const to = row.to ?? primaryKeyOf(client, row.table)[0];
    return to ? [{ from: row.from, parent: row.table, to }] : [];
  });
}

/**
 * Parents before children, so a child never meets an absent parent.
 *
 * Foreign keys are enforced immediately (the app runs `PRAGMA foreign_keys =
 * ON`, and a pragma cannot be flipped inside a transaction), so the order is
 * not a nicety — inserting a task before its project is a hard failure. A cycle
 * would be unorderable; the remaining tables are appended in name order rather
 * than throwing, because refusing to restore anything at all over a schema
 * shape this app does not have is the worse answer.
 */
export function orderTables(client: SqliteClient, tables: string[]): string[] {
  const present = new Set(tables);
  const parentsOf = new Map<string, string[]>();
  for (const table of tables) {
    parentsOf.set(
      table,
      foreignKeysOf(client, table)
        .map((fk) => fk.parent)
        .filter((parent) => parent !== table && present.has(parent)),
    );
  }

  const ordered: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();

  const visit = (table: string): void => {
    if (done.has(table) || visiting.has(table)) return;
    visiting.add(table);
    for (const parent of parentsOf.get(table) ?? []) visit(parent);
    visiting.delete(table);
    done.add(table);
    ordered.push(table);
  };

  for (const table of [...tables].sort()) visit(table);
  return ordered;
}

/* ------------------------------------------------------------------ export -- */

/** SQLite gives back primitives; anything else is not something we can write. */
function toJson(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  // No column in this schema is a BLOB. A future one would arrive here, and
  // dropping it is the honest answer: a silently mangled binary restored as a
  // string is a corrupt row that looks fine.
  return null;
}

export function buildBackup(
  client: SqliteClient,
  options: { app?: string; at?: number } = {},
): Backup {
  const tables: Record<string, BackupRow[]> = {};
  for (const table of orderTables(client, backupTables(client))) {
    const rows = client.getAllSync<Record<string, unknown>>(`SELECT * FROM "${table}"`, []);
    tables[table] = rows.map((row) => {
      const out: BackupRow = {};
      for (const [key, value] of Object.entries(row)) out[key] = toJson(value);
      return out;
    });
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    schemaVersion: userVersion(client),
    exportedAt: options.at ?? now(),
    ...(options.app ? { app: options.app } : {}),
    tables,
  };
}

/** Indented on purpose: a backup somebody can open and read is a better one. */
export function serialiseBackup(backup: Backup): string {
  return `${JSON.stringify(backup, null, 2)}\n`;
}

export function countRows(backup: Backup): number {
  return Object.values(backup.tables).reduce((sum, rows) => sum + rows.length, 0);
}

/* ------------------------------------------------------------------ parsing -- */

function isBackupRow(value: unknown): value is BackupRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (v) =>
      v === null ||
      typeof v === 'string' ||
      typeof v === 'number' ||
      typeof v === 'boolean',
  );
}

/**
 * Text off the filesystem into a `Backup`, or a sentence saying why not.
 *
 * Hand-written rather than a zod schema so the refusals can be specific: "this
 * is a Ridik backup from a newer version" and "this is not a Ridik backup" send
 * the user to two completely different places, and a schema failure would say
 * neither.
 */
export function parseBackup(text: string): Result<Backup> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('invalid_input', 'That file is not a Ridik backup — it is not even JSON.');
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('invalid_input', 'That file is not a Ridik backup.');
  }
  const file = raw as Record<string, unknown>;
  if (file.format !== BACKUP_FORMAT) {
    return fail('invalid_input', 'That file is not a Ridik backup.');
  }

  const version = file.version;
  if (typeof version !== 'number' || !Number.isFinite(version)) {
    return fail('invalid_input', 'That backup has no version and cannot be trusted.');
  }
  if (version > BACKUP_VERSION) {
    return fail(
      'unsupported',
      'That backup was written by a newer version of Ridik. Update the app and try again.',
    );
  }

  const schemaVersion = file.schemaVersion;
  if (typeof schemaVersion !== 'number' || !Number.isFinite(schemaVersion)) {
    return fail('invalid_input', 'That backup does not say which database it came from.');
  }

  const tables = file.tables;
  if (typeof tables !== 'object' || tables === null || Array.isArray(tables)) {
    return fail('invalid_input', 'That backup has no tables in it.');
  }

  const clean: Record<string, BackupRow[]> = {};
  for (const [table, rows] of Object.entries(tables as Record<string, unknown>)) {
    if (!Array.isArray(rows) || !rows.every(isBackupRow)) {
      return fail('invalid_input', `The "${table}" rows in that backup are not readable.`);
    }
    clean[table] = rows as BackupRow[];
  }

  const exportedAt = typeof file.exportedAt === 'number' ? file.exportedAt : 0;
  return ok({
    format: BACKUP_FORMAT,
    version,
    schemaVersion,
    exportedAt,
    ...(typeof file.app === 'string' ? { app: file.app } : {}),
    tables: clean,
  });
}

/* ------------------------------------------------------------------- import -- */

export type ImportVerdict =
  /** Same schema. Everything in the file has somewhere to go. */
  | 'same'
  /** Older schema. Columns added since simply take their defaults. */
  | 'older'
  /** Newer schema. Refused — see `planImport`. */
  | 'newer';

export type TablePlan = { table: string; incoming: number; fresh: number; existing: number };

export type ImportPlan = {
  verdict: ImportVerdict;
  /** Present when the file cannot be restored at all. */
  refusal?: string;
  schemaVersion: number;
  currentSchemaVersion: number;
  exportedAt: number;
  tables: TablePlan[];
  incoming: number;
  /** Rows whose id is not on this phone. The most this restore can add. */
  fresh: number;
  /** Rows already here, which will be left exactly as they are. */
  existing: number;
  /** Tables in the file this build has never heard of. Ignored. */
  unknownTables: string[];
  /** `table.column` pairs that will be dropped. */
  unknownColumns: string[];
};

export type ImportSummary = {
  /** Rows actually written. */
  inserted: number;
  /** Rows whose id was already here. The copy on the phone was kept. */
  existing: number;
  /** Rows that clashed with a *different* row — same habit name, say. */
  conflicted: number;
  /** Rows whose parent did not survive and whose link could not be cleared. */
  orphaned: number;
  perTable: Record<string, number>;
};

function keyMatch(pk: string[], row: BackupRow): { sql: string; params: SqlBindValue[] } | null {
  const params: SqlBindValue[] = [];
  for (const column of pk) {
    const value = row[column];
    if (value === undefined || value === null) return null;
    params.push(value);
  }
  return { sql: pk.map((column) => `"${column}" = ?`).join(' AND '), params };
}

function rowExists(client: SqliteClient, table: string, pk: string[], row: BackupRow): boolean {
  const match = keyMatch(pk, row);
  if (!match) return false;
  return (
    client.getFirstSync<{ one: number }>(
      `SELECT 1 AS one FROM "${table}" WHERE ${match.sql} LIMIT 1`,
      match.params,
    ) !== null
  );
}

/**
 * What a restore would do, without doing any of it.
 *
 * Counts by primary key only. Unique-key clashes and missing parents are
 * resolved while the rows are actually going in — simulating those would mean
 * running the import, which is the thing this exists to avoid — so the numbers
 * here are a ceiling, and `ImportSummary` is what actually happened.
 */
export function planImport(client: SqliteClient, backup: Backup): ImportPlan {
  const current = userVersion(client);
  const known = new Set(backupTables(client));

  const tables: TablePlan[] = [];
  const unknownTables: string[] = [];
  const unknownColumns: string[] = [];
  let incoming = 0;
  let fresh = 0;
  let existing = 0;

  for (const [table, rows] of Object.entries(backup.tables)) {
    if (!known.has(table)) {
      // `llm_usage` and `sync_queue` are in neither list by design; a file that
      // carries them is not "unknown", it is out of scope.
      if (!NOT_YOURS.has(table)) unknownTables.push(table);
      continue;
    }
    const columns = columnsOf(client, table);
    const names = new Set(columns.map((column) => column.name));
    const pk = columns
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);

    const seen = new Set<string>();
    let tableFresh = 0;
    let tableExisting = 0;
    for (const row of rows) {
      for (const column of Object.keys(row)) {
        if (!names.has(column) && !seen.has(column)) {
          seen.add(column);
          unknownColumns.push(`${table}.${column}`);
        }
      }
      if (pk.length > 0 && rowExists(client, table, pk, row)) tableExisting += 1;
      else tableFresh += 1;
    }

    incoming += rows.length;
    fresh += tableFresh;
    existing += tableExisting;
    if (rows.length > 0) {
      tables.push({ table, incoming: rows.length, fresh: tableFresh, existing: tableExisting });
    }
  }

  const verdict: ImportVerdict =
    backup.schemaVersion > current ? 'newer' : backup.schemaVersion < current ? 'older' : 'same';

  return {
    verdict,
    ...(verdict === 'newer'
      ? {
          refusal:
            'That backup came from a newer version of Ridik than this one. Update the app, then restore it.',
        }
      : {}),
    schemaVersion: backup.schemaVersion,
    currentSchemaVersion: current,
    exportedAt: backup.exportedAt,
    tables: tables.sort((a, b) => b.fresh - a.fresh || a.table.localeCompare(b.table)),
    incoming,
    fresh,
    existing,
    unknownTables,
    unknownColumns,
  };
}

/**
 * The sentence the user reads before they agree to anything.
 *
 * It names the semantics — merge, nothing deleted — every single time, because
 * "restore" is a word that means *replace* in most software the user has met,
 * and being wrong about which one this is costs them a database.
 */
export function describeImport(plan: ImportPlan): string {
  if (plan.refusal) return plan.refusal;
  if (plan.incoming === 0) return 'There is nothing in that backup to restore.';

  const parts = [
    plan.fresh === 0
      ? 'Everything in that backup is already on this phone.'
      : `This adds ${plan.fresh} ${plan.fresh === 1 ? 'row' : 'rows'} that are not on this phone.`,
  ];
  if (plan.existing > 0) {
    parts.push(
      `${plan.existing} ${plan.existing === 1 ? 'row is' : 'rows are'} already here and will be left exactly as ${plan.existing === 1 ? 'it is' : 'they are'}.`,
    );
  }
  parts.push('Nothing is deleted and nothing already on this phone is changed.');
  return parts.join(' ');
}

/** SQLite says "constraint failed" for every clash; anything else is a fault. */
function isConstraintFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /constraint failed/i.test(message);
}

/**
 * Puts a backup back. Merge, one transaction, nothing deleted — see the file
 * header, which is the contract this implements.
 */
export function applyImport(client: SqliteClient, backup: Backup): Result<ImportSummary> {
  if (backup.version > BACKUP_VERSION) {
    return fail(
      'unsupported',
      'That backup was written by a newer version of Ridik. Update the app and try again.',
    );
  }
  const current = userVersion(client);
  if (backup.schemaVersion > current) {
    return fail(
      'unsupported',
      'That backup came from a newer version of Ridik than this one. Update the app, then restore it.',
    );
  }

  const known = new Set(backupTables(client));
  const order = orderTables(client, [...known]).filter((table) => backup.tables[table]?.length);

  const summary: ImportSummary = {
    inserted: 0,
    existing: 0,
    conflicted: 0,
    orphaned: 0,
    perTable: {},
  };

  client.execSync('BEGIN IMMEDIATE');
  try {
    for (const table of order) {
      const columns = columnsOf(client, table);
      const byName = new Map(columns.map((column) => [column.name, column]));
      const pk = columns
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name);
      const foreignKeys = foreignKeysOf(client, table);

      for (const row of backup.tables[table] ?? []) {
        if (pk.length > 0 && rowExists(client, table, pk, row)) {
          summary.existing += 1;
          continue;
        }

        // Only columns this build actually has. A backup from an older schema
        // is missing the ones added since; they take their declared defaults.
        const values = new Map<string, JsonValue>();
        for (const [name, value] of Object.entries(row)) {
          if (byName.has(name)) values.set(name, value);
        }

        // A reference whose parent did not survive. Cleared where the column
        // allows it, and the row dropped where it does not — a restore that
        // left a task pointing at a project that is not there would have
        // written a row nothing can open.
        let orphan = false;
        for (const fk of foreignKeys) {
          const value = values.get(fk.from);
          if (value === undefined || value === null) continue;
          const parent = client.getFirstSync<{ one: number }>(
            `SELECT 1 AS one FROM "${fk.parent}" WHERE "${fk.to}" = ? LIMIT 1`,
            [value],
          );
          if (parent !== null) continue;
          const column = byName.get(fk.from);
          if (column && !column.notNull) values.set(fk.from, null);
          else orphan = true;
        }
        if (orphan) {
          summary.orphaned += 1;
          continue;
        }

        const names = [...values.keys()];
        if (names.length === 0) {
          summary.conflicted += 1;
          continue;
        }

        try {
          client.runSync(
            `INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(', ')}) ` +
              `VALUES (${names.map(() => '?').join(', ')})`,
            names.map((name) => values.get(name) as SqlBindValue),
          );
          summary.inserted += 1;
          summary.perTable[table] = (summary.perTable[table] ?? 0) + 1;
        } catch (error) {
          // A unique index, a check, a not-null column this file has no value
          // for: all of them mean "this row cannot join the ones already here",
          // which is a skip. Anything else is a fault and takes the lot down.
          if (!isConstraintFailure(error)) throw error;
          summary.conflicted += 1;
        }
      }
    }
    client.execSync('COMMIT');
    return ok(summary);
  } catch (error) {
    try {
      client.execSync('ROLLBACK');
    } catch {
      // Already unwound by SQLite itself; the database is consistent either way.
    }
    return fail('unknown', 'The backup could not be restored, so nothing was changed.', {
      cause: toAppError(error),
    });
  }
}
