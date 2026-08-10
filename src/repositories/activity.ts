/**
 * Activity feed — the raw material for "what did I actually get done".
 *
 * Every row carries both the instant (`logged_at`) and the local calendar day it
 * belongs to (`local_date`). Grouping happens on the latter: a 23-hour DST day
 * is still one day to the person who lived it, and an epoch-range bucket would
 * quietly move an evening entry into the wrong one.
 */
import { and, asc, desc, eq, gte, lt, lte } from 'drizzle-orm';
import { now } from '@/core/clock';
import { AppError } from '@/core/result';
import { LOCAL_DATE_RE, currentZone, localDateOf, type LocalDate } from '@/core/time';
import { newId } from '@/db/ids';
import type { RidikDatabase } from '@/db/migrator';
import { activityFeed, habits, projects, type ActivityEntry } from '@/db/schema';
import { createHabitsRepository } from '@/repositories/habits';

export type ActivityLogInput = {
  description: string;
  durationMinutes?: number;
  /** Links the entry to a habit, creating the habit if it is new. */
  habitName?: string;
  projectId?: string;
  /** UTC epoch ms; defaults to now. */
  at?: number;
};

export type ActivityDayBucket = {
  date: LocalDate;
  entries: ActivityEntry[];
  minutes: number;
};

export type ActivityGroupBucket = {
  id: string;
  name: string | null;
  count: number;
  minutes: number;
};

export type ActivitySummary = {
  entries: ActivityEntry[];
  totalMinutes: number;
  byDay: ActivityDayBucket[];
  byProject: ActivityGroupBucket[];
  byHabit: ActivityGroupBucket[];
};

/** Drizzle's sync-mode `transaction()` cannot wrap awaited builders. */
async function inTransaction<T>(db: RidikDatabase, fn: () => Promise<T>): Promise<T> {
  db.$client.execSync('BEGIN');
  try {
    const value = await fn();
    db.$client.execSync('COMMIT');
    return value;
  } catch (error) {
    db.$client.execSync('ROLLBACK');
    throw error;
  }
}

function bucketOf(
  buckets: Map<string, ActivityGroupBucket>,
  id: string,
  name: string | null,
): ActivityGroupBucket {
  const existing = buckets.get(id);
  if (existing) return existing;
  const created: ActivityGroupBucket = { id, name, count: 0, minutes: 0 };
  buckets.set(id, created);
  return created;
}

const byMinutesDesc = (a: ActivityGroupBucket, b: ActivityGroupBucket): number =>
  b.minutes - a.minutes || b.count - a.count;

export function createActivityRepository(db: RidikDatabase) {
  const habitsRepo = createHabitsRepository(db);

  async function log(input: ActivityLogInput): Promise<ActivityEntry> {
    const description = input.description.trim();
    if (!description) throw new AppError('invalid_input', 'An activity needs a description.');

    const at = input.at ?? now();
    const habitName = input.habitName?.trim();

    return inTransaction(db, async () => {
      // Inside the transaction: an entry that fails must not leave behind a
      // habit the user never actually started tracking.
      const habit = habitName ? await habitsRepo.getOrCreateHabit(habitName) : null;

      const [row] = await db
        .insert(activityFeed)
        .values({
          id: newId(),
          habitId: habit?.id ?? null,
          description,
          durationMinutes: input.durationMinutes ?? null,
          loggedAt: at,
          projectId: input.projectId ?? null,
          localDate: localDateOf(at, currentZone()),
          source: 'voice',
        })
        .returning();

      // A habit-linked entry becomes part of that habit's history, so the cached
      // streak has to move with it or the two views disagree.
      if (habit) await habitsRepo.recomputeStreak(habit.id);

      return row!;
    });
  }

  /** Half-open `[fromEpoch, toEpoch)`, matching `dayRange`/`weekRange`. */
  async function listBetween(fromEpoch: number, toEpoch: number): Promise<ActivityEntry[]> {
    return db
      .select()
      .from(activityFeed)
      .where(and(gte(activityFeed.loggedAt, fromEpoch), lt(activityFeed.loggedAt, toEpoch)))
      .orderBy(asc(activityFeed.loggedAt));
  }

  async function listForLocalDate(date: LocalDate): Promise<ActivityEntry[]> {
    if (!LOCAL_DATE_RE.test(date)) {
      throw new AppError('invalid_input', `"${date}" is not a YYYY-MM-DD date.`);
    }
    return db
      .select()
      .from(activityFeed)
      .where(eq(activityFeed.localDate, date))
      .orderBy(asc(activityFeed.loggedAt));
  }

  async function listRecent(limit = 20): Promise<ActivityEntry[]> {
    return db
      .select()
      .from(activityFeed)
      .orderBy(desc(activityFeed.loggedAt))
      .limit(Math.max(1, Math.trunc(limit)));
  }

  /** `from`/`to` are local dates and both ends are inclusive. */
  async function summarise(range: { from: LocalDate; to: LocalDate }): Promise<ActivitySummary> {
    if (!LOCAL_DATE_RE.test(range.from) || !LOCAL_DATE_RE.test(range.to)) {
      throw new AppError('invalid_input', 'A summary range needs two YYYY-MM-DD dates.');
    }
    if (range.from > range.to) {
      throw new AppError('invalid_input', 'The summary range starts after it ends.');
    }

    const rows = await db
      .select({ entry: activityFeed, projectName: projects.name, habitName: habits.name })
      .from(activityFeed)
      .leftJoin(projects, eq(activityFeed.projectId, projects.id))
      .leftJoin(habits, eq(activityFeed.habitId, habits.id))
      .where(and(gte(activityFeed.localDate, range.from), lte(activityFeed.localDate, range.to)))
      .orderBy(asc(activityFeed.localDate), asc(activityFeed.loggedAt));

    const entries: ActivityEntry[] = [];
    const byDay = new Map<LocalDate, ActivityDayBucket>();
    const byProject = new Map<string, ActivityGroupBucket>();
    const byHabit = new Map<string, ActivityGroupBucket>();
    let totalMinutes = 0;

    for (const { entry, projectName, habitName } of rows) {
      const minutes = entry.durationMinutes ?? 0;
      entries.push(entry);
      totalMinutes += minutes;

      let day = byDay.get(entry.localDate);
      if (!day) {
        day = { date: entry.localDate, entries: [], minutes: 0 };
        byDay.set(entry.localDate, day);
      }
      day.entries.push(entry);
      day.minutes += minutes;

      if (entry.projectId) {
        const bucket = bucketOf(byProject, entry.projectId, projectName);
        bucket.count++;
        bucket.minutes += minutes;
      }
      if (entry.habitId) {
        const bucket = bucketOf(byHabit, entry.habitId, habitName);
        bucket.count++;
        bucket.minutes += minutes;
      }
    }

    return {
      entries,
      totalMinutes,
      // Rows arrive ordered by local date, so insertion order is chronological.
      byDay: [...byDay.values()],
      byProject: [...byProject.values()].sort(byMinutesDesc),
      byHabit: [...byHabit.values()].sort(byMinutesDesc),
    };
  }

  async function removeEntry(id: string): Promise<boolean> {
    const rows = await db
      .delete(activityFeed)
      .where(eq(activityFeed.id, id))
      .returning({ id: activityFeed.id });
    return rows.length > 0;
  }

  return { log, listBetween, listForLocalDate, listRecent, summarise, removeEntry };
}

export type ActivityRepository = ReturnType<typeof createActivityRepository>;
