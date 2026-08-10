/**
 * One read pass that gathers everything a briefing is allowed to mention.
 *
 * Collection and wording are kept apart on purpose: nothing here formats a
 * string and nothing in `compose.ts` touches a repository. That split is what
 * lets the sentences be snapshot-tested against a hand-written `BriefingData`
 * with no database in sight, and it keeps the query cost of a briefing to a
 * single fan-out no matter how the wording later changes.
 */
import { now as readClock } from '@/core/clock';
import type { Logger } from '@/core/logger';
import {
  currentZone,
  dayRange,
  epochToLocal,
  localDateOf,
  type LocalDate,
} from '@/core/time';
import type { CalendarEvent } from '@/db/schema';
import type { Repositories } from '@/repositories';
import { computeSessionState } from '@/repositories/focusSessions';

/**
 * The app logger reads `__DEV__` at import time; this module has to load
 * outside React Native, so the real one is injected by the facade.
 */
const SILENT: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

export type BriefingScope = 'today' | 'tomorrow' | 'week';

/**
 * Structural, not the whole `Repositories` bag: a briefing reads seven of the
 * fifteen repositories, and saying so lets a test hand in just those seven.
 */
export type BriefingRepositories = Pick<
  Repositories,
  'calendar' | 'crm' | 'curriculum' | 'focus' | 'habits' | 'syncQueue' | 'tasks'
>;

export type BriefingEvent = {
  id: string;
  title: string;
  startsAt: number;
  endsAt: number;
  allDay: boolean;
  location: string | null;
  kind: CalendarEvent['kind'];
  /** Travel/prep blocks are spoken as "leave at …", never as appointments. */
  isBuffer: boolean;
  /** Title of the appointment this buffer precedes, when it is in the window. */
  bufferFor: string | null;
};

export type BriefingClass = {
  subject: string;
  startsAt: number;
  endsAt: number;
  location: string | null;
  teacher: string | null;
};

export type BriefingTask = {
  id: string;
  title: string;
  dueDate: number | null;
  priority: number;
  estimatedMinutes: number | null;
  projectId: string | null;
};

export type BriefingHabit = {
  id: string;
  name: string;
  streak: number;
  lastLoggedDate: LocalDate | null;
  /** Logged yesterday and not yet today — one quiet day ends the run. */
  atRisk: boolean;
};

export type BriefingCommitment = {
  id: string;
  text: string;
  personName: string;
  direction: 'i_owe' | 'they_owe';
  dueDate: number | null;
  isOverdue: boolean;
};

export type BriefingFocus = {
  id: string;
  label: string;
  subject: string | null;
  status: 'running' | 'paused';
  phase: 'focus' | 'break';
  remainingMs: number;
};

export type BriefingData = {
  scope: BriefingScope;
  /** UTC epoch ms the briefing was taken at; `compose` reads "now" from here. */
  now: number;
  zone: string;
  /** First local day of the window. */
  date: LocalDate;
  /** Half-open `[start, end)`, UTC epoch ms. */
  window: { start: number; end: number };
  events: BriefingEvent[];
  classes: BriefingClass[];
  overdueTasks: BriefingTask[];
  dueTasks: BriefingTask[];
  /** Due just past the window — what makes "due tomorrow" sayable today. */
  upcomingTasks: BriefingTask[];
  /** Freed by a finished prerequisite and still untouched. */
  unlockedTasks: BriefingTask[];
  streaks: BriefingHabit[];
  streaksAtRisk: BriefingHabit[];
  commitments: BriefingCommitment[];
  focus: BriefingFocus | null;
  unsyncedCount: number;
};

export type CollectBriefingInput = {
  repos: BriefingRepositories;
  scope?: BriefingScope;
  now?: number;
  zone?: string;
  logger?: Logger;
};

/**
 * How far past the window a due date still earns a mention. Without it a
 * morning briefing could not say "and your Physics homework is due tomorrow",
 * which is the single most useful thing it says.
 */
const LOOKAHEAD_DAYS = 3;

function localDateAfter(epoch: number, days: number, zone: string): LocalDate {
  return epochToLocal(epoch, zone).plus({ days }).toISODate()!;
}

/**
 * "This week" means the seven days ahead rather than the calendar week: a
 * Friday briefing that stopped at Sunday would hide almost everything coming.
 */
function windowFor(
  scope: BriefingScope,
  at: number,
  zone: string,
): { date: LocalDate; start: number; end: number } {
  const date = scope === 'tomorrow' ? localDateAfter(at, 1, zone) : localDateOf(at, zone);
  const first = dayRange(date, zone);
  if (scope !== 'week') return { date, start: first.start, end: first.end };
  const last = dayRange(localDateAfter(at, 6, zone), zone);
  return { date, start: first.start, end: last.end };
}

