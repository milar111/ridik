/**
 * Projects / groups / events — the containers everything else can be filed in.
 *
 * Ticking a project item is spec 5.4 instant. The optimistic patch also
 * recomputes the overview's counters, because a checklist whose "3 of 11" only
 * catches up after the round trip reads as a bug.
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
import type { Project, ProjectItem, ProjectSection } from '@/db/schema';
import { getRepositories } from '@/repositories';
import type {
  CreateProjectInput,
  ProjectCounts,
  ProjectItemInput,
  ProjectItemPatch,
  ProjectKind,
  ProjectOverview,
  ProjectPatch,
  ProjectSectionView,
  ProjectStatus,
} from '@/repositories/projects';

import {
  cancelKeys,
  invalidateKeys,
  qk,
  restoreQueries,
  snapshotQueries,
  type QuerySnapshot,
} from './keys';

const PROJECT_WRITE_KEYS = [qk.projects.all] as const;

/**
 * Deleting a container nulls `project_id` on the tasks, notes, checklists and
 * transactions that referenced it — none of which are deleted, all of which are
 * now shown in the wrong place until they are refetched.
 */
const PROJECT_DELETE_KEYS = [
  qk.projects.all,
  qk.tasks.all,
  qk.notes.all,
  qk.checklists.all,
  qk.ledger.all,
  qk.today.all,
] as const;

/* ------------------------------------------------------------------- reads */

export function useProjects(status?: ProjectStatus): UseQueryResult<Project[]> {
  return useQuery({
    queryKey: qk.projects.list(status),
    queryFn: () => getRepositories().projects.listProjects(status ? { status } : {}),
  });
}

export function useProject(
  id: string | undefined,
  options: { enabled?: boolean } = {},
): UseQueryResult<Project | null> {
  return useQuery({
    queryKey: qk.projects.detail(id ?? ''),
    queryFn: () => getRepositories().projects.getProject(id!),
    enabled: (options.enabled ?? true) && Boolean(id),
  });
}

export function useProjectOverview(
  id: string | undefined,
  options: { enabled?: boolean } = {},
): UseQueryResult<ProjectOverview | null> {
  return useQuery({
    queryKey: qk.projects.overview(id ?? ''),
    queryFn: () => getRepositories().projects.getProjectOverview(id!),
    enabled: (options.enabled ?? true) && Boolean(id),
  });
}

export function useProjectItems(
  id: string | undefined,
  options: { enabled?: boolean } = {},
): UseQueryResult<ProjectItem[]> {
  return useQuery({
    queryKey: qk.projects.items(id ?? ''),
    queryFn: () => getRepositories().projects.listItems(id!),
    enabled: (options.enabled ?? true) && Boolean(id),
  });
}

export function useProjectSections(
  id: string | undefined,
  options: { enabled?: boolean } = {},
): UseQueryResult<ProjectSection[]> {
  return useQuery({
    queryKey: qk.projects.sections(id ?? ''),
    queryFn: () => getRepositories().projects.listSections(id!),
    enabled: (options.enabled ?? true) && Boolean(id),
  });
}

export type ProjectSummary = { project: Project; counts: ProjectCounts };

/**
 * Every project with the counts its progress bar needs.
 *
 * `listProjects` returns bare rows and `getProjectOverview` costs four extra
 * joins per project, so the list screen reads the items directly and counts
 * them with the same definition the overview uses.
 */
export function useProjectSummaries(
  status?: ProjectStatus,
): UseQueryResult<ProjectSummary[]> {
  return useQuery({
    queryKey: qk.projects.summaries(status),
    queryFn: async () => {
      const repositories = getRepositories();
      const list = await repositories.projects.listProjects(status ? { status } : {});
      return Promise.all(
        list.map(async (project) => ({
          project,
          counts: countsOf(await repositories.projects.listItems(project.id)),
        })),
      );
    },
  });
}

/* --------------------------------------------------------------- optimism */

function isProjectItem(value: unknown): value is ProjectItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    'projectId' in value &&
    'isCheckbox' in value
  );
}

