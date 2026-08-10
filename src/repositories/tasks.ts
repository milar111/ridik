/**
 * Dependency-chain tasks.
 *
 * The graph is a DAG of prerequisites: an edge `parent -> child` means "child is
 * blocked until parent is done". Two invariants hold at all times and every
 * mutation below is written to preserve them:
 *
 *   1. No cycles. A cycle would deadlock the chain — nothing in it could ever
 *      unlock — so an edge that closes a loop is refused before it is written.
 *   2. `is_locked` is derived, never asserted by a caller: a task is locked iff
 *      at least one of its parents is incomplete. Anything that can change a
 *      parent's completion (complete, uncomplete, delete) or a task's parent set
 *      (add/remove dependency) recomputes the affected rows in the same
 *      transaction, so a reader can never observe a half-updated chain.
 */
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { now } from '@/core/clock';
import { normalise, resolveOne, type Candidate } from '@/core/match';
import { AppError, err, fail, ok, type Result } from '@/core/result';
import { calendarDaysBetween } from '@/core/time';
import { newId } from '@/db/ids';
import type { RidikDatabase } from '@/db/migrator';
import { projects, taskDependencies, tasks, type NewTask, type Task } from '@/db/schema';

import { serialised, transactional as withTransaction } from './transaction';

export type DependencyEdge = { parentTaskId: string; childTaskId: string };

export type CreateTaskInput = {
  title: string;
  dueDate?: number | null;
  notes?: string | null;
  projectId?: string | null;
  /** 1 = high .. 3 = low. */
  priority?: number;
  estimatedMinutes?: number | null;
  source?: string;
};

/** Descriptive fields only — completion and lock state are derived elsewhere. */
export type UpdateTaskPatch = {
  title?: string;
  dueDate?: number | null;
  notes?: string | null;
  projectId?: string | null;
  priority?: number;
  estimatedMinutes?: number | null;
  calendarEventId?: string | null;
};

export type AddDependenciesInput = { childId: string; parentIds: string[] };
export type AddDependenciesResult = { child: Task; parents: Task[] };

export type AddDependencyByTitlesInput = {
  childTitle: string;
  parentTitles: string[];
  childDue?: number | null;
  projectId?: string | null;
};
export type AddDependencyByTitlesResult = AddDependenciesResult & { created: Task[] };

export type CompleteTaskResult = { task: Task; unlocked: Task[] };
export type UncompleteTaskResult = { task: Task; relocked: Task[] };
export type DeleteTaskResult = { task: Task; unlocked: Task[] };
export type RemoveDependencyResult = { child: Task; removed: boolean };

export type TaskGraph = { nodes: Task[]; edges: DependencyEdge[] };

export type ListTasksFilter = {
  projectId?: string;
  completed?: boolean;
  dueBefore?: number;
  limit?: number;
};

export type ListActiveOptions = {
  /** The daily list hides blocked work; the graph view asks for it explicitly. */
  includeLocked?: boolean;
  projectId?: string;
  dueBefore?: number;
  limit?: number;
};

export type ResolveTaskOptions = { includeCompleted?: boolean; projectId?: string };

/**
 * Resolution threshold for the create-on-demand path, well above the app-wide
 * default. When the model dictates a prerequisite title, a duplicate task is a
 * shrug and a wrong link is a corrupted plan, so a weak match creates instead.
 */
const REUSE_THRESHOLD = 0.62;

/**
 * Would adding `parent -> child` close a loop over `edges`?
 *
 * Pure and exported so the guard can be tested without a database. Walks
 * forward from the child: the new edge is safe exactly when the child cannot
 * already reach the parent. `seen` also makes it terminate on data that is
 * already cyclic, which matters because we call it on rows from disk.
 */
export function wouldCreateCycle(
  edges: readonly DependencyEdge[],
  parentId: string,
  childId: string,
): boolean {
  if (parentId === childId) return true;

  const successors = new Map<string, string[]>();
  for (const edge of edges) {
    const existing = successors.get(edge.parentTaskId);
    if (existing) existing.push(edge.childTaskId);
    else successors.set(edge.parentTaskId, [edge.childTaskId]);
  }

  const seen = new Set<string>([childId]);
  const stack = [childId];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const next of successors.get(node) ?? []) {
      if (next === parentId) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return false;
}

