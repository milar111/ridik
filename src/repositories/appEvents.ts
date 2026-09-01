/**
 * The local usage ledger — a ring buffer of counted events, and nothing else.
 *
 * Pure, like every repository here, so the `logic` project runs it under plain
 * Node against real SQLite. It stores whatever `services/analytics/events.ts`
 * validated and refuses to interpret it: this file knows about rows and
 * retention, the vocabulary file knows about privacy, and neither has to be
 * read to trust the other.
 *
 * **A ring, not an archive.** `record()` prunes on every write to the newer of
 * `RETAIN_DAYS` local days or `RETAIN_ROWS` rows. A ledger that grows for ever
 * is a liability on somebody's phone and, worse, a record of a year of their
 * behaviour sitting in a file that the app promised was theirs — bounded is the
 * honest shape. Pruning on write rather than on a timer is what makes it true
 * of an install that is opened twice and then abandoned.
 *
 * Nothing in here is preserved by `db/wipe.ts` and nothing travels in a backup;
 * see `features/export/json.ts`. Both are deliberate and both are asserted.
 */
import { and, asc, count, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';

import { now } from '@/core/clock';
import { currentZone, localDateOf, type LocalDate } from '@/core/time';
import { newId } from '@/db/ids';
import type { RidikDatabase } from '@/db/migrator';
import { appEvents } from '@/db/schema';

/** The older of the two bounds wins; see the file docblock. */
export const RETAIN_DAYS = 90;
export const RETAIN_ROWS = 5_000;

/** One recorded row, as the Usage screen reads it. */
export type AppEvent = {
  id: string;
  name: string;
  props: Record<string, unknown>;
  localDate: LocalDate;
  createdAt: number;
  uploadedAt: number | null;
};

/**
 * A row as it would be *uploaded*: no `id` and no `created_at`.
 *
 * The local date is the finest time that travels, and the id is a join key
 * nobody on the receiving end should be handed. What the Usage screen shows is
 * this, byte for byte, which is the property that makes that screen a
 * disclosure rather than a decoration.
 */
export type UploadableEvent = {
  name: string;
  props: Record<string, unknown>;
  local_date: LocalDate;
};

export type EventCount = { name: string; count: number };
export type DayCount = { localDate: LocalDate; count: number };

function decode(props: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(props);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    // A row we cannot decode is a row we cannot show or send. Counting it under
    // its name is still honest; inventing props for it would not be.
    return {};
  }
}

