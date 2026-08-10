/**
 * The read pass that fills the model's prompt.
 *
 * The prompt is the single most expensive thing in a voice turn, so this file
 * exists to keep it small and relevant rather than complete:
 *
 *  - **Capped at the source.** `buildSystemPrompt` truncates every section, so
 *    fetching more than it will render is pure latency. The caps here mirror
 *    its own; when they disagree the prompt still wins and only the extra work
 *    is wasted.
 *  - **Ordered by relevance.** Each list is sliced after the repository has put
 *    the useful end first — soonest for anything with a time, most recently
 *    touched for everything else — because the slice decides what the model is
 *    allowed to know.
 *  - **Never fatal.** A context is an optimisation: the model still works with
 *    an empty one. Any single read that fails is logged and dropped, so one
 *    unhappy table cannot cost the user the whole utterance.
 */
import { now as readClock } from '@/core/clock';
import type { Logger } from '@/core/logger';
import { currentZone, epochToLocal, localDateOf, type LocalDate } from '@/core/time';
import type {
  ContextClass,
  ContextEvent,
  ContextFocusSession,
  ContextNote,
  ContextProject,
  ContextTask,
  LlmContext,
} from '@/llm/prompt';
import type { Repositories } from '@/repositories';
import type { CalendarEvent } from '@/repositories/calendarEvents';
import { computeSessionState } from '@/repositories/focusSessions';

/**
 * Structural, not the whole bag: the context reads eleven of the fifteen
 * repositories, and saying so lets a test hand in just those eleven.
 */
export type LlmContextRepositories = Pick<
  Repositories,
  | 'calendar'
  | 'checklists'
  | 'crm'
  | 'curriculum'
  | 'focus'
  | 'habits'
  | 'ledger'
  | 'notes'
  | 'places'
  | 'projects'
  | 'tasks'
>;

/** Mirrors the caps in `@/llm/prompt`; anything past them is never rendered. */
export const CONTEXT_CAPS = {
  classes: 20,
  events: 12,
  tasks: 15,
  projects: 12,
  notes: 20,
  checklists: 15,
  crm: 25,
  places: 15,
  ledgerCategories: 20,
  habits: 15,
} as const;

/** Spec 2.1.2: homework is due before the next class, so a week of them is enough. */
export const CONTEXT_CLASS_DAYS = 7;

export type BuildLlmContextInput = {
  repos: LlmContextRepositories;
  /** UTC epoch ms the whole context is taken at. */
  now?: number;
  zone?: string;
  weekStart?: 'monday' | 'sunday';
  logger?: Logger;
};

