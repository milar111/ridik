/**
 * The recurring weekly programme.
 *
 * This is the only *recurring* truth the app owns, so every piece of schedule
 * inference resolves against it: "the day before your next Math class", the
 * Today screen, and the window of upcoming classes injected into the LLM
 * prompt. Rows store wall-clock times; instants are derived per query through
 * a named zone so a DST switch never shifts a lesson.
 */
import { and, asc, eq } from 'drizzle-orm';
import { now } from '@/core/clock';
import { normalise, resolveOne } from '@/core/match';
import { AppError, fail, ok, type Result } from '@/core/result';
import {
  TIME_OF_DAY_RE,
  addMinutes,
  currentZone,
  epochToLocal,
  nextWeeklyOccurrence,
} from '@/core/time';
import { newId } from '@/db/ids';
import type { RidikDatabase } from '@/db/migrator';
import { curriculumSchedule, type CurriculumEntry } from '@/db/schema';

export type WeekParity = 'every' | 'odd' | 'even';

/** One entry of the `curriculum_add` tool contract, verbatim. */
export type CurriculumEntryInput = {
  subject_name: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  location?: string;
  teacher?: string;
  week_parity?: WeekParity;
  color?: string;
  is_active?: boolean;
};

export type CurriculumEntryPatch = Partial<{
  subjectName: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  location: string | null;
  teacher: string | null;
  weekParity: WeekParity;
  color: string | null;
  isActive: boolean;
}>;

export type ClassOccurrence = {
  entry: CurriculumEntry;
  startsAt: number;
  endsAt: number;
};

export type NextClass = ClassOccurrence & { subject: string };

export type HomeworkDueDate = {
  subject: string;
  dueAt: number;
  classStartsAt: number;
};

export type OccurrenceOptions = { from?: number; zone?: string };

/** "Create the reminder one day before that class" — the spec's default rule. */
export const DEFAULT_HOMEWORK_LEAD_HOURS = 24;
/** Fallback notice when the class is already closer than the lead time. */
export const MINIMUM_HOMEWORK_LEAD_MINUTES = 60;

function assertTimeOfDay(value: string): void {
  if (!TIME_OF_DAY_RE.test(value)) {
    throw new AppError('invalid_input', `"${value}" is not a time of day.`, {
      details: { expected: 'HH:mm' },
    });
  }
}

function assertDayOfWeek(day: number): void {
  if (!Number.isInteger(day) || day < 0 || day > 6) {
    throw new AppError('invalid_input', `"${day}" is not a day of the week.`);
  }
}

