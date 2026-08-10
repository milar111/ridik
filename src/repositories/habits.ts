/**
 * Habits — zero-friction voice logging.
 *
 * The streak is a cache. `activity_feed` holds the truth: one row per log, each
 * stamped with the local date it happened on. Logging today advances the cache
 * incrementally; anything that touches the past recomputes it from the feed, so
 * a backfilled "I actually ran yesterday too" can never corrupt the count.
 */
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { now } from '@/core/clock';
import { resolveOne, type Candidate } from '@/core/match';
import { AppError, fail, ok, type Result } from '@/core/result';
import {
  LOCAL_DATE_RE,
  calendarDaysBetween,
  currentZone,
  localDateOf,
  localToEpoch,
  type LocalDate,
} from '@/core/time';
import { newId } from '@/db/ids';
import type { RidikDatabase } from '@/db/migrator';
import { activityFeed, habits, type ActivityEntry, type Habit } from '@/db/schema';

export type HabitUnit = Habit['unit'];

export type HabitOptions = { unit?: HabitUnit; targetPerWeek?: number };

export type HabitLogInput = {
  habitName: string;
  durationMinutes?: number;
  note?: string;
  /** Local `YYYY-MM-DD`; defaults to today. Anything else is a backfill. */
  onDate?: LocalDate;
};

export type HabitLogResult = {
  habit: Habit;
  entry: ActivityEntry;
  streakChanged: boolean;
  streak: number;
};

/** Noon, because some zones skip midnight itself on the DST switchover day. */
function epochForLocalDate(date: LocalDate, zone: string): number {
  return localToEpoch(`${date}T12:00`, zone);
}

function daysBetweenDates(a: LocalDate, b: LocalDate, zone: string): number {
  return calendarDaysBetween(epochForLocalDate(a, zone), epochForLocalDate(b, zone), zone);
}