export async function buildLlmContext(input: BuildLlmContextInput): Promise<LlmContext> {
  const { repos, logger } = input;
  const at = input.now ?? readClock();
  const zone = input.zone ?? currentZone();
  const today = localDateOf(at, zone);
  const tomorrow = dateAfter(at, 1, zone);

  const safely = <T>(what: string, fallback: T, run: () => Promise<T>): Promise<T> =>
    run().catch((error: unknown) => {
      logger?.warn(`context: could not read ${what}`, error);
      return fallback;
    });

  const [
    occurrences,
    todayRows,
    tomorrowRows,
    taskRows,
    projectRows,
    noteRows,
    lists,
    people,
    places,
    categories,
    habits,
    session,
  ] = await Promise.all([
    safely('classes', [], () =>
      repos.curriculum.upcomingOccurrences({ from: at, days: CONTEXT_CLASS_DAYS, zone }),
    ),
    safely('today', [] as CalendarEvent[], () => repos.calendar.listForLocalDate(today, zone)),
    safely('tomorrow', [] as CalendarEvent[], () => repos.calendar.listForLocalDate(tomorrow, zone)),
    // Already ordered by due date, then priority: the cap keeps the soonest.
    safely('tasks', [], () => repos.tasks.listActiveTasks({ limit: CONTEXT_CAPS.tasks })),
    safely('projects', [], () => repos.projects.listProjects({ status: 'active' })),
    safely('notes', [], () => repos.notes.listNotes({ limit: CONTEXT_CAPS.notes })),
    safely('checklists', [], () => repos.checklists.listNames()),
    safely('people', [], () => repos.crm.listEntities()),
    safely('places', [], () => repos.places.listPlaces()),
    safely('spending categories', [], () => repos.ledger.distinctCategories()),
    safely('habits', [], () => repos.habits.listHabits()),
    safely('the focus session', null, () => repos.focus.getActive()),
  ]);

  const projectNames = new Map(projectRows.map((row) => [row.id, row.name] as const));
  const unknownProjects = [
    ...new Set(
      taskRows
        .map((task) => task.projectId)
        .filter((id): id is string => id !== null && !projectNames.has(id)),
    ),
  ];
  if (unknownProjects.length > 0) {
    // A task can sit in a paused or archived project, which the PROJECTS
    // section deliberately leaves out — the task still has to say where it is.
    const extra = await safely('project names', [], () =>
      repos.projects.findProjectsByIds(unknownProjects),
    );
    for (const project of extra) projectNames.set(project.id, project.name);
  }

  const upcomingClasses: ContextClass[] = occurrences
    .slice(0, CONTEXT_CAPS.classes)
    .map((occurrence) => ({
      subject: occurrence.entry.subjectName,
      startsAt: occurrence.startsAt,
      endsAt: occurrence.endsAt,
      location: occurrence.entry.location,
    }));

  const openTasks: ContextTask[] = taskRows.slice(0, CONTEXT_CAPS.tasks).map((task) => ({
    title: task.title,
    dueAt: task.dueDate,
    project: task.projectId ? (projectNames.get(task.projectId) ?? null) : null,
  }));

  const projects: ContextProject[] = projectRows.slice(0, CONTEXT_CAPS.projects).map((project) => ({
    name: project.name,
    kind: project.kind,
  }));

  const notes: ContextNote[] = noteRows.slice(0, CONTEXT_CAPS.notes).map((note) => ({
    title: note.titleSummary,
    tag: note.categoryTag,
  }));

  return {
    now: at,
    zone,
    weekStart: input.weekStart ?? 'monday',
    upcomingClasses,
    todayEvents: toContextEvents(todayRows),
    tomorrowEvents: toContextEvents(tomorrowRows),
    openTasks,
    projects,
    notes,
    // Lists with something still open first: a list the user finished is the
    // one they are least likely to be talking about.
    checklistNames: [...lists]
      .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name))
      .slice(0, CONTEXT_CAPS.checklists)
      .map((list) => list.name),
    crmNames: people.slice(0, CONTEXT_CAPS.crm).map((row) => row.entity.name),
    placeLabels: places.slice(0, CONTEXT_CAPS.places).map((place) => place.label),
    ledgerCategories: categories.slice(0, CONTEXT_CAPS.ledgerCategories),
    habitNames: habits.slice(0, CONTEXT_CAPS.habits).map((habit) => habit.name),
    focusSession: describeSession(session, at, logger),
  };
}

function dateAfter(epoch: number, days: number, zone: string): LocalDate {
  return epochToLocal(epoch, zone).plus({ days }).toISODate()!;
}

/**
 * Buffers are travel and prep blocks the app wrote itself. The model must not
 * treat them as appointments — and at twelve events a day they would crowd out
 * the ones the user actually agreed to.
 */
function toContextEvents(rows: CalendarEvent[]): ContextEvent[] {
  return rows
    .filter((row) => row.kind !== 'buffer')
    .sort((a, b) => a.startsAt - b.startsAt)
    .slice(0, CONTEXT_CAPS.events)
    .map((row) => ({
      title: row.title,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      location: row.location,
      kind: row.kind,
    }));
}

/** A session row with an unreadable plan costs a prompt line, not the turn. */
function describeSession(
  session: Awaited<ReturnType<LlmContextRepositories['focus']['getActive']>>,
  at: number,
  logger?: Logger,
): ContextFocusSession | null {
  if (!session) return null;
  try {
    const state = computeSessionState(session, at);
    // A finished session the runtime has not retired yet is not something the
    // user can pause or skip, so telling the model about it invites a lie.
    if (state.isComplete) return null;
    return {
      label: session.label,
      subject: session.subject,
      status: state.status === 'paused' ? 'paused' : 'running',
      startedAt: session.startedAt,
    };
  } catch (error) {
    logger?.warn('context: could not read the running focus session', error);
    return null;
  }
}
