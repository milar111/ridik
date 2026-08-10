/**
 * Projects / groups / events — the containers the user dumps things into.
 *
 * The user only ever has one handle on a container: the words they said. So the
 * name index is case-insensitive and creation is idempotent — saying a name
 * that already exists lands in that project instead of forking a near-duplicate
 * ("Vacation" / "vacation"). Everything else (order indexes, section creation)
 * is derived here rather than asked for, because nobody dictates an order index.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { now } from '@/core/clock';
import { normalise, resolveOne, type Candidate } from '@/core/match';
import { AppError, fail, ok, type Result } from '@/core/result';
import { calendarDaysBetween } from '@/core/time';
import { newId } from '@/db/ids';
import type { RidikDatabase } from '@/db/migrator';
import {
  checklists,
  notes,
  projectItems,
  projectSections,
  projects,
  tasks,
  transactions,
  type ChecklistItem,
  type Note,
  type Project,
  type ProjectItem,
  type ProjectSection,
  type Task,
  type Transaction,
} from '@/db/schema';

export type ProjectKind = Project['kind'];
export type ProjectStatus = Project['status'];
export type ProjectItemKind = ProjectItem['kind'];

export type CreateProjectInput = {
  name: string;
  kind?: ProjectKind;
  description?: string | null;
  startDate?: number | null;
  targetDate?: number | null;
  emoji?: string | null;
  color?: string | null;
  sections?: string[];
};

export type ProjectItemInput = {
  content: string;
  kind?: ProjectItemKind;
  detail?: string | null;
  isCheckbox?: boolean;
  sectionTitle?: string | null;
  dueDate?: number | null;
};

export type ProjectItemPatch = {
  content?: string;
  kind?: ProjectItemKind;
  detail?: string | null;
  isCheckbox?: boolean;
  isCompleted?: boolean;
  dueDate?: number | null;
};

export type ProjectPatch = {
  name?: string;
  kind?: ProjectKind;
  description?: string | null;
  startDate?: number | null;
  targetDate?: number | null;
  emoji?: string | null;
  color?: string | null;
};

/** A section and its items; `section: null` is the un-sectioned bucket. */
export type ProjectSectionView = { section: ProjectSection | null; items: ProjectItem[] };

export type ProjectCounts = { total: number; done: number; openTodos: number };

export type ProjectOverview = {
  project: Project;
  sections: ProjectSectionView[];
  counts: ProjectCounts;
  linked: {
    tasks: Task[];
    notes: Note[];
    checklists: ChecklistItem[];
    transactions: Transaction[];
  };
};

/** Sort key for "what am I working on": active first, archived last. */
const STATUS_RANK = sql`CASE ${projects.status} WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'done' THEN 2 ELSE 3 END`;

const STATUS_BOOST: Record<ProjectStatus, number> = {
  active: 0.6,
  paused: 0.35,
  done: 0.15,
  archived: 0,
};

/** Recency fades over a month; a project touched today wins a near-tie. */
function recencyBoost(updatedAt: number, at: number): number {
  const days = Math.max(0, calendarDaysBetween(updatedAt, at));
  return Math.max(0, 1 - days / 30);
}

function projectBoost(project: Project, at: number): number {
  return Math.min(1, STATUS_BOOST[project.status] + recencyBoost(project.updatedAt, at) * 0.4);
}

const sectionKey = (sectionId: string | null) => sectionId ?? '';