/** `dates` must be distinct and ascending. `current` is the run ending at the last one. */
function streakRuns(dates: readonly LocalDate[], zone: string): { current: number; longest: number } {
  if (dates.length === 0) return { current: 0, longest: 0 };
  let run = 1;
  let longest = 1;
  for (let i = 1; i < dates.length; i++) {
    run = daysBetweenDates(dates[i - 1]!, dates[i]!, zone) === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  return { current: run, longest };
}

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

export function createHabitsRepository(db: RidikDatabase) {
  async function habitById(id: string): Promise<Habit | null> {
    const [row] = await db.select().from(habits).where(eq(habits.id, id));
    return row ?? null;
  }

  async function findHabitByName(name: string): Promise<Habit | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const [row] = await db
      .select()
      .from(habits)
      .where(sql`${habits.name} = ${trimmed} COLLATE NOCASE`);
    return row ?? null;
  }

  async function getOrCreateHabit(name: string, options: HabitOptions = {}): Promise<Habit> {
    const trimmed = name.trim();
    if (!trimmed) throw new AppError('invalid_input', 'A habit needs a name.');

    const existing = await findHabitByName(trimmed);
    if (existing) {
      // Archiving is how a habit leaves the list, so logging one again is the
      // only way back — and it is unambiguous about intent. Without this the
      // log lands on a row nothing renders and the streak grows unseen.
      if (!existing.isArchived) return existing;
      await db.update(habits).set({ isArchived: false }).where(eq(habits.id, existing.id));
      return { ...existing, isArchived: false };
    }

    const [created] = await db
      .insert(habits)
      .values({
        id: newId(),
        name: trimmed,
        unit: options.unit ?? 'session',
        targetPerWeek: options.targetPerWeek ?? null,
        currentStreak: 0,
        longestStreak: 0,
        isArchived: false,
        createdAt: now(),
      })
      .returning();
    return created!;
  }

  async function loggedDates(
    habitId: string,
    range: { from?: LocalDate; to?: LocalDate } = {},
  ): Promise<LocalDate[]> {
    const filters = [eq(activityFeed.habitId, habitId), sql`${activityFeed.localDate} <> ''`];
    if (range.from) filters.push(gte(activityFeed.localDate, range.from));
    if (range.to) filters.push(lte(activityFeed.localDate, range.to));

    const rows = await db
      .selectDistinct({ date: activityFeed.localDate })
      .from(activityFeed)
      .where(and(...filters))
      .orderBy(asc(activityFeed.localDate));
    return rows.map((row) => row.date);
  }

  async function recomputeStreak(habitId: string): Promise<Habit> {
    const habit = await habitById(habitId);
    if (!habit) throw new AppError('not_found', 'That habit no longer exists.');

    const zone = currentZone();
    const dates = await loggedDates(habitId);
    const { current, longest } = streakRuns(dates, zone);

    const [updated] = await db
      .update(habits)
      .set({
        currentStreak: current,
        // "Max ever": entries can be pruned, the record should survive it.
        longestStreak: Math.max(habit.longestStreak, longest),
        lastCompletedDate: dates.at(-1) ?? null,
      })
      .where(eq(habits.id, habitId))
      .returning();
    return updated!;
  }

  /** Incremental path, only valid when `date` is the latest day logged. */
  async function advanceStreak(habit: Habit, date: LocalDate, zone: string): Promise<Habit> {
    const last = habit.lastCompletedDate;
    const current = habit.currentStreak ?? 0;
    const gap = last ? daysBetweenDates(last, date, zone) : null;

    // A last_completed_date in the future can only come from an out-of-order
    // backfill, and the feed is the only thing that can untangle it.
    if (gap !== null && gap < 0) return recomputeStreak(habit.id);

    let streak: number;
    if (gap === 0) streak = Math.max(current, 1);
    else if (gap === 1) streak = current + 1;
    else streak = 1;

    const [updated] = await db
      .update(habits)
      .set({
        currentStreak: streak,
        longestStreak: Math.max(habit.longestStreak, streak),
        lastCompletedDate: date,
      })
      .where(eq(habits.id, habit.id))
      .returning();
    return updated!;
  }

  async function logHabit(input: HabitLogInput): Promise<HabitLogResult> {
    const zone = currentZone();
    const today = localDateOf(now(), zone);
    const date = input.onDate ?? today;
    if (!LOCAL_DATE_RE.test(date)) {
      throw new AppError('invalid_input', `"${date}" is not a YYYY-MM-DD date.`);
    }

    const loggedAt = date === today ? now() : epochForLocalDate(date, zone);

    return inTransaction(db, async () => {
      // Inside the transaction: a log that fails must not leave behind a habit
      // the user never actually started tracking.
      const habit = await getOrCreateHabit(input.habitName);
      const before = habit.currentStreak ?? 0;

      const [entry] = await db
        .insert(activityFeed)
        .values({
          id: newId(),
          habitId: habit.id,
          description: input.note?.trim() || habit.name,
          durationMinutes: input.durationMinutes ?? null,
          loggedAt,
          localDate: date,
          source: 'habit',
        })
        .returning();

      const updated =
        date === today ? await advanceStreak(habit, date, zone) : await recomputeStreak(habit.id);
      const streak = updated.currentStreak ?? 0;

      return { habit: updated, entry: entry!, streakChanged: streak !== before, streak };
    });
  }

  async function listHabits(options: { includeArchived?: boolean } = {}): Promise<Habit[]> {
    const order = sql`${habits.name} COLLATE NOCASE`;
    if (options.includeArchived) {
      return db.select().from(habits).orderBy(order);
    }
    return db.select().from(habits).where(eq(habits.isArchived, false)).orderBy(order);
  }

  async function archiveHabit(habitId: string, archived = true): Promise<Habit | null> {
    const [row] = await db
      .update(habits)
      .set({ isArchived: archived })
      .where(eq(habits.id, habitId))
      .returning();
    return row ?? null;
  }

  async function deleteHabit(habitId: string): Promise<boolean> {
    // activity_feed.habit_id is ON DELETE SET NULL: the log of what was actually
    // done survives, it just stops belonging to a habit.
    const rows = await db
      .delete(habits)
      .where(eq(habits.id, habitId))
      .returning({ id: habits.id });
    return rows.length > 0;
  }

  async function habitHistory(
    habitId: string,
    range: { from?: LocalDate; to?: LocalDate } = {},
  ): Promise<LocalDate[]> {
    return loggedDates(habitId, range);
  }

  async function resolveHabit(query: string): Promise<Result<Habit>> {
    const trimmed = query.trim();
    if (!trimmed) throw new AppError('invalid_input', 'No habit was named.');

    const rows = await db.select().from(habits);
    if (rows.length === 0) return fail('not_found', 'You are not tracking any habits yet.');

    const candidates: Candidate<Habit>[] = rows.map((row) => ({
      item: row,
      text: row.name,
      boost: row.isArchived ? 0 : 1,
    }));

    const outcome = resolveOne(trimmed, candidates);
    if (outcome.kind === 'none') return fail('not_found', `You have no habit called "${trimmed}".`);
    if (outcome.kind === 'ambiguous') {
      return fail('ambiguous', `"${trimmed}" could mean more than one habit.`, {
        details: {
          matches: outcome.matches.map((m) => ({ id: m.item.id, name: m.item.name, score: m.score })),
        },
      });
    }
    return ok(outcome.match.item);
  }

  return {
    getOrCreateHabit,
    findHabitByName,
    habitById,
    logHabit,
    recomputeStreak,
    listHabits,
    archiveHabit,
    deleteHabit,
    habitHistory,
    resolveHabit,
  };
}

export type HabitsRepository = ReturnType<typeof createHabitsRepository>;