export function createAppEventsRepository(db: RidikDatabase) {
  /**
   * Append one event and hold the ring.
   *
   * The caller has already validated `name`/`props` against the union — this
   * takes them as given and is the only writer.
   */
  async function record(
    name: string,
    props: Record<string, unknown>,
    options: { at?: number; zone?: string } = {},
  ): Promise<void> {
    const at = options.at ?? now();
    const zone = options.zone ?? currentZone();

    await db.insert(appEvents).values({
      id: newId(),
      name,
      props: JSON.stringify(props),
      localDate: localDateOf(at, zone),
      createdAt: at,
      uploadedAt: null,
    });

    await prune(at, zone);
  }

  /**
   * Drop everything older than the window, then everything past the row cap.
   *
   * Two passes because the two bounds mean different things: the date bound is
   * the promise ("we keep three months"), the row bound is the backstop against
   * a pathological day. Deleting by `created_at` rather than by `local_date`
   * for the second one keeps it exactly insertion-ordered even if the device's
   * zone moved underneath the table.
   */
  async function prune(at: number, zone: string): Promise<void> {
    const cutoff = localDateOf(at - RETAIN_DAYS * 86_400_000, zone);
    await db.delete(appEvents).where(lt(appEvents.localDate, cutoff));

    const [row] = await db.select({ n: count() }).from(appEvents);
    const total = Number(row?.n ?? 0);
    if (total <= RETAIN_ROWS) return;

    // The oldest `total - RETAIN_ROWS` rows, by insertion order.
    const doomed = await db
      .select({ id: appEvents.id })
      .from(appEvents)
      .orderBy(asc(appEvents.createdAt), asc(appEvents.id))
      .limit(total - RETAIN_ROWS);

    if (doomed.length > 0) {
      await db.delete(appEvents).where(
        inArray(
          appEvents.id,
          doomed.map((d) => d.id),
        ),
      );
    }
  }

  /** Newest first — what the Usage screen lists. */
  async function recent(limit = 200): Promise<AppEvent[]> {
    const rows = await db
      .select()
      .from(appEvents)
      .orderBy(desc(appEvents.createdAt), desc(appEvents.id))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      props: decode(r.props),
      localDate: r.localDate as LocalDate,
      createdAt: r.createdAt,
      uploadedAt: r.uploadedAt ?? null,
    }));
  }

  /** How many of each event, most frequent first. */
  async function countsByName(): Promise<EventCount[]> {
    const rows = await db
      .select({ name: appEvents.name, n: count() })
      .from(appEvents)
      .groupBy(appEvents.name)
      .orderBy(desc(count()));
    return rows.map((r) => ({ name: r.name, count: Number(r.n) }));
  }

  /** How many events per local day, newest day first. */
  async function countsByDay(limit = 30): Promise<DayCount[]> {
    const rows = await db
      .select({ localDate: appEvents.localDate, n: count() })
      .from(appEvents)
      .groupBy(appEvents.localDate)
      .orderBy(desc(appEvents.localDate))
      .limit(limit);
    return rows.map((r) => ({ localDate: r.localDate as LocalDate, count: Number(r.n) }));
  }

  /**
   * A breakdown of one event's own property, for the funnel and the tool table.
   *
   * `json_extract` rather than decoding in JS: the Usage screen asks this five
   * or six times and the alternative is pulling every row into memory to count
   * them.
   */
  async function countsByProp(name: string, prop: string): Promise<EventCount[]> {
    const rows = await db
      .select({
        value: sql<string>`coalesce(json_extract(${appEvents.props}, ${'$.' + prop}), 'null')`,
        n: count(),
      })
      .from(appEvents)
      .where(eq(appEvents.name, name))
      .groupBy(sql`1`)
      .orderBy(desc(count()));
    return rows.map((r) => ({ name: String(r.value), count: Number(r.n) }));
  }

  /** Total rows, and how many have never been sent. */
  async function totals(): Promise<{ rows: number; unsent: number }> {
    const [all] = await db.select({ n: count() }).from(appEvents);
    const [pending] = await db
      .select({ n: count() })
      .from(appEvents)
      .where(isNull(appEvents.uploadedAt));
    return { rows: Number(all?.n ?? 0), unsent: Number(pending?.n ?? 0) };
  }

  /**
   * The next batch for layer 2, oldest first, in the exact shape that travels.
   *
   * Ids come back alongside so the caller can mark them; they are not part of
   * the payload.
   */
  async function unsent(limit = 200): Promise<{ ids: string[]; events: UploadableEvent[] }> {
    const rows = await db
      .select()
      .from(appEvents)
      .where(isNull(appEvents.uploadedAt))
      .orderBy(asc(appEvents.createdAt), asc(appEvents.id))
      .limit(limit);

    return {
      ids: rows.map((r) => r.id),
      events: rows.map((r) => ({
        name: r.name,
        props: decode(r.props),
        local_date: r.localDate as LocalDate,
      })),
    };
  }

  /** Only ever called after the server has acknowledged the batch. */
  async function markUploaded(ids: readonly string[], at = now()): Promise<void> {
    if (ids.length === 0) return;
    await db
      .update(appEvents)
      .set({ uploadedAt: at })
      .where(and(inArray(appEvents.id, [...ids]), isNull(appEvents.uploadedAt)));
  }

  /** The Clear button. Immediate, total, and the user's to press. */
  async function clear(): Promise<void> {
    await db.delete(appEvents);
  }

  return {
    record,
    recent,
    countsByName,
    countsByDay,
    countsByProp,
    totals,
    unsent,
    markUploaded,
    clear,
  };
}

export type AppEventsRepository = ReturnType<typeof createAppEventsRepository>;