export function createProjectsRepository(db: RidikDatabase) {
  /* ------------------------------------------------------------- plumbing -- */

  /**
   * Raw transaction control: the driver is synchronous, but our methods are
   * async, so Drizzle's callback-style `transaction()` cannot host an awaited
   * body. See `src/db/migrator.ts` for the same pattern.
   */
  async function atomically<T>(fn: () => Promise<T>): Promise<T> {
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

  async function touch(projectId: string, at: number): Promise<void> {
    await db.update(projects).set({ updatedAt: at }).where(eq(projects.id, projectId));
  }

  async function findProject(id: string): Promise<Project | null> {
    const rows = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async function requireProject(id: string): Promise<Project> {
    const project = await findProject(id);
    if (!project) throw new AppError('not_found', 'That project no longer exists.');
    return project;
  }

  async function requireItem(id: string): Promise<ProjectItem> {
    const rows = await db.select().from(projectItems).where(eq(projectItems.id, id)).limit(1);
    const item = rows[0];
    if (!item) throw new AppError('not_found', 'That item no longer exists.');
    return item;
  }

  async function requireSection(id: string): Promise<ProjectSection> {
    const rows = await db.select().from(projectSections).where(eq(projectSections.id, id)).limit(1);
    const section = rows[0];
    if (!section) throw new AppError('not_found', 'That section no longer exists.');
    return section;
  }

  async function findByName(name: string): Promise<Project | null> {
    const rows = await db
      .select()
      .from(projects)
      .where(sql`${projects.name} = ${name} COLLATE NOCASE`)
      .limit(1);
    return rows[0] ?? null;
  }

  async function sectionsOf(projectId: string): Promise<ProjectSection[]> {
    return db
      .select()
      .from(projectSections)
      .where(eq(projectSections.projectId, projectId))
      .orderBy(asc(projectSections.orderIndex), asc(projectSections.id));
  }

  async function maxSectionOrder(projectId: string): Promise<number> {
    const rows = await db
      .select({ value: sql<number | null>`max(${projectSections.orderIndex})` })
      .from(projectSections)
      .where(eq(projectSections.projectId, projectId));
    return rows[0]?.value ?? -1;
  }

  async function maxItemOrder(projectId: string, sectionId: string | null): Promise<number> {
    const rows = await db
      .select({ value: sql<number | null>`max(${projectItems.orderIndex})` })
      .from(projectItems)
      .where(
        and(
          eq(projectItems.projectId, projectId),
          sectionId === null
            ? isNull(projectItems.sectionId)
            : eq(projectItems.sectionId, sectionId),
        ),
      );
    return rows[0]?.value ?? -1;
  }

  /** Section lookup is fuzzy-normalised so "Packing!" and "packing" are one. */
  async function ensureSection(
    projectId: string,
    title: string,
    at: number,
    cache?: Map<string, ProjectSection>,
  ): Promise<ProjectSection> {
    const trimmed = title.trim();
    if (!trimmed) throw new AppError('invalid_input', 'A section needs a title.');
    const key = normalise(trimmed);

    const known = cache ?? new Map((await sectionsOf(projectId)).map((s) => [normalise(s.title), s]));
    const existing = known.get(key);
    if (existing) return existing;

    const section: ProjectSection = {
      id: newId(),
      projectId,
      title: trimmed,
      orderIndex: (await maxSectionOrder(projectId)) + 1,
      createdAt: at,
    };
    await db.insert(projectSections).values(section);
    known.set(key, section);
    return section;
  }

  /* --------------------------------------------------------------- create -- */

  /**
   * Upsert by name. An existing project is returned with any *gaps* filled from
   * the input — never overwritten, because the second mention of a project is
   * usually shorthand ("add to the trip") and must not erase what the first one
   * established.
   */
  async function createProject(input: CreateProjectInput): Promise<Project> {
    const name = input.name.trim();
    if (!name) throw new AppError('invalid_input', 'A project needs a name.');
    const at = now();

    return atomically(async () => {
      const existing = await findByName(name);
      if (existing) return mergeInto(existing, input, at);

      const id = newId();
      await db.insert(projects).values({
        id,
        name,
        kind: input.kind ?? 'project',
        description: input.description ?? null,
        status: 'active',
        startDate: input.startDate ?? null,
        targetDate: input.targetDate ?? null,
        color: input.color ?? null,
        emoji: input.emoji ?? null,
        createdAt: at,
        updatedAt: at,
      });

      const cache = new Map<string, ProjectSection>();
      for (const title of input.sections ?? []) {
        if (title.trim()) await ensureSection(id, title, at, cache);
      }
      return requireProject(id);
    });
  }

  async function mergeInto(
    existing: Project,
    input: CreateProjectInput,
    at: number,
  ): Promise<Project> {
    const patch: Partial<Project> = {};
    // A blank string is a gap too: an earlier utterance that carried no detail
    // must not lock the field shut against a later one that does.
    if (!existing.description && input.description) patch.description = input.description;
    if (existing.startDate === null && input.startDate != null) patch.startDate = input.startDate;
    if (existing.targetDate === null && input.targetDate != null) patch.targetDate = input.targetDate;
    if (!existing.emoji && input.emoji) patch.emoji = input.emoji;
    if (!existing.color && input.color) patch.color = input.color;

    const cache = new Map((await sectionsOf(existing.id)).map((s) => [normalise(s.title), s]));
    let addedSection = false;
    for (const title of input.sections ?? []) {
      if (!title.trim()) continue;
      const before = cache.size;
      await ensureSection(existing.id, title, at, cache);
      if (cache.size !== before) addedSection = true;
    }

    if (Object.keys(patch).length === 0 && !addedSection) return existing;
    await db
      .update(projects)
      .set({ ...patch, updatedAt: at })
      .where(eq(projects.id, existing.id));
    return requireProject(existing.id);
  }

  async function getOrCreateProject(name: string, kind?: ProjectKind): Promise<Project> {
    return createProject({ name, kind });
  }

  /* -------------------------------------------------------------- resolve -- */

  async function resolveProject(query: string): Promise<Result<Project>> {
    const at = now();
    const rows = await db.select().from(projects);
    if (rows.length === 0) return fail('not_found', 'You have no projects yet.');

    const titles = new Map<string, string[]>();
    for (const section of await db.select().from(projectSections)) {
      const list = titles.get(section.projectId) ?? [];
      list.push(section.title);
      titles.set(section.projectId, list);
    }

    const candidates: Candidate<Project>[] = rows.map((project) => ({
      item: project,
      text: project.name,
      aux: [project.description, ...(titles.get(project.id) ?? [])].filter(
        (v): v is string => Boolean(v),
      ),
      boost: projectBoost(project, at),
    }));

    const outcome = resolveOne(query, candidates);
    if (outcome.kind === 'unique') return ok(outcome.match.item);
    if (outcome.kind === 'none') {
      return fail('not_found', `I could not find a project matching "${query}".`);
    }
    return fail(
      'ambiguous',
      `Several projects match "${query}": ${outcome.matches.map((m) => m.text).join(', ')}. Which one?`,
      { details: outcome.matches.map((m) => ({ id: m.item.id, name: m.item.name, score: m.score })) },
    );
  }

  async function resolveItem(input: {
    projectId?: string;
    query: string;
  }): Promise<Result<ProjectItem>> {
    const at = now();
    const rows = input.projectId
      ? await db.select().from(projectItems).where(eq(projectItems.projectId, input.projectId))
      : await db.select().from(projectItems);
    if (rows.length === 0) return fail('not_found', `I could not find "${input.query}".`);

    const titleById = new Map(
      (await db.select().from(projectSections)).map((s) => [s.id, s.title] as const),
    );
    const projectById = new Map(
      (await db.select().from(projects)).map((p) => [p.id, p] as const),
    );

    const candidates: Candidate<ProjectItem>[] = rows.map((item) => {
      const project = projectById.get(item.projectId);
      // An open item is the likelier target of "check off X", but boost only
      // ever breaks ties — it cannot promote an item the words do not match.
      const openness = item.isCompleted ? 0 : 0.5;
      const recency = project ? recencyBoost(project.updatedAt, at) * 0.5 : 0;
      return {
        item,
        text: item.content,
        aux: [item.detail, item.sectionId ? titleById.get(item.sectionId) : null].filter(
          (v): v is string => Boolean(v),
        ),
        boost: Math.min(1, openness + recency),
      };
    });

    const outcome = resolveOne(input.query, candidates);
    if (outcome.kind === 'unique') return ok(outcome.match.item);
    if (outcome.kind === 'none') {
      return fail('not_found', `I could not find an item matching "${input.query}".`);
    }
    return fail(
      'ambiguous',
      `Several items match "${input.query}": ${outcome.matches.map((m) => m.text).join(', ')}. Which one?`,
      { details: outcome.matches.map((m) => ({ id: m.item.id, content: m.item.content, score: m.score })) },
    );
  }

  /* ---------------------------------------------------------------- items -- */

  async function addItems(projectId: string, items: ProjectItemInput[]): Promise<ProjectItem[]> {
    if (items.length === 0) return [];
    const at = now();

    return atomically(async () => {
      await requireProject(projectId);
      const sectionCache = new Map(
        (await sectionsOf(projectId)).map((s) => [normalise(s.title), s]),
      );
      // Order indexes are per (project, section); cache the cursor so a batch of
      // twenty dictated items does not re-run max() twenty times.
      const cursors = new Map<string, number>();
      const created: ProjectItem[] = [];

      for (const input of items) {
        const content = input.content.trim();
        if (!content) throw new AppError('invalid_input', 'An item needs some text.');

        const section = input.sectionTitle?.trim()
          ? await ensureSection(projectId, input.sectionTitle, at, sectionCache)
          : null;
        const key = sectionKey(section?.id ?? null);
        let orderIndex = cursors.get(key);
        if (orderIndex === undefined) orderIndex = (await maxItemOrder(projectId, section?.id ?? null)) + 1;
        cursors.set(key, orderIndex + 1);

        const kind = input.kind ?? 'idea';
        const row: ProjectItem = {
          id: newId(),
          projectId,
          sectionId: section?.id ?? null,
          kind,
          content,
          detail: input.detail ?? null,
          isCheckbox: input.isCheckbox ?? (kind === 'todo'),
          isCompleted: false,
          completedAt: null,
          orderIndex,
          dueDate: input.dueDate ?? null,
          createdAt: at,
          updatedAt: at,
        };
        await db.insert(projectItems).values(row);
        created.push(row);
      }

      await touch(projectId, at);
      return created;
    });
  }

  async function toggleItem(itemId: string, completed: boolean): Promise<ProjectItem> {
    const at = now();
    return atomically(async () => {
      const item = await requireItem(itemId);
      await db
        .update(projectItems)
        .set({ isCompleted: completed, completedAt: completed ? at : null, updatedAt: at })
        .where(eq(projectItems.id, itemId));
      await touch(item.projectId, at);
      return requireItem(itemId);
    });
  }

  async function updateItem(itemId: string, patch: ProjectItemPatch): Promise<ProjectItem> {
    const at = now();
    return atomically(async () => {
      const item = await requireItem(itemId);
      const set: Partial<ProjectItem> = { updatedAt: at };
      if (patch.content !== undefined) {
        const content = patch.content.trim();
        if (!content) throw new AppError('invalid_input', 'An item needs some text.');
        set.content = content;
      }
      if (patch.kind !== undefined) set.kind = patch.kind;
      if (patch.detail !== undefined) set.detail = patch.detail;
      if (patch.isCheckbox !== undefined) set.isCheckbox = patch.isCheckbox;
      if (patch.dueDate !== undefined) set.dueDate = patch.dueDate;
      if (patch.isCompleted !== undefined) {
        set.isCompleted = patch.isCompleted;
        set.completedAt = patch.isCompleted ? at : null;
      }

      await db.update(projectItems).set(set).where(eq(projectItems.id, itemId));
      await touch(item.projectId, at);
      return requireItem(itemId);
    });
  }

  async function moveItem(itemId: string, sectionId: string | null): Promise<ProjectItem> {
    const at = now();
    return atomically(async () => {
      const item = await requireItem(itemId);
      if (sectionId !== null) {
        const section = await requireSection(sectionId);
        if (section.projectId !== item.projectId) {
          throw new AppError('invalid_input', 'That section belongs to a different project.');
        }
      }
      const orderIndex = (await maxItemOrder(item.projectId, sectionId)) + 1;
      await db
        .update(projectItems)
        .set({ sectionId, orderIndex, updatedAt: at })
        .where(eq(projectItems.id, itemId));
      await touch(item.projectId, at);
      return requireItem(itemId);
    });
  }

  async function deleteItem(itemId: string): Promise<void> {
    const at = now();
    await atomically(async () => {
      const item = await requireItem(itemId);
      await db.delete(projectItems).where(eq(projectItems.id, itemId));
      await touch(item.projectId, at);
    });
  }

  /**
   * Reorders within each section the listed ids touch. Items of that section
   * that were not listed keep their relative order and follow the listed ones,
   * so a partial list from the UI can never collapse two items onto one index.
   */
  async function reorderItems(projectId: string, orderedIds: string[]): Promise<void> {
    if (orderedIds.length === 0) return;
    const at = now();
    await atomically(async () => {
      await requireProject(projectId);
      const all = await db
        .select()
        .from(projectItems)
        .where(eq(projectItems.projectId, projectId))
        .orderBy(asc(projectItems.orderIndex), asc(projectItems.id));
      const byId = new Map(all.map((i) => [i.id, i] as const));

      const listed = new Map<string, string[]>();
      for (const id of orderedIds) {
        const item = byId.get(id);
        if (!item) throw new AppError('invalid_input', 'That item is not in this project.');
        const key = sectionKey(item.sectionId);
        listed.set(key, [...(listed.get(key) ?? []), id]);
      }

      for (const [key, ids] of listed) {
        const pinned = new Set(ids);
        const rest = all.filter((i) => sectionKey(i.sectionId) === key && !pinned.has(i.id));
        const order = [...ids, ...rest.map((i) => i.id)];
        for (let index = 0; index < order.length; index++) {
          await db
            .update(projectItems)
            .set({ orderIndex: index })
            .where(eq(projectItems.id, order[index]!));
        }
      }
      await touch(projectId, at);
    });
  }

  /* ------------------------------------------------------------- sections -- */

  async function addSection(projectId: string, title: string): Promise<ProjectSection> {
    const at = now();
    return atomically(async () => {
      await requireProject(projectId);
      const section = await ensureSection(projectId, title, at);
      await touch(projectId, at);
      return section;
    });
  }

  async function renameSection(sectionId: string, title: string): Promise<ProjectSection> {
    const trimmed = title.trim();
    if (!trimmed) throw new AppError('invalid_input', 'A section needs a title.');
    const at = now();
    return atomically(async () => {
      const section = await requireSection(sectionId);
      // Two sections normalising to one title would make "add that to Packing"
      // pick whichever came last, so a rename clash is refused like a name one.
      const key = normalise(trimmed);
      const clash = (await sectionsOf(section.projectId)).find(
        (s) => s.id !== sectionId && normalise(s.title) === key,
      );
      if (clash) {
        throw new AppError('conflict', `That project already has a "${clash.title}" section.`);
      }
      await db
        .update(projectSections)
        .set({ title: trimmed })
        .where(eq(projectSections.id, sectionId));
      await touch(section.projectId, at);
      return requireSection(sectionId);
    });
  }

  async function reorderSections(projectId: string, orderedIds: string[]): Promise<void> {
    if (orderedIds.length === 0) return;
    const at = now();
    await atomically(async () => {
      await requireProject(projectId);
      const all = await sectionsOf(projectId);
      const known = new Set(all.map((s) => s.id));
      for (const id of orderedIds) {
        if (!known.has(id)) {
          throw new AppError('invalid_input', 'That section is not in this project.');
        }
      }
      const pinned = new Set(orderedIds);
      const order = [...orderedIds, ...all.filter((s) => !pinned.has(s.id)).map((s) => s.id)];
      for (let index = 0; index < order.length; index++) {
        await db
          .update(projectSections)
          .set({ orderIndex: index })
          .where(eq(projectSections.id, order[index]!));
      }
      await touch(projectId, at);
    });
  }

  /** The FK nulls `section_id`; we re-index so the orphans land at the end. */
  async function deleteSection(sectionId: string): Promise<void> {
    const at = now();
    await atomically(async () => {
      const section = await requireSection(sectionId);
      const orphans = await db
        .select()
        .from(projectItems)
        .where(eq(projectItems.sectionId, sectionId))
        .orderBy(asc(projectItems.orderIndex), asc(projectItems.id));

      let cursor = (await maxItemOrder(section.projectId, null)) + 1;
      await db.delete(projectSections).where(eq(projectSections.id, sectionId));
      for (const orphan of orphans) {
        await db
          .update(projectItems)
          .set({ orderIndex: cursor++, updatedAt: at })
          .where(eq(projectItems.id, orphan.id));
      }
      await touch(section.projectId, at);
    });
  }

  /* ---------------------------------------------------------------- reads -- */

  async function getProject(projectId: string): Promise<Project | null> {
    return findProject(projectId);
  }

  async function listSections(projectId: string): Promise<ProjectSection[]> {
    return sectionsOf(projectId);
  }

  async function listItems(projectId: string): Promise<ProjectItem[]> {
    return db
      .select()
      .from(projectItems)
      .where(eq(projectItems.projectId, projectId))
      .orderBy(asc(projectItems.orderIndex), asc(projectItems.id));
  }

  async function listProjects(options: { status?: ProjectStatus } = {}): Promise<Project[]> {
    const query = db.select().from(projects);
    const rows = options.status
      ? await query.where(eq(projects.status, options.status)).orderBy(desc(projects.updatedAt))
      : await query.orderBy(STATUS_RANK, desc(projects.updatedAt));
    return rows;
  }

  async function getProjectOverview(projectId: string): Promise<ProjectOverview | null> {
    const project = await findProject(projectId);
    if (!project) return null;

    const sections = await sectionsOf(projectId);
    const items = await listItems(projectId);

    const grouped = new Map<string, ProjectItem[]>();
    for (const item of items) {
      const key = sectionKey(item.sectionId);
      grouped.set(key, [...(grouped.get(key) ?? []), item]);
    }

    const views: ProjectSectionView[] = [];
    const loose = grouped.get('') ?? [];
    if (loose.length > 0) views.push({ section: null, items: loose });
    for (const section of sections) {
      views.push({ section, items: grouped.get(section.id) ?? [] });
    }

    const counts: ProjectCounts = {
      total: items.length,
      done: items.filter((i) => i.isCompleted).length,
      // "Open todo" is anything actionable: an explicit todo or a checkbox.
      openTodos: items.filter((i) => !i.isCompleted && (i.kind === 'todo' || i.isCheckbox)).length,
    };

    const [linkedTasks, linkedNotes, linkedChecklists, linkedTransactions] = await Promise.all([
      db
        .select()
        .from(tasks)
        .where(eq(tasks.projectId, projectId))
        .orderBy(asc(tasks.isCompleted), asc(tasks.dueDate), asc(tasks.createdAt)),
      db
        .select()
        .from(notes)
        .where(eq(notes.projectId, projectId))
        .orderBy(desc(notes.isPinned), desc(notes.updatedAt)),
      db
        .select()
        .from(checklists)
        .where(eq(checklists.projectId, projectId))
        .orderBy(asc(checklists.orderIndex), asc(checklists.createdAt)),
      db
        .select()
        .from(transactions)
        .where(eq(transactions.projectId, projectId))
        .orderBy(desc(transactions.createdAt)),
    ]);

    return {
      project,
      sections: views,
      counts,
      linked: {
        tasks: linkedTasks,
        notes: linkedNotes,
        checklists: linkedChecklists,
        transactions: linkedTransactions,
      },
    };
  }

  /* -------------------------------------------------------------- project -- */

  async function updateProject(projectId: string, patch: ProjectPatch): Promise<Project> {
    const at = now();
    return atomically(async () => {
      await requireProject(projectId);
      const set: Partial<Project> = { updatedAt: at };
      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (!name) throw new AppError('invalid_input', 'A project needs a name.');
        const clash = await findByName(name);
        if (clash && clash.id !== projectId) {
          throw new AppError('conflict', `You already have a project called "${clash.name}".`);
        }
        set.name = name;
      }
      if (patch.kind !== undefined) set.kind = patch.kind;
      if (patch.description !== undefined) set.description = patch.description;
      if (patch.startDate !== undefined) set.startDate = patch.startDate;
      if (patch.targetDate !== undefined) set.targetDate = patch.targetDate;
      if (patch.emoji !== undefined) set.emoji = patch.emoji;
      if (patch.color !== undefined) set.color = patch.color;

      await db.update(projects).set(set).where(eq(projects.id, projectId));
      return requireProject(projectId);
    });
  }

  async function setStatus(projectId: string, status: ProjectStatus): Promise<Project> {
    const at = now();
    return atomically(async () => {
      await requireProject(projectId);
      await db.update(projects).set({ status, updatedAt: at }).where(eq(projects.id, projectId));
      return requireProject(projectId);
    });
  }

  async function archiveProject(projectId: string): Promise<Project> {
    return setStatus(projectId, 'archived');
  }

  /**
   * Cascades sections and items (FK), and nulls `project_id` on tasks, notes,
   * checklists, transactions and everything else that merely *references* the
   * project — deleting a container must never delete the user's real records.
   */
  async function deleteProject(projectId: string): Promise<void> {
    await atomically(async () => {
      await requireProject(projectId);
      await db.delete(projects).where(eq(projects.id, projectId));
    });
  }

  async function findProjectsByIds(ids: string[]): Promise<Project[]> {
    if (ids.length === 0) return [];
    return db.select().from(projects).where(inArray(projects.id, ids));
  }

  return {
    createProject,
    getOrCreateProject,
    updateProject,
    resolveProject,
    resolveItem,
    addItems,
    toggleItem,
    updateItem,
    moveItem,
    deleteItem,
    reorderItems,
    addSection,
    renameSection,
    reorderSections,
    deleteSection,
    getProject,
    getProjectOverview,
    listProjects,
    listSections,
    listItems,
    findProjectsByIds,
    setStatus,
    archiveProject,
    deleteProject,
  };
}

export type ProjectsRepository = ReturnType<typeof createProjectsRepository>;