/** `is_completed` / `is_locked` are nullable in the DDL; treat NULL as false. */
const NOT_COMPLETED = sql`coalesce(${tasks.isCompleted}, 0) = 0`;
const NOT_LOCKED = sql`coalesce(${tasks.isLocked}, 0) = 0`;

/** Soonest first, undated last, then priority, then creation order. */
const TASK_ORDER = [
  sql`${tasks.dueDate} is null`,
  asc(tasks.dueDate),
  asc(tasks.priority),
  asc(tasks.createdAt),
];

export function createTasksRepository(db: RidikDatabase) {
  /**
   * Every write goes through the shared per-connection queue.
   *
   * These bodies await between statements, so two overlapping calls — two taps
   * on the list, a batch of voice actions — used to interleave: the second
   * `BEGIN` threw and its `ROLLBACK` discarded the first call's writes, and a
   * bare insert issued mid-transaction was swallowed by someone else's rollback
   * while the caller was handed a task id that no longer existed.
   *
   * AppError stays the in-band failure channel: it rolls back and becomes an
   * `Err`; anything else is a bug and keeps throwing.
   */
  async function transactional<T>(run: () => Promise<T>): Promise<Result<T>> {
    try {
      return ok(await withTransaction(db, run));
    } catch (error) {
      if (error instanceof AppError) return err(error);
      throw error;
    }
  }

  async function getTask(id: string): Promise<Task | null> {
    const rows = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async function requireTask(id: string): Promise<Task> {
    const task = await getTask(id);
    if (!task) throw new AppError('not_found', 'That task no longer exists.', { details: { id } });
    return task;
  }

  async function allEdges(): Promise<DependencyEdge[]> {
    return db.select().from(taskDependencies);
  }

  async function childIdsOf(parentId: string): Promise<string[]> {
    const rows = await db
      .select({ id: taskDependencies.childTaskId })
      .from(taskDependencies)
      .where(eq(taskDependencies.parentTaskId, parentId));
    return rows.map((r) => r.id);
  }

  async function incompleteParentCount(childId: string): Promise<number> {
    const rows = await db
      .select({ n: sql<number>`count(*)` })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.parentTaskId))
      .where(and(eq(taskDependencies.childTaskId, childId), NOT_COMPLETED));
    return Number(rows[0]?.n ?? 0);
  }

  async function insertTask(input: CreateTaskInput): Promise<Task> {
    const title = input.title.trim();
    if (title.length === 0) throw new AppError('invalid_input', 'A task needs a title.');

    const priority = input.priority ?? 2;
    if (!Number.isInteger(priority) || priority < 1 || priority > 3) {
      throw new AppError('invalid_input', 'Priority must be 1 (high), 2 or 3 (low).');
    }

    const at = now();
    const row: NewTask = {
      id: newId(),
      title,
      dueDate: input.dueDate ?? null,
      notes: input.notes ?? null,
      projectId: input.projectId ?? null,
      priority,
      estimatedMinutes: input.estimatedMinutes ?? null,
      source: input.source ?? 'voice',
      isCompleted: false,
      isLocked: false,
      createdAt: at,
      updatedAt: at,
    };
    await db.insert(tasks).values(row);
    return requireTask(row.id);
  }

  /** Rewrites `is_locked` from the parent set. Returns whether it moved. */
  async function recompute(taskId: string): Promise<{ task: Task; changed: boolean }> {
    const before = await requireTask(taskId);
    const blocked = (await incompleteParentCount(taskId)) > 0;
    if (blocked === (before.isLocked === true)) return { task: before, changed: false };

    const at = now();
    await db
      .update(tasks)
      .set(
        blocked
          ? // Clearing unlocked_at keeps it meaning "available since", not
            // "was available once".
            { isLocked: true, unlockedAt: null, updatedAt: at }
          : { isLocked: false, unlockedAt: at, updatedAt: at },
      )
      .where(eq(tasks.id, taskId));
    return { task: await requireTask(taskId), changed: true };
  }

  /**
   * Recomputes every child of `parentId` after its completion flipped.
   * Only incomplete children are reported: the caller announces them ("Unlocked
   * next step: X") and a finished task is not a next step.
   */
  async function recomputeChildren(
    parentId: string,
    children?: string[],
  ): Promise<{ unlocked: Task[]; relocked: Task[] }> {
    const ids = children ?? (await childIdsOf(parentId));
    const unlocked: Task[] = [];
    const relocked: Task[] = [];
    for (const id of ids) {
      const { task, changed } = await recompute(id);
      if (!changed || task.isCompleted === true) continue;
      if (task.isLocked === true) relocked.push(task);
      else unlocked.push(task);
    }
    return { unlocked, relocked };
  }

  /** Validates the whole batch against the graph, then writes it. */
  async function linkParents(child: Task, parents: Task[]): Promise<void> {
    const existing = await allEdges();
    const pending: DependencyEdge[] = [];

    for (const parent of parents) {
      if (parent.id === child.id) {
        throw new AppError('cycle', `"${child.title}" cannot depend on itself.`, {
          details: { taskId: child.id },
        });
      }
      // Edges accepted earlier in this batch count as present, so a batch can
      // never smuggle in a loop that no single edge would have created.
      if (wouldCreateCycle([...existing, ...pending], parent.id, child.id)) {
        throw new AppError(
          'cycle',
          `"${child.title}" cannot wait on "${parent.title}" — that loops back on itself.`,
          { details: { parentId: parent.id, childId: child.id } },
        );
      }
      pending.push({ parentTaskId: parent.id, childTaskId: child.id });
    }

    await db.insert(taskDependencies).values(pending).onConflictDoNothing();
    await recompute(child.id);
  }

  function toCandidate(task: Task, projectName?: string | null): Candidate<Task> {
    const aux = [task.notes, projectName].filter((v): v is string => Boolean(v));
    return { item: task, text: task.title, aux, boost: urgencyBoost(task, now()) };
  }

  async function resolveOrCreate(
    title: string,
    pool: Task[],
    created: Task[],
    defaults: { dueDate?: number | null; projectId?: string | null },
  ): Promise<Task> {
    const outcome = resolveOne(title, pool.map((t) => toCandidate(t)), {
      threshold: REUSE_THRESHOLD,
    });
    if (outcome.kind === 'unique') return outcome.match.item;
    if (outcome.kind === 'ambiguous') {
      throw new AppError('ambiguous', `Which "${title}" do you mean?`, {
        details: { titles: outcome.matches.map((m) => m.text) },
      });
    }
    const task = await insertTask({ title, ...defaults });
    pool.push(task);
    created.push(task);
    return task;
  }

  return {
    async createTask(input: CreateTaskInput): Promise<Task> {
      return serialised(db, () => insertTask(input));
    },

    getTask,

    /**
     * Patches the descriptive fields of a task.
     *
     * Deliberately cannot touch `is_completed` or `is_locked`: both are derived
     * from the dependency graph and have their own transactional paths, and a
     * caller flipping them here would leave the chain inconsistent.
     */
    async updateTask(id: string, patch: UpdateTaskPatch): Promise<Result<Task>> {
      return serialised(db, async () => {
        const existing = await getTask(id);
        if (!existing) return fail('not_found', 'That task no longer exists.');

        const values: Partial<NewTask> = { updatedAt: now() };
        if (patch.title !== undefined) {
          const title = patch.title.trim();
          if (title.length === 0) return fail('invalid_input', 'A task needs a title.');
          values.title = title;
        }
        if (patch.priority !== undefined) {
          if (!Number.isInteger(patch.priority) || patch.priority < 1 || patch.priority > 3) {
            return fail('invalid_input', 'Priority must be 1 (high), 2 or 3 (low).');
          }
          values.priority = patch.priority;
        }
        if (patch.dueDate !== undefined) values.dueDate = patch.dueDate;
        if (patch.notes !== undefined) values.notes = patch.notes;
        if (patch.projectId !== undefined) values.projectId = patch.projectId;
        if (patch.estimatedMinutes !== undefined) values.estimatedMinutes = patch.estimatedMinutes;
        if (patch.calendarEventId !== undefined) values.calendarEventId = patch.calendarEventId;

        await db.update(tasks).set(values).where(eq(tasks.id, id));
        return ok(await requireTask(id));
      });
    },

    async addDependencies(input: AddDependenciesInput): Promise<Result<AddDependenciesResult>> {
      return transactional(async () => {
        const child = await requireTask(input.childId);

        const parentIds = [...new Set(input.parentIds)];
        if (parentIds.length === 0) {
          throw new AppError('invalid_input', 'No prerequisites were given.');
        }

        const found = await db.select().from(tasks).where(inArray(tasks.id, parentIds));
        if (found.length !== parentIds.length) {
          const missing = parentIds.filter((id) => !found.some((t) => t.id === id));
          throw new AppError('not_found', 'Some of those prerequisites no longer exist.', {
            details: { missing },
          });
        }
        // Preserve the caller's order so error messages name the first offender.
        const parents = parentIds.map((id) => found.find((t) => t.id === id)!);

        await linkParents(child, parents);
        return { child: await requireTask(child.id), parents };
      });
    },

    /**
     * The voice shape: "I need to print the frame and order servos before I can
     * assemble the robot." Titles are resolved against what already exists and
     * anything unknown is created unlocked, all inside one transaction so a
     * rejected cycle does not leave stray tasks behind.
     */
    async addDependencyByTitles(
      input: AddDependencyByTitlesInput,
    ): Promise<Result<AddDependencyByTitlesResult>> {
      return transactional(async () => {
        const pool = await db.select().from(tasks);
        const created: Task[] = [];

        const child = await resolveOrCreate(input.childTitle, pool, created, {
          dueDate: input.childDue ?? null,
          projectId: input.projectId ?? null,
        });

        // An existing task learns the due date / project the user just spoke,
        // but an already-filed project is never reassigned behind their back.
        const patch: Partial<NewTask> = {};
        if (input.childDue != null && child.dueDate !== input.childDue) {
          patch.dueDate = input.childDue;
        }
        if (input.projectId != null && child.projectId == null) patch.projectId = input.projectId;
        if (Object.keys(patch).length > 0) {
          await db
            .update(tasks)
            .set({ ...patch, updatedAt: now() })
            .where(eq(tasks.id, child.id));
        }

        const parents: Task[] = [];
        const seen = new Set<string>();
        for (const raw of input.parentTitles) {
          const key = normalise(raw);
          if (key.length === 0 || seen.has(key)) continue;
          seen.add(key);
          parents.push(await resolveOrCreate(raw, pool, created, { projectId: input.projectId ?? null }));
        }
        if (parents.length === 0) {
          throw new AppError('invalid_input', 'No prerequisites were given.');
        }

        const refreshedChild = await requireTask(child.id);
        await linkParents(refreshedChild, parents);
        return { child: await requireTask(child.id), parents, created };
      });
    },

    async removeDependency(input: {
      parentId: string;
      childId: string;
    }): Promise<Result<RemoveDependencyResult>> {
      return transactional(async () => {
        const child = await requireTask(input.childId);
        const edge = and(
          eq(taskDependencies.parentTaskId, input.parentId),
          eq(taskDependencies.childTaskId, input.childId),
        );
        const present = await db.select().from(taskDependencies).where(edge).limit(1);
        await db.delete(taskDependencies).where(edge);
        const { task } = await recompute(child.id);
        return { child: task, removed: present.length > 0 };
      });
    },

    async recomputeLockState(taskId: string): Promise<Task> {
      return serialised(db, async () => (await recompute(taskId)).task);
    },

    async completeTask(id: string): Promise<Result<CompleteTaskResult>> {
      return transactional(async () => {
        const task = await requireTask(id);
        if (task.isCompleted === true) return { task, unlocked: [] };

        const at = now();
        await db
          .update(tasks)
          .set({ isCompleted: true, completedAt: at, updatedAt: at })
          .where(eq(tasks.id, id));

        const { unlocked } = await recomputeChildren(id);
        return { task: await requireTask(id), unlocked };
      });
    },

    async uncompleteTask(id: string): Promise<Result<UncompleteTaskResult>> {
      return transactional(async () => {
        const task = await requireTask(id);
        if (task.isCompleted !== true) return { task, relocked: [] };

        const at = now();
        await db
          .update(tasks)
          .set({ isCompleted: false, completedAt: null, updatedAt: at })
          .where(eq(tasks.id, id));

        const { relocked } = await recomputeChildren(id);
        return { task: await requireTask(id), relocked };
      });
    },

    /**
     * The FK cascade drops the edges, but the ex-children keep whatever lock
     * they had, so their state is captured first and rewritten after.
     */
    async deleteTask(id: string): Promise<Result<DeleteTaskResult>> {
      return transactional(async () => {
        const task = await requireTask(id);
        const children = await childIdsOf(id);
        await db.delete(tasks).where(eq(tasks.id, id));
        const { unlocked } = await recomputeChildren(id, children);
        return { task, unlocked };
      });
    },

    async listActiveTasks(options: ListActiveOptions = {}): Promise<Task[]> {
      const conditions = [NOT_COMPLETED];
      if (options.includeLocked !== true) conditions.push(NOT_LOCKED);
      if (options.projectId) conditions.push(eq(tasks.projectId, options.projectId));
      if (options.dueBefore != null) conditions.push(sql`${tasks.dueDate} < ${options.dueBefore}`);

      const query = db
        .select()
        .from(tasks)
        .where(and(...conditions))
        .orderBy(...TASK_ORDER);
      return options.limit != null ? query.limit(options.limit) : query;
    },

    async listTasks(filter: ListTasksFilter = {}): Promise<Task[]> {
      const conditions: SQL[] = [];
      if (filter.projectId) conditions.push(eq(tasks.projectId, filter.projectId));
      if (filter.completed === true) conditions.push(sql`coalesce(${tasks.isCompleted}, 0) = 1`);
      if (filter.completed === false) conditions.push(NOT_COMPLETED);
      if (filter.dueBefore != null) conditions.push(sql`${tasks.dueDate} < ${filter.dueBefore}`);

      const query = db
        .select()
        .from(tasks)
        .where(and(...conditions))
        .orderBy(...TASK_ORDER);
      return filter.limit != null ? query.limit(filter.limit) : query;
    },

    /** Prerequisites of `taskId` — what has to happen first. */
    async getBlockers(taskId: string): Promise<Task[]> {
      const rows = await db
        .select({ task: tasks })
        .from(taskDependencies)
        .innerJoin(tasks, eq(tasks.id, taskDependencies.parentTaskId))
        .where(eq(taskDependencies.childTaskId, taskId))
        .orderBy(asc(tasks.createdAt));
      return rows.map((r) => r.task);
    },

    /** Tasks waiting on `taskId`. */
    async getDependents(taskId: string): Promise<Task[]> {
      const rows = await db
        .select({ task: tasks })
        .from(taskDependencies)
        .innerJoin(tasks, eq(tasks.id, taskDependencies.childTaskId))
        .where(eq(taskDependencies.parentTaskId, taskId))
        .orderBy(asc(tasks.createdAt));
      return rows.map((r) => r.task);
    },

    async getGraph(): Promise<TaskGraph> {
      const nodes = await db.select().from(tasks).orderBy(asc(tasks.createdAt));
      const edges = await allEdges();
      return { nodes, edges };
    },

    /** Fuzzy "the thing I said" -> one task, or a question for the user. */
    async resolveTask(query: string, options: ResolveTaskOptions = {}): Promise<Result<Task>> {
      const trimmed = query.trim();
      if (trimmed.length === 0) {
        return fail('invalid_input', 'I did not catch which task you meant.');
      }

      const rows = await db
        .select({ task: tasks, projectName: projects.name })
        .from(tasks)
        .leftJoin(projects, eq(projects.id, tasks.projectId));

      const candidates = rows
        .filter((r) => options.includeCompleted !== false || r.task.isCompleted !== true)
        .filter((r) => !options.projectId || r.task.projectId === options.projectId)
        .map((r) => toCandidate(r.task, r.projectName));

      const outcome = resolveOne(trimmed, candidates);
      if (outcome.kind === 'none') {
        return fail('not_found', `I could not find a task like "${trimmed}".`);
      }
      if (outcome.kind === 'ambiguous') {
        const titles = outcome.matches.map((m) => m.text);
        return fail('ambiguous', `Did you mean ${titles.slice(0, 3).join(', or ')}?`, {
          details: { titles },
        });
      }
      return ok(outcome.match.item);
    },
  };
}

export type TasksRepository = ReturnType<typeof createTasksRepository>;

/**
 * Tiebreaker in [0,1] for fuzzy resolution: what is still open, and due soon,
 * is far more likely to be what the user just referred to.
 */
function urgencyBoost(task: Task, at: number): number {
  const open = task.isCompleted === true ? 0 : 0.6;
  if (task.dueDate == null) return open;
  const days = calendarDaysBetween(at, task.dueDate);
  if (days <= 0) return Math.min(1, open + 0.4);
  if (days >= 14) return open;
  return Math.min(1, open + 0.4 * (1 - days / 14));
}