function isOverview(value: unknown): value is ProjectOverview {
  return (
    typeof value === 'object' &&
    value !== null &&
    'project' in value &&
    'sections' in value &&
    'counts' in value
  );
}

/** The same definition `getProjectOverview` uses, so the two never disagree. */
function countsOf(items: readonly ProjectItem[]): ProjectCounts {
  return {
    total: items.length,
    done: items.filter((item) => item.isCompleted).length,
    openTodos: items.filter((item) => !item.isCompleted && (item.kind === 'todo' || item.isCheckbox))
      .length,
  };
}

function patchItemRows(
  items: readonly ProjectItem[],
  itemId: string,
  patch: Partial<ProjectItem>,
): { items: ProjectItem[]; changed: boolean } {
  let changed = false;
  const next = items.map((item) => {
    if (item.id !== itemId) return item;
    changed = true;
    return { ...item, ...patch };
  });
  return { items: next, changed };
}

function patchProjectItemInCache(
  data: unknown,
  itemId: string,
  patch: Partial<ProjectItem>,
): unknown {
  if (Array.isArray(data)) {
    if (!data.every(isProjectItem)) return data;
    const { items, changed } = patchItemRows(data, itemId, patch);
    return changed ? items : data;
  }

  if (isOverview(data)) {
    let changed = false;
    const sections: ProjectSectionView[] = data.sections.map((view) => {
      const patched = patchItemRows(view.items, itemId, patch);
      if (!patched.changed) return view;
      changed = true;
      return { ...view, items: patched.items };
    });
    if (!changed) return data;
    return {
      ...data,
      sections,
      counts: countsOf(sections.flatMap((view) => view.items)),
    };
  }

  return data;
}

type OptimisticContext = { previous: QuerySnapshot };

/* ------------------------------------------------------------------ writes */

export function useCreateProject(): UseMutationResult<Project, Error, CreateProjectInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => getRepositories().projects.createProject(input),
    onSettled: () => invalidateKeys(client, PROJECT_WRITE_KEYS),
  });
}

export function useGetOrCreateProject(): UseMutationResult<
  Project,
  Error,
  { name: string; kind?: ProjectKind }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; kind?: ProjectKind }) =>
      getRepositories().projects.getOrCreateProject(input.name, input.kind),
    onSettled: () => invalidateKeys(client, PROJECT_WRITE_KEYS),
  });
}

export function useUpdateProject(): UseMutationResult<
  Project,
  Error,
  { projectId: string; patch: ProjectPatch }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { projectId: string; patch: ProjectPatch }) =>
      getRepositories().projects.updateProject(input.projectId, input.patch),
    onSettled: () => invalidateKeys(client, PROJECT_WRITE_KEYS),
  });
}

export function useSetProjectStatus(): UseMutationResult<
  Project,
  Error,
  { projectId: string; status: ProjectStatus }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { projectId: string; status: ProjectStatus }) =>
      getRepositories().projects.setStatus(input.projectId, input.status),
    onSettled: () => invalidateKeys(client, PROJECT_WRITE_KEYS),
  });
}

export function useArchiveProject(): UseMutationResult<Project, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => getRepositories().projects.archiveProject(projectId),
    onSettled: () => invalidateKeys(client, PROJECT_WRITE_KEYS),
  });
}

export function useDeleteProject(): UseMutationResult<void, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => getRepositories().projects.deleteProject(projectId),
    onSettled: () => invalidateKeys(client, PROJECT_DELETE_KEYS),
  });
}

export function useAddProjectItems(): UseMutationResult<
  ProjectItem[],
  Error,
  { projectId: string; items: ProjectItemInput[] }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { projectId: string; items: ProjectItemInput[] }) =>
      getRepositories().projects.addItems(input.projectId, input.items),
    onSettled: () => invalidateKeys(client, PROJECT_WRITE_KEYS),
  });
}

