/**
 * Dependency-chain tasks.
 *
 * Completing a task is one of the four interactions that must feel instant
 * (spec 5.4), so it runs the full optimistic cycle. It is also genuinely
 * cross-domain: finishing a prerequisite unlocks its children and changes what
 * Today shows, so a completion invalidates more than the list it was tapped in.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { now } from '@/core/clock';
import { unwrap } from '@/core/result';
import type { Task } from '@/db/schema';
import { getRepositories } from '@/repositories';
import type {
  AddDependenciesInput,
  AddDependenciesResult,
  AddDependencyByTitlesInput,
  AddDependencyByTitlesResult,
  CompleteTaskResult,
  CreateTaskInput,
  DeleteTaskResult,
  ListActiveOptions,
  ListTasksFilter,
  RemoveDependencyResult,
  ResolveTaskOptions,
  TaskGraph,
  UncompleteTaskResult,
  UpdateTaskPatch,
} from '@/repositories/tasks';

import {
  cancelKeys,
  invalidateKeys,
  qk,
  restoreQueries,
  snapshotQueries,
  type QuerySnapshot,
} from './keys';

/** A task can sit in a project overview and on Today, so every write touches all three. */
// The briefing is composed from open and overdue tasks, so any task write
// stales it — wherever in the app the write came from.
const TASK_WRITE_KEYS = [qk.tasks.all, qk.today.all, qk.projects.all, qk.briefing.all] as const;

/* ------------------------------------------------------------------- reads */

export function useTasks(filter: ListTasksFilter = {}): UseQueryResult<Task[]> {
  return useQuery({
    queryKey: qk.tasks.list(filter),
    queryFn: () => getRepositories().tasks.listTasks(filter),
  });
}

export function useActiveTasks(options: ListActiveOptions = {}): UseQueryResult<Task[]> {
  return useQuery({
    queryKey: qk.tasks.active(options),
    queryFn: () => getRepositories().tasks.listActiveTasks(options),
  });
}

export function useTask(
  id: string | undefined,
  options: { enabled?: boolean } = {},
): UseQueryResult<Task | null> {
  return useQuery({
    queryKey: qk.tasks.detail(id ?? ''),
    queryFn: () => getRepositories().tasks.getTask(id!),
    enabled: (options.enabled ?? true) && Boolean(id),
  });
}

export function useTaskBlockers(
  id: string | undefined,
  options: { enabled?: boolean } = {},
): UseQueryResult<Task[]> {
  return useQuery({
    queryKey: qk.tasks.blockers(id ?? ''),
    queryFn: () => getRepositories().tasks.getBlockers(id!),
    enabled: (options.enabled ?? true) && Boolean(id),
  });
}

export function useTaskDependents(
  id: string | undefined,
  options: { enabled?: boolean } = {},
): UseQueryResult<Task[]> {
  return useQuery({
    queryKey: qk.tasks.dependents(id ?? ''),
    queryFn: () => getRepositories().tasks.getDependents(id!),
    enabled: (options.enabled ?? true) && Boolean(id),
  });
}

export function useTaskGraph(): UseQueryResult<TaskGraph> {
  return useQuery({
    queryKey: qk.tasks.graph(),
    queryFn: () => getRepositories().tasks.getGraph(),
  });
}

/* --------------------------------------------------------------- optimism */

function isTaskRow(value: unknown): value is Task {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'title' in value &&
    'isCompleted' in value
  );
}

/**
 * Rewrites one task wherever it is cached.
 *
 * The cache under `qk.tasks.all` holds several shapes — arrays of rows, a
 * single row, a graph — and which of them is mounted is the screen's business,
 * not this file's. So the patch is shape-driven and leaves anything it does not
 * recognise untouched.
 */
function patchTaskInCache(data: unknown, id: string, patch: Partial<Task>): unknown {
  if (Array.isArray(data)) {
    let changed = false;
    const next = data.map((row) => {
      if (!isTaskRow(row) || row.id !== id) return row;
      changed = true;
      return { ...row, ...patch };
    });
    return changed ? next : data;
  }
  if (isTaskRow(data) && data.id === id) return { ...data, ...patch };
  if (typeof data === 'object' && data !== null && 'nodes' in data && 'edges' in data) {
    const graph = data as TaskGraph;
    return { ...graph, nodes: patchTaskInCache(graph.nodes, id, patch) as Task[] };
  }
  return data;
}

type OptimisticContext = { previous: QuerySnapshot };

async function beginOptimisticTaskPatch(
  client: ReturnType<typeof useQueryClient>,
  id: string,
  patch: Partial<Task>,
): Promise<OptimisticContext> {
  await cancelKeys(client, TASK_WRITE_KEYS);
  const previous = snapshotQueries(client, [qk.tasks.all, qk.today.all]);
  client.setQueriesData<unknown>({ queryKey: qk.tasks.all }, (data: unknown) =>
    patchTaskInCache(data, id, patch),
  );
  return { previous };
}

/* ------------------------------------------------------------------ writes */