export async function collectBriefing(input: CollectBriefingInput): Promise<BriefingData> {
  const { repos } = input;
  const scope = input.scope ?? 'today';
  const at = input.now ?? readClock();
  const zone = input.zone ?? currentZone();
  const { date, start, end } = windowFor(scope, at, zone);
  const spanDays = scope === 'week' ? 7 : 1;
  const lookaheadEnd = epochToLocal(end, zone).plus({ days: LOOKAHEAD_DAYS }).toMillis();

  // One fan-out. The driver is a single synchronous connection, so these do not
  // truly overlap — but none of them writes, so the ordering cannot matter.
  const [rawEvents, occurrences, openTasks, habitRows, commitmentRows, session, syncCounts] =
    await Promise.all([
      repos.calendar.listBetween(start, end),
      repos.curriculum.upcomingOccurrences({ from: start, days: spanDays, zone }),
      repos.tasks.listTasks({ completed: false }),
      repos.habits.listHabits(),
      repos.crm.listOpenCommitments({ dueBefore: end }),
      repos.focus.getActive(),
      repos.syncQueue.counts(),
    ]);

  const titleById = new Map(rawEvents.map((row) => [row.id, row.title] as const));
  const events: BriefingEvent[] = rawEvents.map((row) => ({
    id: row.id,
    title: row.title,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    allDay: row.allDay,
    location: row.location,
    kind: row.kind,
    isBuffer: row.kind === 'buffer',
    bufferFor: row.bufferForId ? (titleById.get(row.bufferForId) ?? null) : null,
  }));

  const classes: BriefingClass[] = occurrences
    .filter((occurrence) => occurrence.startsAt >= start && occurrence.startsAt < end)
    .map((occurrence) => ({
      subject: occurrence.entry.subjectName,
      startsAt: occurrence.startsAt,
      endsAt: occurrence.endsAt,
      location: occurrence.entry.location,
      teacher: occurrence.entry.teacher,
    }));

  const overdueTasks: BriefingTask[] = [];
  const dueTasks: BriefingTask[] = [];
  const upcomingTasks: BriefingTask[] = [];
  const unlocked: { task: BriefingTask; at: number }[] = [];

  for (const row of openTasks) {
    // Blocked work is not actionable, and a briefing that reads it out is
    // telling the user about something they are not allowed to start.
    if (row.isLocked === true) continue;

    const task: BriefingTask = {
      id: row.id,
      title: row.title,
      dueDate: row.dueDate,
      priority: row.priority,
      estimatedMinutes: row.estimatedMinutes,
      projectId: row.projectId,
    };

    if (row.dueDate != null && row.dueDate < at) overdueTasks.push(task);
    else if (row.dueDate != null && row.dueDate < end) dueTasks.push(task);
    else if (row.dueDate != null && row.dueDate < lookaheadEnd) upcomingTasks.push(task);
    else if (row.unlockedAt != null) unlocked.push({ task, at: row.unlockedAt });
  }

  // Most recently freed first: the step a just-finished prerequisite opened up
  // is the one the user is most likely to be looking for.
  unlocked.sort((a, b) => b.at - a.at);

  const today = localDateOf(at, zone);
  const yesterday = localDateAfter(at, -1, zone);
  const streaks: BriefingHabit[] = habitRows
    .map((row) => ({
      id: row.id,
      name: row.name,
      streak: row.currentStreak ?? 0,
      lastLoggedDate: row.lastCompletedDate,
      // `last_completed_date` is the newest logged day, so "yesterday" is
      // exactly "logged yesterday and not today".
      atRisk: row.lastCompletedDate === yesterday && row.lastCompletedDate !== today,
    }))
    .filter((habit) => habit.streak > 0)
    .sort((a, b) => b.streak - a.streak || a.name.localeCompare(b.name));

  const commitments: BriefingCommitment[] = commitmentRows.map(({ commitment, entity }) => ({
    id: commitment.id,
    text: commitment.commitmentText,
    personName: entity.name,
    direction: commitment.direction,
    dueDate: commitment.dueDate,
    isOverdue: commitment.dueDate != null && commitment.dueDate < at,
  }));

  return {
    scope,
    now: at,
    zone,
    date,
    window: { start, end },
    events,
    classes,
    overdueTasks,
    dueTasks,
    upcomingTasks,
    unlockedTasks: unlocked.map((entry) => entry.task),
    streaks,
    streaksAtRisk: streaks.filter((habit) => habit.atRisk),
    commitments,
    focus: describeFocus(session, at, input.logger ?? SILENT),
    unsyncedCount: syncCounts.pending + syncCounts.inFlight + syncCounts.failed,
  };
}

/** A session row with an unreadable plan must cost the user a line, not the briefing. */
function describeFocus(
  session: Awaited<ReturnType<BriefingRepositories['focus']['getActive']>>,
  at: number,
  log: Logger,
): BriefingFocus | null {
  if (!session) return null;
  try {
    const state = computeSessionState(session, at);
    if (state.isComplete) return null;
    return {
      id: session.id,
      label: session.label,
      subject: session.subject,
      status: state.status === 'paused' ? 'paused' : 'running',
      phase: state.phase.kind,
      remainingMs: state.phaseRemainingMs,
    };
  } catch (error) {
    log.warn('could not read the running focus session', error);
    return null;
  }
}