/** Spec 5.4: the checkbox and the counters move on tap. */
export function useToggleProjectItem(): UseMutationResult<
  ProjectItem,
  Error,
  { itemId: string; completed: boolean },
  OptimisticContext
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { itemId: string; completed: boolean }) =>
      getRepositories().projects.toggleItem(input.itemId, input.completed),
    onMutate: async (input) => {
      await cancelKeys(client, PROJECT_WRITE_KEYS);
      const previous = snapshotQueries(client, PROJECT_WRITE_KEYS);
      const at = now();
      client.setQueriesData<unknown>({ queryKey: qk.projects.all }, (data: unknown) =>
        patchProjectItemInCache(data, input.itemId, {
          isCompleted: input.completed,
          completedAt: input.completed ? at : null,
          updatedAt: at,
        }),
      );
      return { previous };
    },
    onError: (_error, _input, context) => restoreQueries(client, context?.previous),
    onSettled: () => invalidateKeys(client, PROJECT_WRITE_KEYS),
  });
}

export function useUpdateProjectItem(): UseMutationResult<
  ProjectItem,
  Error,
  { itemId: string; patch: ProjectItemPatch }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { itemId: string; patch: ProjectItemPatch }) =>
      getRepositories().projects.updateItem(input.itemId, input.patch),
    onSettled: () => invalidateKeys(client, PROJECT_WRITE_KEYS),
  });
}

export function useMoveProjectItem(): UseMutationResult<
  ProjectItem,
  Error,
  { itemId: string; sectionId: string | null }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { itemId: string; sectionId: string | null }) =>
      getRepositories().projects.moveItem(input.itemId, input.sectionId),
    onSettled: () => invalidateKeys(client, PROJECT_WRITE_KEYS),
  });
}

export function useDeleteProjectItem(): UseMutationResult<void, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => getRepositories().projects.deleteItem(itemId),
    onSettled: () => invalidateKeys(client, PROJECT_WRITE_KEYS),
  });
}

export function useReorderProjectItems(): UseMutationResult<
  void,
  Error,
  { projectId: string; orderedIds: string[] }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { projectId: string; orderedIds: string[] }) =>
      getRepositories().projects.reorderItems(input.projectId, input.orderedIds),
    onSettled: () => invalidateKeys(client, PROJECT_WRITE_KEYS),
  });
}

export function useAddProjectSection(): UseMutationResult<
  ProjectSection,
  Error,
  { projectId: string; title: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { projectId: string; title: string }) =>
      getRepositories().projects.addSection(input.projectId, input.title),
    onSettled: () => invalidateKeys(client, PROJECT_WRITE_KEYS),
  });
}

export function useRenameProjectSection(): UseMutationResult<
  ProjectSection,
  Error,
  { sectionId: string; title: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { sectionId: string; title: string }) =>
      getRepositories().projects.renameSection(input.sectionId, input.title),
    onSettled: () => invalidateKeys(client, PROJECT_WRITE_KEYS),
  });
}

export function useReorderProjectSections(): UseMutationResult<
  void,
  Error,
  { projectId: string; orderedIds: string[] }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { projectId: string; orderedIds: string[] }) =>
      getRepositories().projects.reorderSections(input.projectId, input.orderedIds),
    onSettled: () => invalidateKeys(client, PROJECT_WRITE_KEYS),
  });
}

export function useDeleteProjectSection(): UseMutationResult<void, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (sectionId: string) => getRepositories().projects.deleteSection(sectionId),
    onSettled: () => invalidateKeys(client, PROJECT_WRITE_KEYS),
  });
}

export function useResolveProject(): UseMutationResult<Project, Error, string> {
  return useMutation({
    mutationFn: async (query: string) =>
      unwrap(await getRepositories().projects.resolveProject(query)),
  });
}

export function useResolveProjectItem(): UseMutationResult<
  ProjectItem,
  Error,
  { query: string; projectId?: string }
> {
  return useMutation({
    mutationFn: async (input: { query: string; projectId?: string }) =>
      unwrap(await getRepositories().projects.resolveItem(input)),
  });
}
