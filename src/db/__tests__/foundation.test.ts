import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testing';
import { LATEST_VERSION } from '../migrator';
import { newId, idTimestamp } from '../ids';
import { projects, projectItems, tasks, taskDependencies, notes, noteBullets } from '../schema';

describe('database foundation', () => {
  let t: TestDatabase;
  beforeEach(() => {
    t = createTestDatabase();
  });
  afterEach(() => t.close());

  it('migrates to the latest version with FTS available', () => {
    expect(t.report.to).toBe(LATEST_VERSION);
    expect(t.report.ftsAvailable).toBe(true);
    expect(t.report.skipped).toEqual([]);
  });

  it('is idempotent across reopen', () => {
    const before = t.client.getFirstSync<{ user_version: number }>('PRAGMA user_version', []);
    const again = createTestDatabase();
    expect(again.report.applied.length).toBeGreaterThan(0);
    expect(again.report.to).toBe(before?.user_version);
    again.close();
  });

  it('creates every declared table', () => {
    const rows = t.client.getAllSync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      [],
    );
    const names = new Set(rows.map((r) => r.name));
    for (const expected of [
      'curriculum_schedule',
      'projects',
      'project_sections',
      'project_items',
      'notes',
      'note_bullets',
      'habits',
      'activity_feed',
      'transactions',
      'checklists',
      'saved_places',
      'geofence_triggers',
      'crm_entities',
      'crm_commitments',
      'crm_interactions',
      'tasks',
      'task_dependencies',
      'calendar_events',
      'sync_queue',
      'focus_sessions',
      'app_settings',
      'llm_interactions',
      'notes_fts',
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });

  it('round-trips typed inserts and selects through Drizzle', async () => {
    const now = Date.now();
    const projectId = newId();
    await t.db
      .insert(projects)
      .values({ id: projectId, name: 'Vacation', kind: 'trip', createdAt: now, updatedAt: now });

    await t.db.insert(projectItems).values([
      {
        id: newId(),
        projectId,
        kind: 'todo',
        content: 'Pack slippers',
        isCheckbox: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: newId(),
        projectId,
        kind: 'idea',
        content: 'Visit the old town',
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const items = await t.db
      .select()
      .from(projectItems)
      .where(eq(projectItems.projectId, projectId));
    expect(items).toHaveLength(2);
    // booleans must survive the integer round-trip
    expect(items.find((i) => i.kind === 'todo')?.isCheckbox).toBe(true);
    expect(items.find((i) => i.kind === 'idea')?.isCheckbox).toBe(false);
  });

  it('maps duplicate column names correctly across joins', async () => {
    const now = Date.now();
    const a = newId();
    const b = newId();
    await t.db.insert(tasks).values([
      { id: a, title: 'Print frame', createdAt: now },
      { id: b, title: 'Assemble', createdAt: now, isLocked: true },
    ]);
    await t.db.insert(taskDependencies).values({ parentTaskId: a, childTaskId: b });

    const rows = await t.db
      .select({ dep: taskDependencies, parent: tasks })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.parentTaskId));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.parent.title).toBe('Print frame');
    expect(rows[0]!.dep.childTaskId).toBe(b);
  });

  it('enforces foreign keys and cascade deletes', async () => {
    const now = Date.now();
    const noteId = newId();
    await t.db
      .insert(notes)
      .values({ id: noteId, titleSummary: 'Robotics', categoryTag: 'hardware', createdAt: now, updatedAt: now });
    await t.db
      .insert(noteBullets)
      .values({ id: newId(), noteId, content: 'Use M3 screws', orderIndex: 0, createdAt: now });

    await t.db.delete(notes).where(eq(notes.id, noteId));
    const orphans = await t.db.select().from(noteBullets);
    expect(orphans).toHaveLength(0);
  });

  it('rejects rows violating CHECK constraints', () => {
    expect(() =>
      t.client.runSync(
        'INSERT INTO geofence_triggers (id,label,latitude,longitude,radius_meters,trigger_type,action_description) VALUES (?,?,?,?,?,?,?)',
        [newId(), 'Lab', 1, 1, 100, 'SIDEWAYS', 'nope'],
      ),
    ).toThrow();
  });

  it('generates sortable, unique, timestamped ids', () => {
    const ids = Array.from({ length: 500 }, () => newId());
    expect(new Set(ids).size).toBe(500);
    expect([...ids].sort()).toEqual(ids);
    const ts = idTimestamp(ids[0]!);
    expect(ts).not.toBeNull();
    expect(Math.abs(ts! - Date.now())).toBeLessThan(5_000);
  });
});