function parseTimeOfDay(value: string): { hour: number; minute: number } {
  assertTimeOfDay(value);
  const [hour, minute] = value.split(':');
  return { hour: Number(hour), minute: Number(minute) };
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function toRow(input: CurriculumEntryInput, at: number) {
  const subjectName = input.subject_name.trim();
  if (!subjectName) throw new AppError('invalid_input', 'A class needs a subject name.');
  assertDayOfWeek(input.day_of_week);
  assertTimeOfDay(input.start_time);
  assertTimeOfDay(input.end_time);

  return {
    id: newId(),
    subjectName,
    dayOfWeek: input.day_of_week,
    startTime: input.start_time,
    endTime: input.end_time,
    location: trimToNull(input.location),
    weekParity: input.week_parity ?? ('every' as const),
    teacher: trimToNull(input.teacher),
    color: trimToNull(input.color),
    isActive: input.is_active ?? true,
    createdAt: at,
    updatedAt: at,
  };
}

/** Wall-clock end time on the same local day as `startsAt`. */
function endOfClass(startsAt: number, endTime: string, zone: string): number {
  const { hour, minute } = parseTimeOfDay(endTime);
  const end = epochToLocal(startsAt, zone).set({ hour, minute, second: 0, millisecond: 0 });
  // A slot written as 23:00–00:30 finishes on the next calendar day.
  return end.toMillis() <= startsAt ? end.plus({ days: 1 }).toMillis() : end.toMillis();
}

function occurrenceOf(entry: CurriculumEntry, from: number, zone: string): ClassOccurrence {
  const startsAt = nextWeeklyOccurrence(entry.dayOfWeek, entry.startTime, {
    from,
    zone,
    parity: entry.weekParity,
  });
  return { entry, startsAt, endsAt: endOfClass(startsAt, entry.endTime, zone) };
}

export function createCurriculumRepository(db: RidikDatabase) {
  async function listEntries(
    options: { activeOnly?: boolean } = {},
  ): Promise<CurriculumEntry[]> {
    // The timetable editor has to see rows it switched off, so the full listing
    // includes them; the schedule-facing queries below default the other way.
    const query = db.select().from(curriculumSchedule);
    const rows = options.activeOnly
      ? await query
          .where(eq(curriculumSchedule.isActive, true))
          .orderBy(asc(curriculumSchedule.dayOfWeek), asc(curriculumSchedule.startTime))
      : await query.orderBy(asc(curriculumSchedule.dayOfWeek), asc(curriculumSchedule.startTime));
    return rows;
  }

  async function entriesForDay(
    dayOfWeek: number,
    options: { activeOnly?: boolean } = {},
  ): Promise<CurriculumEntry[]> {
    assertDayOfWeek(dayOfWeek);
    const activeOnly = options.activeOnly ?? true;
    const where = activeOnly
      ? and(eq(curriculumSchedule.dayOfWeek, dayOfWeek), eq(curriculumSchedule.isActive, true))
      : eq(curriculumSchedule.dayOfWeek, dayOfWeek);
    return db
      .select()
      .from(curriculumSchedule)
      .where(where)
      .orderBy(asc(curriculumSchedule.startTime));
  }

  async function addEntries(entries: CurriculumEntryInput[]): Promise<CurriculumEntry[]> {
    if (entries.length === 0) return [];
    const at = now();
    const rows = entries.map((entry) => toRow(entry, at));
    return db.insert(curriculumSchedule).values(rows).returning();
  }

  /** Whole-timetable swap: the old programme must never survive a failure. */
  async function replaceAll(entries: CurriculumEntryInput[]): Promise<CurriculumEntry[]> {
    const at = now();
    const rows = entries.map((entry) => toRow(entry, at));

    db.$client.execSync('BEGIN');
    try {
      await db.delete(curriculumSchedule);
      const inserted = rows.length
        ? await db.insert(curriculumSchedule).values(rows).returning()
        : [];
      db.$client.execSync('COMMIT');
      return inserted;
    } catch (error) {
      db.$client.execSync('ROLLBACK');
      throw error;
    }
  }

  async function updateEntry(
    id: string,
    patch: CurriculumEntryPatch,
  ): Promise<Result<CurriculumEntry>> {
    if (patch.dayOfWeek !== undefined) assertDayOfWeek(patch.dayOfWeek);
    if (patch.startTime !== undefined) assertTimeOfDay(patch.startTime);
    if (patch.endTime !== undefined) assertTimeOfDay(patch.endTime);

    // The same normalisation `toRow` applies on create: a blank subject name
    // would leave the row impossible to say out loud, so it can never be one.
    const changes = { ...patch, updatedAt: now() };
    if (patch.subjectName !== undefined) {
      const subjectName = patch.subjectName.trim();
      if (!subjectName) throw new AppError('invalid_input', 'A class needs a subject name.');
      changes.subjectName = subjectName;
    }
    if (patch.location !== undefined) changes.location = trimToNull(patch.location);
    if (patch.teacher !== undefined) changes.teacher = trimToNull(patch.teacher);
    if (patch.color !== undefined) changes.color = trimToNull(patch.color);

    const rows = await db
      .update(curriculumSchedule)
      .set(changes)
      .where(eq(curriculumSchedule.id, id))
      .returning();
    const updated = rows[0];
    if (!updated) return fail('not_found', 'That class is not in the timetable.');
    return ok(updated);
  }

  async function deleteEntry(id: string): Promise<boolean> {
    const rows = await db
      .delete(curriculumSchedule)
      .where(eq(curriculumSchedule.id, id))
      .returning({ id: curriculumSchedule.id });
    return rows.length > 0;
  }

  /** Active subject names, de-duplicated case-insensitively, alphabetical. */
  async function distinctSubjects(): Promise<string[]> {
    const rows = await db
      .selectDistinct({ subjectName: curriculumSchedule.subjectName })
      .from(curriculumSchedule)
      .where(eq(curriculumSchedule.isActive, true))
      .orderBy(asc(curriculumSchedule.subjectName));

    const seen = new Set<string>();
    const subjects: string[] = [];
    for (const row of rows) {
      const key = normalise(row.subjectName);
      if (seen.has(key)) continue;
      seen.add(key);
      subjects.push(row.subjectName);
    }
    return subjects;
  }

  async function resolveSubject(query: string): Promise<Result<string>> {
    const subjects = await distinctSubjects();
    if (subjects.length === 0) return fail('not_found', 'There is no timetable saved yet.');

    const outcome = resolveOne(
      query,
      subjects.map((subject) => ({ item: subject, text: subject })),
    );
    if (outcome.kind === 'none') {
      return fail('not_found', `I could not find a subject called "${query}".`);
    }
    if (outcome.kind === 'ambiguous') {
      return fail('ambiguous', `Did you mean ${outcome.matches.map((m) => m.text).join(' or ')}?`, {
        details: outcome.matches.map((m) => m.item),
      });
    }
    return ok(outcome.match.item);
  }

  /** Soonest instance of a subject across every slot it occupies. */
  async function nextOccurrenceOf(
    subjectQuery: string,
    options: OccurrenceOptions = {},
  ): Promise<Result<NextClass>> {
    const zone = options.zone ?? currentZone();
    const from = options.from ?? now();

    const resolved = await resolveSubject(subjectQuery);
    if (!resolved.ok) return resolved;
    const subject = resolved.value;

    const key = normalise(subject);
    const entries = (await listEntries({ activeOnly: true })).filter(
      (entry) => normalise(entry.subjectName) === key,
    );
    if (entries.length === 0) return fail('not_found', `"${subject}" is not in the timetable.`);

    let best: ClassOccurrence | null = null;
    for (const entry of entries) {
      const occurrence = occurrenceOf(entry, from, zone);
      if (!best || occurrence.startsAt < best.startsAt) best = occurrence;
    }
    return ok({ subject, ...best! });
  }

  /**
   * Every class instance in a window, flattened and time-ordered. Feeds both
   * the Today screen and the schedule context handed to the model.
   */
  async function upcomingOccurrences(
    options: { from?: number; days?: number; zone?: string } = {},
  ): Promise<ClassOccurrence[]> {
    const zone = options.zone ?? currentZone();
    const from = options.from ?? now();
    const days = options.days ?? 7;
    if (days <= 0) return [];

    const until = epochToLocal(from, zone).plus({ days }).toMillis();
    const entries = await listEntries({ activeOnly: true });
    const occurrences: ClassOccurrence[] = [];

    for (const entry of entries) {
      let cursor = from;
      while (cursor < until) {
        const occurrence = occurrenceOf(entry, cursor, zone);
        if (occurrence.startsAt >= until) break;
        occurrences.push(occurrence);
        // A weekly slot cannot repeat inside the same day, so stepping one
        // minute past this instance always lands on the following week.
        cursor = addMinutes(occurrence.startsAt, 1);
      }
    }

    return occurrences.sort(
      (a, b) =>
        a.startsAt - b.startsAt || a.entry.subjectName.localeCompare(b.entry.subjectName),
    );
  }

  /**
   * When homework set for a subject is due: one day before the next class by
   * default, never in the past.
   */
  async function dueDateForHomework(
    subjectQuery: string,
    options: OccurrenceOptions & { hoursBefore?: number } = {},
  ): Promise<Result<HomeworkDueDate>> {
    const from = options.from ?? now();
    const next = await nextOccurrenceOf(subjectQuery, { from, zone: options.zone });
    if (!next.ok) return next;

    const hoursBefore = options.hoursBefore ?? DEFAULT_HOMEWORK_LEAD_HOURS;
    const classStartsAt = next.value.startsAt;
    const target = addMinutes(classStartsAt, -hoursBefore * 60);
    // A reminder in the past would never be seen; give an hour's notice instead
    // — but never past the class the work is due for, which would be useless.
    const dueAt =
      target > from
        ? target
        : Math.min(addMinutes(from, MINIMUM_HOMEWORK_LEAD_MINUTES), classStartsAt);

    return ok({ subject: next.value.subject, dueAt, classStartsAt });
  }

  return {
    listEntries,
    entriesForDay,
    addEntries,
    replaceAll,
    updateEntry,
    deleteEntry,
    distinctSubjects,
    resolveSubject,
    nextOccurrenceOf,
    upcomingOccurrences,
    dueDateForHomework,
  };
}

export type CurriculumRepository = ReturnType<typeof createCurriculumRepository>;