export function useCreateTask(): UseMutationResult<Task, Error, CreateTaskInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskInput) => getRepositories().tasks.createTask(input),
    onSettled: () => invalidateKeys(client, TASK_WRITE_KEYS),
  });
}

/**
 * The editable columns, owned by the repository and re-exported rather than
 * restated: a second copy of the list here would drift the moment a column is
 * added, and screens would silently lose the ability to set it.
 */
export type TaskPatch = UpdateTaskPatch;

export type UpdateTaskInput = { id: string; patch: TaskPatch };

/**
 * Field edits: due date, priority, estimate, project, title, notes.
 *
 * `tasks.updateTask` owns the validation and deliberately cannot touch
 * `is_completed` / `is_locked` — both are derived from the dependency graph —
 * so every DAG invariant stays in the repository. The only thing this hook adds
 * is the optimistic patch, because setting a due date must feel instant.
 */
export function useUpdateTask(): UseMutationResult<Task, Error, UpdateTaskInput, OptimisticContext> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: UpdateTaskInput) =>
      unwrap(await getRepositories().tasks.updateTask(id, patch)),
    onMutate: ({ id, patch }) =>
      beginOptimisticTaskPatch(client, id, { ...definedFields(patch), updatedAt: now() }),
    onError: (_error, _input, context) => restoreQueries(client, context?.previous),
    onSettled: () => invalidateKeys(client, TASK_WRITE_KEYS),
  });
}

/**
 * The patch as the *cache* should see it.
 *
 * Absent keys are dropped so an optimistic write cannot blank a column the user
 * never touched, and the title is trimmed the way the repository will store it.
 * Nothing is validated here: a patch the repository rejects fails the mutation,
 * and `onError` puts the previous rows back.
 */
function definedFields(patch: TaskPatch): Partial<Task> {
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) changes[key] = value;
  }
  if (typeof changes.title === 'string') {
    const title = changes.title.trim();
    if (title.length === 0) delete changes.title;
    else changes.title = title;
  }
  return changes as Partial<Task>;
}

/** Spec 5.4: the checkbox flips before the write lands, and rolls back if it fails. */
export function useCompleteTask(): UseMutationResult<
  CompleteTaskResult,
  Error,
  string,
  OptimisticContext
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => unwrap(await getRepositories().tasks.completeTask(id)),
    onMutate: (id) => {
      const at = now();
      return beginOptimisticTaskPatch(client, id, {
        isCompleted: true,
        completedAt: at,
        updatedAt: at,
      });
    },
    onError: (_error, _id, context) => restoreQueries(client, context?.previous),
    onSettled: () => invalidateKeys(client, TASK_WRITE_KEYS),
  });
}

export function useUncompleteTask(): UseMutationResult<
  UncompleteTaskResult,
  Error,
  string,
  OptimisticContext
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => unwrap(await getRepositories().tasks.uncompleteTask(id)),
    onMutate: (id) =>
      beginOptimisticTaskPatch(client, id, {
        isCompleted: false,
        completedAt: null,
        updatedAt: now(),
      }),
    onError: (_error, _id, context) => restoreQueries(client, context?.previous),
    onSettled: () => invalidateKeys(client, TASK_WRITE_KEYS),
  });
}

export function useDeleteTask(): UseMutationResult<DeleteTaskResult, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => unwrap(await getRepositories().tasks.deleteTask(id)),
    onSettled: () => invalidateKeys(client, TASK_WRITE_KEYS),
  });
}

export function useAddTaskDependencies(): UseMutationResult<
  AddDependenciesResult,
  Error,
  AddDependenciesInput
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddDependenciesInput) =>
      unwrap(await getRepositories().tasks.addDependencies(input)),
    onSettled: () => invalidateKeys(client, TASK_WRITE_KEYS),
  });
}

export function useAddTaskDependencyByTitles(): UseMutationResult<
  AddDependencyByTitlesResult,
  Error,
  AddDependencyByTitlesInput
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddDependencyByTitlesInput) =>
      unwrap(await getRepositories().tasks.addDependencyByTitles(input)),
    onSettled: () => invalidateKeys(client, TASK_WRITE_KEYS),
  });
}

export function useRemoveTaskDependency(): UseMutationResult<
  RemoveDependencyResult,
  Error,
  { parentId: string; childId: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { parentId: string; childId: string }) =>
      unwrap(await getRepositories().tasks.removeDependency(input)),
    onSettled: () => invalidateKeys(client, TASK_WRITE_KEYS),
  });
}

export function useRecomputeTaskLock(): UseMutationResult<Task, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => getRepositories().tasks.recomputeLockState(taskId),
    onSettled: () => invalidateKeys(client, [qk.tasks.all, qk.today.all]),
  });
}

/** Fuzzy "the thing I said" -> one task. Imperative, so it is a mutation. */
export function useResolveTask(): UseMutationResult<
  Task,
  Error,
  { query: string; options?: ResolveTaskOptions }
> {
  return useMutation({
    mutationFn: async ({ query, options }: { query: string; options?: ResolveTaskOptions }) =>
      unwrap(await getRepositories().tasks.resolveTask(query, options)),
  });
}
