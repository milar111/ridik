import { eq } from 'drizzle-orm';
import { freezeClock, resetClock } from '@/core/clock';
import { newId } from '@/db/ids';
import { checklists, notes, projectItems, projectSections, projects, tasks, transactions } from '@/db/schema';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import { createProjectsRepository, type ProjectsRepository } from '@/repositories/projects';

const BASE = Date.UTC(2026, 7, 11, 9, 0, 0);
const MINUTE = 60_000;

describe('projects repository', () => {
  let t: TestDatabase;
  let repo: ProjectsRepository;

  beforeEach(() => {
    freezeClock(BASE);
    t = createTestDatabase();
    repo = createProjectsRepository(t.db);
  });

  afterEach(() => {
    resetClock();
    t.close();
  });

  /** Moves the frozen clock forward so updated_at changes are observable. */
  const advance = (minutes: number) => freezeClock(BASE + minutes * MINUTE);

  /* ------------------------------------------------------------- creation - */

  it('creates a project with its sections and sane defaults', async () => {
    const project = await repo.createProject({
      name: 'Summer Vacation',
      kind: 'trip',
      description: 'Two weeks on the coast',
      emoji: '🏖️',
      sections: ['Packing', 'Ideas'],
    });

    expect(project.kind).toBe('trip');
    expect(project.status).toBe('active');
    expect(project.createdAt).toBe(BASE);
    expect(project.updatedAt).toBe(BASE);

    const sections = await repo.listSections(project.id);
    expect(sections.map((s) => s.title)).toEqual(['Packing', 'Ideas']);
    expect(sections.map((s) => s.orderIndex)).toEqual([0, 1]);
  });

  it('returns the existing project when the name matches case-insensitively', async () => {
    const first = await repo.createProject({ name: 'Vacation', kind: 'trip' });
    const again = await repo.createProject({ name: 'VACATION' });
    const viaVoice = await repo.getOrCreateProject('  vacation  ');

    expect(again.id).toBe(first.id);
    expect(viaVoice.id).toBe(first.id);
    // The second mention must not downgrade the kind established by the first.
    expect(viaVoice.kind).toBe('trip');

    const rows = await t.db.select().from(projects);
    expect(rows).toHaveLength(1);
  });

  it('fills gaps on an existing project without overwriting what is there', async () => {
    const first = await repo.createProject({
      name: 'Thesis',
      description: 'Original description',
      sections: ['Sources'],
    });

    advance(5);
    const merged = await repo.createProject({
      name: 'thesis',
      description: 'Something the model made up later',
      targetDate: BASE + 30 * 24 * 60 * MINUTE,
      emoji: '📚',
      sections: ['Sources', 'Chapters'],
    });

    expect(merged.id).toBe(first.id);
    expect(merged.description).toBe('Original description');
    expect(merged.emoji).toBe('📚');
    expect(merged.targetDate).toBe(BASE + 30 * 24 * 60 * MINUTE);
    expect(merged.updatedAt).toBe(BASE + 5 * MINUTE);

    const sections = await repo.listSections(first.id);
    expect(sections.map((s) => s.title)).toEqual(['Sources', 'Chapters']);
  });

  it('leaves updated_at alone when a repeated create changes nothing', async () => {
    const first = await repo.createProject({ name: 'Robotics' });
    advance(10);
    const again = await repo.getOrCreateProject('robotics');
    expect(again.updatedAt).toBe(first.updatedAt);
  });

  it('rejects a blank project name', async () => {
    await expect(repo.createProject({ name: '   ' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  /* ---------------------------------------------------------------- items - */

  it('creates sections on demand and numbers items per section', async () => {
    const project = await repo.createProject({ name: 'Vacation', kind: 'trip' });

    const created = await repo.addItems(project.id, [
      { content: 'Pack slippers', kind: 'todo', sectionTitle: 'Packing' },
      { content: 'Pack sunscreen', kind: 'todo', sectionTitle: 'Packing' },
      { content: 'Visit the old town', kind: 'idea', sectionTitle: 'Ideas' },
    ]);

    expect(created.map((i) => i.orderIndex)).toEqual([0, 1, 0]);
    expect(created[0]!.isCheckbox).toBe(true);
    expect(created[2]!.isCheckbox).toBe(false);

    const sections = await repo.listSections(project.id);
    expect(sections.map((s) => s.title)).toEqual(['Packing', 'Ideas']);

    // A later utterance continues the numbering rather than restarting it.
    const more = await repo.addItems(project.id, [
      { content: 'Pack a towel', kind: 'todo', sectionTitle: 'packing' },
    ]);
    expect(more[0]!.orderIndex).toBe(2);
    expect(more[0]!.sectionId).toBe(sections[0]!.id);
    expect(await repo.listSections(project.id)).toHaveLength(2);
  });

  it('numbers the un-sectioned bucket independently of the sections', async () => {
    const project = await repo.createProject({ name: 'Vacation' });
    const created = await repo.addItems(project.id, [
      { content: 'Loose thought', kind: 'note' },
      { content: 'Pack slippers', kind: 'todo', sectionTitle: 'Packing' },
      { content: 'Another loose thought', kind: 'note' },
    ]);

    expect(created.map((i) => [i.sectionId === null, i.orderIndex])).toEqual([
      [true, 0],
      [false, 0],
      [true, 1],
    ]);
  });

  it('reuses a section whose title differs only by case or punctuation', async () => {
    const project = await repo.createProject({ name: 'Vacation', sections: ['Packing'] });
    const same = await repo.addSection(project.id, 'packing!');
    expect(await repo.listSections(project.id)).toHaveLength(1);
    expect(same.title).toBe('Packing');
  });

  /* -------------------------------------------------------------- resolve - */

  it('resolves a project by fuzzy name', async () => {
    const trip = await repo.createProject({ name: 'Summer Vacation', kind: 'trip' });
    await repo.createProject({ name: 'Physics Coursework', kind: 'course' });

    const found = await repo.resolveProject('vacation');
    expect(found.ok).toBe(true);
    expect(found.ok && found.value.id).toBe(trip.id);
  });

  it('resolves a project through its section titles', async () => {
    const trip = await repo.createProject({ name: 'Trip', sections: ['Packing List'] });
    await repo.createProject({ name: 'Groceries' });

    const found = await repo.resolveProject('packing list');
    expect(found.ok && found.value.id).toBe(trip.id);
  });

  it('reports ambiguity instead of guessing between similar projects', async () => {
    await repo.createProject({ name: 'Math exam' });
    await repo.createProject({ name: 'Math notes' });

    const found = await repo.resolveProject('math');
    expect(found.ok).toBe(false);
    expect(!found.ok && found.error.code).toBe('ambiguous');
    expect(!found.ok && (found.error.details as unknown[]).length).toBe(2);
  });

  it('reports not_found for an unknown project', async () => {
    await repo.createProject({ name: 'Vacation' });
    const found = await repo.resolveProject('quantum gravity seminar');
    expect(!found.ok && found.error.code).toBe('not_found');
  });

  it('checks off an item found by fuzzy text across every project', async () => {
    const trip = await repo.createProject({ name: 'Vacation', kind: 'trip' });
    await repo.addItems(trip.id, [
      { content: 'Pack slippers', kind: 'todo', sectionTitle: 'Packing' },
      { content: 'Book museum tickets', kind: 'todo' },
    ]);
    const robotics = await repo.createProject({ name: 'Robotics' });
    await repo.addItems(robotics.id, [{ content: 'Order M3 screws', kind: 'todo' }]);

    const found = await repo.resolveItem({ query: 'slippers' });
    expect(found.ok).toBe(true);
    if (!found.ok) throw found.error;

    advance(3);
    const toggled = await repo.toggleItem(found.value.id, true);
    expect(toggled.isCompleted).toBe(true);
    expect(toggled.completedAt).toBe(BASE + 3 * MINUTE);

    const untoggled = await repo.toggleItem(found.value.id, false);
    expect(untoggled.isCompleted).toBe(false);
    expect(untoggled.completedAt).toBeNull();
  });

  it('scopes item resolution to one project when it is named', async () => {
    const trip = await repo.createProject({ name: 'Vacation' });
    await repo.addItems(trip.id, [{ content: 'Pack slippers', kind: 'todo' }]);
    const robotics = await repo.createProject({ name: 'Robotics' });
    await repo.addItems(robotics.id, [{ content: 'Order M3 screws', kind: 'todo' }]);

    const scoped = await repo.resolveItem({ projectId: trip.id, query: 'screws' });
    expect(!scoped.ok && scoped.error.code).toBe('not_found');

    const elsewhere = await repo.resolveItem({ projectId: robotics.id, query: 'screws' });
    expect(elsewhere.ok).toBe(true);
  });

  /* ----------------------------------------------------------- item edits - */

  it('reorders items inside a section and appends the ones left out', async () => {
    const project = await repo.createProject({ name: 'Vacation' });
    const [a, , c] = await repo.addItems(project.id, [
      { content: 'A', sectionTitle: 'Packing' },
      { content: 'B', sectionTitle: 'Packing' },
      { content: 'C', sectionTitle: 'Packing' },
      { content: 'D', sectionTitle: 'Packing' },
    ]);

    await repo.reorderItems(project.id, [c!.id, a!.id]);

    const items = await repo.listItems(project.id);
    expect(items.map((i) => i.content)).toEqual(['C', 'A', 'B', 'D']);
    expect(items.map((i) => i.orderIndex)).toEqual([0, 1, 2, 3]);
  });

  it('refuses to reorder an item that is not in the project', async () => {
    const a = await repo.createProject({ name: 'A' });
    const b = await repo.createProject({ name: 'B' });
    const [stray] = await repo.addItems(b.id, [{ content: 'Stray' }]);

    await expect(repo.reorderItems(a.id, [stray!.id])).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('moves an item into another section, appending it at the end', async () => {
    const project = await repo.createProject({ name: 'Vacation' });
    const [loose] = await repo.addItems(project.id, [{ content: 'Buy adapter' }]);
    await repo.addItems(project.id, [
      { content: 'Slippers', sectionTitle: 'Packing' },
      { content: 'Towel', sectionTitle: 'Packing' },
    ]);
    const [packing] = await repo.listSections(project.id);

    const moved = await repo.moveItem(loose!.id, packing!.id);
    expect(moved.sectionId).toBe(packing!.id);
    expect(moved.orderIndex).toBe(2);

    const back = await repo.moveItem(moved.id, null);
    expect(back.sectionId).toBeNull();
    expect(back.orderIndex).toBe(0);
  });

  it("refuses to move an item into another project's section", async () => {
    const a = await repo.createProject({ name: 'A', sections: ['Shared'] });
    const b = await repo.createProject({ name: 'B' });
    const [item] = await repo.addItems(b.id, [{ content: 'Item' }]);
    const [foreign] = await repo.listSections(a.id);

    await expect(repo.moveItem(item!.id, foreign!.id)).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('patches and deletes items', async () => {
    const project = await repo.createProject({ name: 'Vacation' });
    const [item] = await repo.addItems(project.id, [{ content: 'Slipers' }]);

    advance(2);
    const patched = await repo.updateItem(item!.id, {
      content: 'Slippers',
      kind: 'todo',
      isCheckbox: true,
      detail: 'the fluffy ones',
      isCompleted: true,
    });
    expect(patched.content).toBe('Slippers');
    expect(patched.completedAt).toBe(BASE + 2 * MINUTE);
    expect(patched.detail).toBe('the fluffy ones');

    await repo.deleteItem(item!.id);
    expect(await repo.listItems(project.id)).toHaveLength(0);
  });

  it('throws not_found for an unknown item id', async () => {
    await expect(repo.toggleItem(newId(), true)).rejects.toMatchObject({ code: 'not_found' });
  });

  /* ------------------------------------------------------------- sections - */

  it('keeps items when a section is deleted and appends them to the loose bucket', async () => {
    const project = await repo.createProject({ name: 'Vacation' });
    await repo.addItems(project.id, [{ content: 'Loose one' }]);
    await repo.addItems(project.id, [
      { content: 'Slippers', sectionTitle: 'Packing' },
      { content: 'Towel', sectionTitle: 'Packing' },
    ]);
    const [packing] = await repo.listSections(project.id);

    await repo.deleteSection(packing!.id);

    expect(await repo.listSections(project.id)).toHaveLength(0);
    const items = await repo.listItems(project.id);
    expect(items.every((i) => i.sectionId === null)).toBe(true);
    expect(items.map((i) => i.content)).toEqual(['Loose one', 'Slippers', 'Towel']);
    expect(items.map((i) => i.orderIndex)).toEqual([0, 1, 2]);
  });

  it('refuses to rename a section onto another section of the same project', async () => {
    const project = await repo.createProject({ name: 'Vacation', sections: ['Packing', 'Ideas'] });
    const sections = await repo.listSections(project.id);

    await expect(repo.renameSection(sections[1]!.id, 'packing!')).rejects.toMatchObject({
      code: 'conflict',
    });
    expect((await repo.listSections(project.id)).map((s) => s.title)).toEqual([
      'Packing',
      'Ideas',
    ]);

    // Re-casing a section's own title is not a clash with itself.
    const recased = await repo.renameSection(sections[0]!.id, 'packing');
    expect(recased.title).toBe('packing');
  });

  it('renames and reorders sections', async () => {
    const project = await repo.createProject({
      name: 'Vacation',
      sections: ['Packing', 'Ideas', 'Budget'],
    });
    const sections = await repo.listSections(project.id);

    const renamed = await repo.renameSection(sections[1]!.id, 'Things to see');
    expect(renamed.title).toBe('Things to see');

    await repo.reorderSections(project.id, [sections[2]!.id, sections[1]!.id]);
    expect((await repo.listSections(project.id)).map((s) => s.title)).toEqual([
      'Budget',
      'Things to see',
      'Packing',
    ]);
  });

  /* ------------------------------------------------------------- overview - */

  it('builds an overview with grouped sections, counts and linked records', async () => {
    const project = await repo.createProject({ name: 'Vacation', kind: 'trip' });
    await repo.addItems(project.id, [
      { content: 'Slippers', kind: 'todo', sectionTitle: 'Packing' },
      { content: 'Passport', kind: 'todo', sectionTitle: 'Packing' },
      { content: 'Visit the old town', kind: 'idea', sectionTitle: 'Ideas' },
      { content: 'Budget is 500 EUR', kind: 'note' },
    ]);

    const slippers = await repo.resolveItem({ projectId: project.id, query: 'slippers' });
    if (!slippers.ok) throw slippers.error;
    await repo.toggleItem(slippers.value.id, true);

    await t.db.insert(tasks).values({
      id: newId(),
      title: 'Renew passport',
      projectId: project.id,
      createdAt: BASE,
    });
    await t.db.insert(notes).values({
      id: newId(),
      titleSummary: 'Beach shortlist',
      categoryTag: 'travel',
      projectId: project.id,
      createdAt: BASE,
      updatedAt: BASE,
    });
    await t.db.insert(checklists).values({
      id: newId(),
      listName: 'Pharmacy',
      itemText: 'Sunscreen',
      projectId: project.id,
      createdAt: BASE,
    });
    await t.db.insert(transactions).values({
      id: newId(),
      amount: 240,
      currency: 'EUR',
      category: 'travel',
      projectId: project.id,
      createdAt: BASE,
    });

    const overview = await repo.getProjectOverview(project.id);
    if (!overview) throw new Error('expected an overview');

    expect(overview.project.id).toBe(project.id);
    expect(overview.sections.map((s) => s.section?.title ?? null)).toEqual([
      null,
      'Packing',
      'Ideas',
    ]);
    expect(overview.sections[0]!.items.map((i) => i.content)).toEqual(['Budget is 500 EUR']);
    expect(overview.sections[1]!.items.map((i) => i.content)).toEqual(['Slippers', 'Passport']);

    expect(overview.counts).toEqual({ total: 4, done: 1, openTodos: 1 });

    expect(overview.linked.tasks.map((r) => r.title)).toEqual(['Renew passport']);
    expect(overview.linked.notes.map((r) => r.titleSummary)).toEqual(['Beach shortlist']);
    expect(overview.linked.checklists.map((r) => r.itemText)).toEqual(['Sunscreen']);
    expect(overview.linked.transactions.map((r) => r.amount)).toEqual([240]);
  });

  it('returns null for the overview of a project that does not exist', async () => {
    expect(await repo.getProjectOverview(newId())).toBeNull();
  });

  /* ------------------------------------------------------------ lifecycle - */

  it('lists projects by status rank, then by recency', async () => {
    const older = await repo.createProject({ name: 'Older active' });
    advance(1);
    const newer = await repo.createProject({ name: 'Newer active' });
    advance(2);
    const paused = await repo.createProject({ name: 'Paused one' });
    advance(3);
    const archived = await repo.createProject({ name: 'Archived one' });

    advance(4);
    await repo.setStatus(paused.id, 'paused');
    advance(5);
    await repo.archiveProject(archived.id);

    const all = await repo.listProjects();
    expect(all.map((p) => p.id)).toEqual([newer.id, older.id, paused.id, archived.id]);

    const actives = await repo.listProjects({ status: 'active' });
    expect(actives.map((p) => p.id)).toEqual([newer.id, older.id]);
  });

  it('bumps the project updated_at on every mutation', async () => {
    const project = await repo.createProject({ name: 'Vacation' });
    expect(project.updatedAt).toBe(BASE);

    advance(1);
    const [item] = await repo.addItems(project.id, [{ content: 'Slippers', kind: 'todo' }]);
    expect((await repo.getProject(project.id))!.updatedAt).toBe(BASE + MINUTE);

    advance(2);
    await repo.toggleItem(item!.id, true);
    expect((await repo.getProject(project.id))!.updatedAt).toBe(BASE + 2 * MINUTE);

    advance(3);
    await repo.addSection(project.id, 'Packing');
    expect((await repo.getProject(project.id))!.updatedAt).toBe(BASE + 3 * MINUTE);

    advance(4);
    await repo.updateItem(item!.id, { detail: 'fluffy' });
    expect((await repo.getProject(project.id))!.updatedAt).toBe(BASE + 4 * MINUTE);

    advance(5);
    await repo.deleteItem(item!.id);
    expect((await repo.getProject(project.id))!.updatedAt).toBe(BASE + 5 * MINUTE);
  });

  it('renames a project but refuses to collide with an existing name', async () => {
    const a = await repo.createProject({ name: 'Alpha' });
    await repo.createProject({ name: 'Beta' });

    const renamed = await repo.updateProject(a.id, { name: 'Alpha Prime' });
    expect(renamed.name).toBe('Alpha Prime');

    await expect(repo.updateProject(a.id, { name: 'beta' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('cascades items and sections on delete but only nulls project_id elsewhere', async () => {
    const project = await repo.createProject({ name: 'Vacation', sections: ['Packing'] });
    await repo.addItems(project.id, [{ content: 'Slippers', sectionTitle: 'Packing' }]);

    const taskId = newId();
    const noteId = newId();
    const checklistId = newId();
    const txId = newId();
    await t.db.insert(tasks).values({ id: taskId, title: 'Renew passport', projectId: project.id, createdAt: BASE });
    await t.db.insert(notes).values({
      id: noteId,
      titleSummary: 'Beach shortlist',
      categoryTag: 'travel',
      projectId: project.id,
      createdAt: BASE,
      updatedAt: BASE,
    });
    await t.db.insert(checklists).values({
      id: checklistId,
      listName: 'Pharmacy',
      itemText: 'Sunscreen',
      projectId: project.id,
      createdAt: BASE,
    });
    await t.db.insert(transactions).values({
      id: txId,
      amount: 240,
      currency: 'EUR',
      category: 'travel',
      projectId: project.id,
      createdAt: BASE,
    });

    await repo.deleteProject(project.id);

    expect(await t.db.select().from(projects)).toHaveLength(0);
    expect(await t.db.select().from(projectItems)).toHaveLength(0);
    expect(await t.db.select().from(projectSections)).toHaveLength(0);

    const survivingTask = await t.db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(survivingTask[0]?.projectId).toBeNull();
    const survivingNote = await t.db.select().from(notes).where(eq(notes.id, noteId));
    expect(survivingNote[0]?.projectId).toBeNull();
    const survivingChecklist = await t.db
      .select()
      .from(checklists)
      .where(eq(checklists.id, checklistId));
    expect(survivingChecklist[0]?.projectId).toBeNull();
    const survivingTx = await t.db.select().from(transactions).where(eq(transactions.id, txId));
    expect(survivingTx[0]?.projectId).toBeNull();
  });

  it('throws not_found rather than reporting success for an unknown project id', async () => {
    await expect(repo.deleteProject(newId())).rejects.toMatchObject({ code: 'not_found' });
  });

  it('treats a blank description as a gap a later mention can fill', async () => {
    await repo.createProject({ name: 'Thesis', description: '' });
    const merged = await repo.createProject({ name: 'thesis', description: 'On tidal locking' });
    expect(merged.description).toBe('On tidal locking');
  });

  it('rolls back a failed batch of items entirely', async () => {
    const project = await repo.createProject({ name: 'Vacation' });
    await expect(
      repo.addItems(project.id, [
        { content: 'Good one', sectionTitle: 'Packing' },
        { content: '   ' },
      ]),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    expect(await repo.listItems(project.id)).toHaveLength(0);
    expect(await repo.listSections(project.id)).toHaveLength(0);
  });
});
