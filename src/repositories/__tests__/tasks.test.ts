import { freezeClock } from '@/core/clock';
import type { AppError, Result } from '@/core/result';
import { epochToLocal, localToEpoch, setZoneOverride } from '@/core/time';
import { newId } from '@/db/ids';
import { projects } from '@/db/schema';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import {
  createTasksRepository,
  wouldCreateCycle,
  type DependencyEdge,
  type TasksRepository,
} from '../tasks';

const ZONE = 'Europe/Sofia';
/** A Tuesday, so "next Friday" is unambiguous. */
const TUESDAY_09_00 = localToEpoch('2026-08-11T09:00', ZONE);
const NEXT_FRIDAY = localToEpoch('2026-08-14T18:00', ZONE);

function expectOk<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}: ${result.error.userMessage}`);
  }
  return result.value;
}

function expectErr<T>(result: Result<T>): AppError {
  if (result.ok) throw new Error(`expected an error, got ${JSON.stringify(result.value)}`);
  return result.error;
}

const edge = (parentTaskId: string, childTaskId: string): DependencyEdge => ({
  parentTaskId,
  childTaskId,
});

describe('wouldCreateCycle', () => {
  it('accepts the first edge of an empty graph', () => {
    expect(wouldCreateCycle([], 'a', 'b')).toBe(false);
  });

  it('rejects a self-dependency', () => {
    expect(wouldCreateCycle([], 'a', 'a')).toBe(true);
  });

  it('rejects the reverse of an existing edge', () => {
    expect(wouldCreateCycle([edge('a', 'b')], 'b', 'a')).toBe(true);
  });

  it('rejects a transitive loop a -> b -> c -> a', () => {
    expect(wouldCreateCycle([edge('a', 'b'), edge('b', 'c')], 'c', 'a')).toBe(true);
  });

  it('allows a diamond, which is not a cycle', () => {
    const edges = [edge('a', 'b'), edge('a', 'c'), edge('b', 'd')];
    expect(wouldCreateCycle(edges, 'c', 'd')).toBe(false);
  });

  it('allows an edge between two unrelated components', () => {
    expect(wouldCreateCycle([edge('a', 'b'), edge('c', 'd')], 'b', 'c')).toBe(false);
  });

  it('terminates on input that is already cyclic', () => {
    const edges = [edge('a', 'b'), edge('b', 'a'), edge('a', 'c')];
    // Walking out of the loop still has to reach `c` and stop.
    expect(wouldCreateCycle(edges, 'c', 'b')).toBe(true);
    expect(wouldCreateCycle(edges, 'z', 'a')).toBe(false);
  });
});

describe('tasks repository', () => {
  let t: TestDatabase;
  let repo: TasksRepository;
  let restoreClock: () => void;

  beforeEach(() => {
    setZoneOverride(ZONE);
    restoreClock = freezeClock(TUESDAY_09_00);
    t = createTestDatabase();
    repo = createTasksRepository(t.db);
  });

  afterEach(() => {
    restoreClock();
    setZoneOverride(null);
    t.close();
  });

  /** Moves the frozen clock forward; the afterEach restore still wins. */
  const advanceMinutes = (minutes: number) => freezeClock(TUESDAY_09_00 + minutes * 60_000);

  /* ------------------------------------------------------------ createTask -- */

  describe('createTask', () => {
    it('creates an unlocked, incomplete task with sane defaults', async () => {
      const task = await repo.createTask({ title: '  Water the plants  ' });
      expect(task.title).toBe('Water the plants');
      expect(task.isCompleted).toBe(false);
      expect(task.isLocked).toBe(false);
      expect(task.priority).toBe(2);
      expect(task.source).toBe('voice');
      expect(task.createdAt).toBe(TUESDAY_09_00);
      expect(task.updatedAt).toBe(TUESDAY_09_00);
      expect(task.completedAt).toBeNull();
      expect(task.unlockedAt).toBeNull();
    });

    it('persists every optional field', async () => {
      const projectId = newId();
      await t.db
        .insert(projects)
        .values({ id: projectId, name: 'Robot Arm', createdAt: TUESDAY_09_00, updatedAt: TUESDAY_09_00 });

      const task = await repo.createTask({
        title: 'Order the servos',
        dueDate: NEXT_FRIDAY,
        notes: 'MG996R, six of them',
        projectId,
        priority: 1,
        estimatedMinutes: 20,
        source: 'manual',
      });

      const stored = await repo.getTask(task.id);
      expect(stored).toEqual(task);
      expect(stored?.dueDate).toBe(NEXT_FRIDAY);
      expect(stored?.notes).toBe('MG996R, six of them');
      expect(stored?.projectId).toBe(projectId);
      expect(stored?.priority).toBe(1);
      expect(stored?.estimatedMinutes).toBe(20);
      expect(stored?.source).toBe('manual');
    });

    it('refuses a blank title and an out-of-range priority', async () => {
      await expect(repo.createTask({ title: '   ' })).rejects.toMatchObject({
        code: 'invalid_input',
      });
      await expect(repo.createTask({ title: 'Nope', priority: 9 })).rejects.toMatchObject({
        code: 'invalid_input',
      });
    });
  });

  /* --------------------------------------------------------- spec scenario -- */

  describe('the robot chain (spec scenario)', () => {
    it('locks the assembly behind both prerequisites and unlocks it on the last one', async () => {
      expect(epochToLocal(NEXT_FRIDAY, ZONE).weekdayLong).toBe('Friday');

      const frame = await repo.createTask({ title: '3D print the frame' });
      const servos = await repo.createTask({ title: 'Order the servos' });

      const linked = expectOk(
        await repo.addDependencyByTitles({
          childTitle: 'Assemble the robot',
          parentTitles: ['3D print the frame', 'order the servos'],
          childDue: NEXT_FRIDAY,
        }),
      );

      // The child did not exist, so it was created; the parents were matched.
      expect(linked.created.map((c) => c.title)).toEqual(['Assemble the robot']);
      expect(linked.parents.map((p) => p.id).sort()).toEqual([frame.id, servos.id].sort());

      const assembly = linked.child;
      expect(assembly.isLocked).toBe(true);
      expect(assembly.dueDate).toBe(NEXT_FRIDAY);
      expect(await repo.getBlockers(assembly.id)).toHaveLength(2);
      expect((await repo.getDependents(frame.id)).map((d) => d.id)).toEqual([assembly.id]);

      // The daily list shows the two doable things, never the blocked one.
      expect((await repo.listActiveTasks()).map((x) => x.title)).toEqual([
        '3D print the frame',
        'Order the servos',
      ]);

      const first = expectOk(await repo.completeTask(frame.id));
      expect(first.task.isCompleted).toBe(true);
      expect(first.task.completedAt).toBe(TUESDAY_09_00);
      expect(first.unlocked).toEqual([]);
      expect((await repo.getTask(assembly.id))?.isLocked).toBe(true);

      advanceMinutes(30);
      const second = expectOk(await repo.completeTask(servos.id));
      expect(second.unlocked.map((u) => u.title)).toEqual(['Assemble the robot']);
      expect(second.unlocked[0]!.isLocked).toBe(false);
      expect(second.unlocked[0]!.unlockedAt).toBe(TUESDAY_09_00 + 30 * 60_000);

      expect((await repo.listActiveTasks()).map((x) => x.title)).toEqual(['Assemble the robot']);
    });

    it('reuses an existing task when the spoken title is close enough', async () => {
      const servos = await repo.createTask({ title: 'Order the servos' });
      const linked = expectOk(
        await repo.addDependencyByTitles({
          childTitle: 'Assemble the robot',
          parentTitles: ['order the servoss'],
        }),
      );
      expect(linked.created).toHaveLength(1); // only the child
      expect(linked.parents.map((p) => p.id)).toEqual([servos.id]);
    });

    it('creates a new task rather than guessing at a weak match', async () => {
      await repo.createTask({ title: 'Cut the aluminium' });
      const linked = expectOk(
        await repo.addDependencyByTitles({
          childTitle: 'Design the bracket',
          parentTitles: ['Order the aluminium sheet'],
        }),
      );
      expect(linked.created.map((c) => c.title).sort()).toEqual([
        'Design the bracket',
        'Order the aluminium sheet',
      ]);
      expect(linked.parents[0]!.isLocked).toBe(false);
    });

    it('asks instead of picking when the spoken title is ambiguous', async () => {
      await repo.createTask({ title: 'Email Ivo about the lab' });
      await repo.createTask({ title: 'Email Ivo about the trip' });

      const error = expectErr(
        await repo.addDependencyByTitles({
          childTitle: 'Ship the prototype',
          parentTitles: ['Email Ivo about'],
        }),
      );
      expect(error.code).toBe('ambiguous');
      // Nothing was written, not even the child that would have been created.
      expect(await repo.listTasks()).toHaveLength(2);
    });

    it('adopts the spoken due date and project on a task that already exists', async () => {
      const projectId = newId();
      await t.db
        .insert(projects)
        .values({ id: projectId, name: 'Robot Arm', createdAt: TUESDAY_09_00, updatedAt: TUESDAY_09_00 });
      const assembly = await repo.createTask({ title: 'Assemble the robot' });
      expect(assembly.dueDate).toBeNull();

      const linked = expectOk(
        await repo.addDependencyByTitles({
          childTitle: 'Assemble the robot',
          parentTitles: ['Order the servos'],
          childDue: NEXT_FRIDAY,
          projectId,
        }),
      );
      expect(linked.child.id).toBe(assembly.id);
      expect(linked.child.dueDate).toBe(NEXT_FRIDAY);
      expect(linked.child.projectId).toBe(projectId);
    });
  });

  /* ------------------------------------------------------------ cycle guard -- */

  describe('cycle rejection', () => {
    it('rejects a task depending on itself', async () => {
      const a = await repo.createTask({ title: 'Design the bracket' });
      const error = expectErr(await repo.addDependencies({ childId: a.id, parentIds: [a.id] }));
      expect(error.code).toBe('cycle');
      expect(error.userMessage).toContain('itself');
      expect((await repo.getGraph()).edges).toEqual([]);
    });

    it('rejects a direct two-task loop', async () => {
      const a = await repo.createTask({ title: 'Design the bracket' });
      const b = await repo.createTask({ title: 'Cut the aluminium' });
      expectOk(await repo.addDependencies({ childId: b.id, parentIds: [a.id] }));

      const error = expectErr(await repo.addDependencies({ childId: a.id, parentIds: [b.id] }));
      expect(error.code).toBe('cycle');
      expect((await repo.getGraph()).edges).toEqual([edge(a.id, b.id)]);
      expect((await repo.getTask(a.id))?.isLocked).toBe(false);
    });

    it('rejects a transitive loop a -> b -> c -> a', async () => {
      const a = await repo.createTask({ title: 'Design the bracket' });
      const b = await repo.createTask({ title: 'Cut the aluminium' });
      const c = await repo.createTask({ title: 'Weld the joints' });
      expectOk(await repo.addDependencies({ childId: b.id, parentIds: [a.id] }));
      expectOk(await repo.addDependencies({ childId: c.id, parentIds: [b.id] }));

      const error = expectErr(await repo.addDependencies({ childId: a.id, parentIds: [c.id] }));
      expect(error.code).toBe('cycle');
      expect((await repo.getGraph()).edges).toHaveLength(2);
    });

    it('rejects a loop formed by two edges added in the same batch', async () => {
      const a = await repo.createTask({ title: 'Design the bracket' });
      const b = await repo.createTask({ title: 'Cut the aluminium' });
      expectOk(await repo.addDependencies({ childId: b.id, parentIds: [a.id] }));

      // b -> a closes the loop; a -> a is a self edge. Neither may land.
      const error = expectErr(
        await repo.addDependencies({ childId: a.id, parentIds: [b.id, a.id] }),
      );
      expect(error.code).toBe('cycle');
      expect((await repo.getGraph()).edges).toHaveLength(1);
    });

    it('rolls back tasks created earlier in a rejected voice command', async () => {
      const a = await repo.createTask({ title: 'Design the bracket' });
      const b = await repo.createTask({ title: 'Cut the aluminium' });
      expectOk(await repo.addDependencies({ childId: b.id, parentIds: [a.id] }));

      const error = expectErr(
        await repo.addDependencyByTitles({
          childTitle: 'Design the bracket',
          parentTitles: ['Order the aluminium sheet', 'Cut the aluminium'],
        }),
      );
      expect(error.code).toBe('cycle');
      expect((await repo.listTasks()).map((x) => x.title).sort()).toEqual([
        'Cut the aluminium',
        'Design the bracket',
      ]);
      expect((await repo.getGraph()).edges).toEqual([edge(a.id, b.id)]);
    });

    it('allows a diamond', async () => {
      const a = await repo.createTask({ title: 'Design the bracket' });
      const b = await repo.createTask({ title: 'Cut the aluminium' });
      const c = await repo.createTask({ title: 'Print the spacer' });
      const d = await repo.createTask({ title: 'Weld the joints' });
      expectOk(await repo.addDependencies({ childId: b.id, parentIds: [a.id] }));
      expectOk(await repo.addDependencies({ childId: c.id, parentIds: [a.id] }));
      expectOk(await repo.addDependencies({ childId: d.id, parentIds: [b.id, c.id] }));
      expect((await repo.getGraph()).edges).toHaveLength(4);
    });
  });

  /* ------------------------------------------------------------ lock state -- */

  describe('lock state', () => {
    it('locks a task the moment an incomplete prerequisite is attached', async () => {
      const parent = await repo.createTask({ title: 'Buy the paint' });
      const child = await repo.createTask({ title: 'Paint the shelf' });
      expect(child.isLocked).toBe(false);

      const linked = expectOk(await repo.addDependencies({ childId: child.id, parentIds: [parent.id] }));
      expect(linked.child.isLocked).toBe(true);
      expect(linked.child.unlockedAt).toBeNull();
    });

    it('does not lock behind an already completed prerequisite', async () => {
      const parent = await repo.createTask({ title: 'Buy the paint' });
      expectOk(await repo.completeTask(parent.id));
      const child = await repo.createTask({ title: 'Paint the shelf' });

      const linked = expectOk(await repo.addDependencies({ childId: child.id, parentIds: [parent.id] }));
      expect(linked.child.isLocked).toBe(false);
    });

    it('unlocks when the last dependency is removed', async () => {
      const parent = await repo.createTask({ title: 'Buy the paint' });
      const child = await repo.createTask({ title: 'Paint the shelf' });
      expectOk(await repo.addDependencies({ childId: child.id, parentIds: [parent.id] }));

      advanceMinutes(5);
      const removed = expectOk(await repo.removeDependency({ parentId: parent.id, childId: child.id }));
      expect(removed.removed).toBe(true);
      expect(removed.child.isLocked).toBe(false);
      expect(removed.child.unlockedAt).toBe(TUESDAY_09_00 + 5 * 60_000);

      const again = expectOk(await repo.removeDependency({ parentId: parent.id, childId: child.id }));
      expect(again.removed).toBe(false);
    });

    it('re-locks children when a completed prerequisite is undone', async () => {
      const parent = await repo.createTask({ title: 'Buy the paint' });
      const child = await repo.createTask({ title: 'Paint the shelf' });
      expectOk(await repo.addDependencies({ childId: child.id, parentIds: [parent.id] }));
      expectOk(await repo.completeTask(parent.id));
      expect((await repo.getTask(child.id))?.isLocked).toBe(false);

      const undone = expectOk(await repo.uncompleteTask(parent.id));
      expect(undone.task.isCompleted).toBe(false);
      expect(undone.task.completedAt).toBeNull();
      expect(undone.relocked.map((r) => r.id)).toEqual([child.id]);
      const relocked = await repo.getTask(child.id);
      expect(relocked?.isLocked).toBe(true);
      expect(relocked?.unlockedAt).toBeNull();
    });

    it('keeps a child locked while any other prerequisite is outstanding', async () => {
      const one = await repo.createTask({ title: 'Buy the paint' });
      const two = await repo.createTask({ title: 'Sand the shelf' });
      const child = await repo.createTask({ title: 'Paint the shelf' });
      expectOk(await repo.addDependencies({ childId: child.id, parentIds: [one.id, two.id] }));

      expectOk(await repo.completeTask(one.id));
      expect((await repo.getTask(child.id))?.isLocked).toBe(true);
      expectOk(await repo.completeTask(two.id));
      expect((await repo.getTask(child.id))?.isLocked).toBe(false);

      // Undoing either one is enough to block it again.
      const undone = expectOk(await repo.uncompleteTask(one.id));
      expect(undone.relocked.map((r) => r.id)).toEqual([child.id]);
    });

    it('unlocks the ex-children of a deleted parent', async () => {
      const parent = await repo.createTask({ title: 'Buy the paint' });
      const child = await repo.createTask({ title: 'Paint the shelf' });
      expectOk(await repo.addDependencies({ childId: child.id, parentIds: [parent.id] }));

      advanceMinutes(10);
      const deleted = expectOk(await repo.deleteTask(parent.id));
      expect(deleted.task.id).toBe(parent.id);
      expect(deleted.unlocked.map((u) => u.id)).toEqual([child.id]);
      expect(await repo.getTask(parent.id)).toBeNull();

      const survivor = await repo.getTask(child.id);
      expect(survivor?.isLocked).toBe(false);
      expect(survivor?.unlockedAt).toBe(TUESDAY_09_00 + 10 * 60_000);
      expect((await repo.getGraph()).edges).toEqual([]);
    });

    it('keeps a child locked when only one of its parents is deleted', async () => {
      const one = await repo.createTask({ title: 'Buy the paint' });
      const two = await repo.createTask({ title: 'Sand the shelf' });
      const child = await repo.createTask({ title: 'Paint the shelf' });
      expectOk(await repo.addDependencies({ childId: child.id, parentIds: [one.id, two.id] }));

      const deleted = expectOk(await repo.deleteTask(one.id));
      expect(deleted.unlocked).toEqual([]);
      expect((await repo.getTask(child.id))?.isLocked).toBe(true);
    });

    it('recomputes a lock flag that drifted out of band', async () => {
      const orphan = await repo.createTask({ title: 'Water the plants' });
      t.client.runSync('UPDATE tasks SET is_locked = 1 WHERE id = ?', [orphan.id]);
      expect((await repo.getTask(orphan.id))?.isLocked).toBe(true);

      const repaired = await repo.recomputeLockState(orphan.id);
      expect(repaired.isLocked).toBe(false);
    });

    it('throws when asked to recompute a task that is gone', async () => {
      await expect(repo.recomputeLockState('nope')).rejects.toMatchObject({ code: 'not_found' });
    });
  });

  /* ------------------------------------------------------------- listings -- */

  describe('listings', () => {
    it('hides locked tasks from the active list unless asked', async () => {
      const parent = await repo.createTask({ title: 'Buy the paint' });
      const child = await repo.createTask({ title: 'Paint the shelf' });
      expectOk(await repo.addDependencies({ childId: child.id, parentIds: [parent.id] }));

      expect((await repo.listActiveTasks()).map((x) => x.id)).toEqual([parent.id]);
      expect((await repo.listActiveTasks({ includeLocked: true })).map((x) => x.id).sort()).toEqual(
        [parent.id, child.id].sort(),
      );
    });

    it('drops completed tasks from the active list', async () => {
      const a = await repo.createTask({ title: 'Water the plants' });
      await repo.createTask({ title: 'Sand the shelf' });
      expectOk(await repo.completeTask(a.id));
      expect((await repo.listActiveTasks()).map((x) => x.title)).toEqual(['Sand the shelf']);
    });

    it('orders by due date with undated work last, then priority', async () => {
      const undated = await repo.createTask({ title: 'Someday: build a kiln' });
      const friday = await repo.createTask({ title: 'Hand in the essay', dueDate: NEXT_FRIDAY });
      const today = await repo.createTask({
        title: 'Call the dentist',
        dueDate: TUESDAY_09_00 + 3_600_000,
      });
      const alsoUndatedButUrgent = await repo.createTask({ title: 'Reply to Ivo', priority: 1 });

      expect((await repo.listActiveTasks()).map((x) => x.id)).toEqual([
        today.id,
        friday.id,
        alsoUndatedButUrgent.id,
        undated.id,
      ]);
      expect((await repo.listActiveTasks({ limit: 1 })).map((x) => x.id)).toEqual([today.id]);
    });

    it('filters by project, completion and due date', async () => {
      const projectId = newId();
      await t.db
        .insert(projects)
        .values({ id: projectId, name: 'Robot Arm', createdAt: TUESDAY_09_00, updatedAt: TUESDAY_09_00 });

      const inProject = await repo.createTask({ title: 'Order the servos', projectId });
      const done = await repo.createTask({ title: 'Water the plants' });
      const later = await repo.createTask({ title: 'Hand in the essay', dueDate: NEXT_FRIDAY });
      expectOk(await repo.completeTask(done.id));

      expect((await repo.listTasks({ projectId })).map((x) => x.id)).toEqual([inProject.id]);
      expect((await repo.listTasks({ completed: true })).map((x) => x.id)).toEqual([done.id]);
      expect((await repo.listTasks({ completed: false })).map((x) => x.id).sort()).toEqual(
        [inProject.id, later.id].sort(),
      );
      expect((await repo.listTasks({ dueBefore: NEXT_FRIDAY })).map((x) => x.id)).toEqual([]);
      expect((await repo.listTasks({ dueBefore: NEXT_FRIDAY + 1 })).map((x) => x.id)).toEqual([
        later.id,
      ]);
      expect(await repo.listTasks()).toHaveLength(3);
    });

    it('returns the whole graph for the UI view', async () => {
      const a = await repo.createTask({ title: 'Design the bracket' });
      const b = await repo.createTask({ title: 'Cut the aluminium' });
      expectOk(await repo.addDependencies({ childId: b.id, parentIds: [a.id] }));

      const graph = await repo.getGraph();
      expect(graph.nodes.map((n) => n.id)).toEqual([a.id, b.id]);
      expect(graph.edges).toEqual([edge(a.id, b.id)]);
    });
  });

  /* ---------------------------------------------------------- resolveTask -- */

  describe('resolveTask', () => {
    it('matches a mis-transcribed title', async () => {
      await repo.createTask({ title: '3D print the frame' });
      const assembly = await repo.createTask({ title: 'Assemble the robot arm' });

      const found = expectOk(await repo.resolveTask('assmble robot'));
      expect(found.id).toBe(assembly.id);
    });

    it('matches on notes and on the project name', async () => {
      const projectId = newId();
      await t.db
        .insert(projects)
        .values({ id: projectId, name: 'Robot Arm', createdAt: TUESDAY_09_00, updatedAt: TUESDAY_09_00 });
      const servos = await repo.createTask({ title: 'Order the servos', projectId });
      const parcel = await repo.createTask({
        title: 'Pick up the parcel',
        notes: 'DHL depot on Tsarigradsko',
      });

      expect(expectOk(await repo.resolveTask('robot arm')).id).toBe(servos.id);
      expect(expectOk(await repo.resolveTask('dhl depot')).id).toBe(parcel.id);
    });

    it('asks rather than guessing between two near-identical candidates', async () => {
      await repo.createTask({ title: 'Email Ivo about the lab' });
      await repo.createTask({ title: 'Email Ivo about the trip' });

      const error = expectErr(await repo.resolveTask('email Ivo about'));
      expect(error.code).toBe('ambiguous');
      expect((error.details as { titles: string[] }).titles).toHaveLength(2);
    });

    it('ranks the sooner-due task first when scores are close', async () => {
      await repo.createTask({ title: 'Fix the bike chain' });
      await repo.createTask({ title: 'Fix the bike brakes', dueDate: TUESDAY_09_00 + 3_600_000 });

      const error = expectErr(await repo.resolveTask('fix the bike'));
      expect(error.code).toBe('ambiguous');
      // "chain" is the shorter, better textual match; urgency puts "brakes" on top.
      expect((error.details as { titles: string[] }).titles[0]).toBe('Fix the bike brakes');
    });

    it('reports nothing found and refuses an empty query', async () => {
      await repo.createTask({ title: 'Water the plants' });
      expect(expectErr(await repo.resolveTask('quantum tunnelling')).code).toBe('not_found');
      expect(expectErr(await repo.resolveTask('   ')).code).toBe('invalid_input');
    });

    it('can exclude finished work and scope to a project', async () => {
      const projectId = newId();
      await t.db
        .insert(projects)
        .values({ id: projectId, name: 'Robot Arm', createdAt: TUESDAY_09_00, updatedAt: TUESDAY_09_00 });
      const done = await repo.createTask({ title: 'Water the plants' });
      const open = await repo.createTask({ title: 'Order the servos', projectId });
      expectOk(await repo.completeTask(done.id));

      expect(expectOk(await repo.resolveTask('water the plants')).id).toBe(done.id);
      expect(
        expectErr(await repo.resolveTask('water the plants', { includeCompleted: false })).code,
      ).toBe('not_found');
      expect(expectOk(await repo.resolveTask('order the servos', { projectId })).id).toBe(open.id);
    });
  });

  /* --------------------------------------------------------------- guards -- */

  describe('guards and idempotency', () => {
    it('reports missing ids instead of writing half a chain', async () => {
      const child = await repo.createTask({ title: 'Paint the shelf' });
      const error = expectErr(
        await repo.addDependencies({ childId: child.id, parentIds: ['ghost'] }),
      );
      expect(error.code).toBe('not_found');
      expect((error.details as { missing: string[] }).missing).toEqual(['ghost']);
      expect((await repo.getTask(child.id))?.isLocked).toBe(false);

      expect(
        expectErr(await repo.addDependencies({ childId: 'ghost', parentIds: [child.id] })).code,
      ).toBe('not_found');
      expect(expectErr(await repo.completeTask('ghost')).code).toBe('not_found');
      expect(expectErr(await repo.deleteTask('ghost')).code).toBe('not_found');
    });

    it('rejects an empty prerequisite list', async () => {
      const child = await repo.createTask({ title: 'Paint the shelf' });
      expect(
        expectErr(await repo.addDependencies({ childId: child.id, parentIds: [] })).code,
      ).toBe('invalid_input');
    });

    it('treats a repeated dependency as a no-op', async () => {
      const parent = await repo.createTask({ title: 'Buy the paint' });
      const child = await repo.createTask({ title: 'Paint the shelf' });
      expectOk(await repo.addDependencies({ childId: child.id, parentIds: [parent.id] }));
      expectOk(await repo.addDependencies({ childId: child.id, parentIds: [parent.id, parent.id] }));
      expect((await repo.getGraph()).edges).toHaveLength(1);
    });

    it('treats completing and uncompleting twice as a no-op', async () => {
      const parent = await repo.createTask({ title: 'Buy the paint' });
      const child = await repo.createTask({ title: 'Paint the shelf' });
      expectOk(await repo.addDependencies({ childId: child.id, parentIds: [parent.id] }));

      expectOk(await repo.completeTask(parent.id));
      const second = expectOk(await repo.completeTask(parent.id));
      expect(second.unlocked).toEqual([]);
      expect((await repo.getTask(child.id))?.isLocked).toBe(false);

      expectOk(await repo.uncompleteTask(parent.id));
      const secondUndo = expectOk(await repo.uncompleteTask(parent.id));
      expect(secondUndo.relocked).toEqual([]);
      expect((await repo.getTask(child.id))?.isLocked).toBe(true);
    });

    it('serialises overlapping mutations instead of losing one', async () => {
      const one = await repo.createTask({ title: 'Buy the paint' });
      const two = await repo.createTask({ title: 'Sand the shelf' });
      const child = await repo.createTask({ title: 'Paint the shelf' });
      expectOk(await repo.addDependencies({ childId: child.id, parentIds: [one.id, two.id] }));

      // Two taps in the same tick. One SQLite connection: a second BEGIN inside
      // the first transaction threw, and its ROLLBACK undid the other tick too.
      const both = await Promise.all([repo.completeTask(one.id), repo.completeTask(two.id)]);
      const unlocked = both.flatMap((r) => expectOk(r).unlocked.map((u) => u.title));

      expect((await repo.getTask(one.id))?.isCompleted).toBe(true);
      expect((await repo.getTask(two.id))?.isCompleted).toBe(true);
      expect(unlocked).toEqual(['Paint the shelf']);
    });

    it('keeps a task created while another command is rolling back', async () => {
      const [created, deleted] = await Promise.all([
        repo.createTask({ title: 'Water the plants' }),
        repo.deleteTask('ghost'),
      ]);
      expect(expectErr(deleted).code).toBe('not_found');
      // The bare insert used to land inside the doomed transaction: the caller
      // got a Task back and the row was gone.
      expect(await repo.getTask(created.id)).not.toBeNull();
    });

    it('does not announce a child that is already finished as unlocked', async () => {
      const parent = await repo.createTask({ title: 'Buy the paint' });
      const child = await repo.createTask({ title: 'Paint the shelf' });
      expectOk(await repo.addDependencies({ childId: child.id, parentIds: [parent.id] }));
      // The user did it out of order; the flag still has to be corrected.
      expectOk(await repo.completeTask(child.id));

      const result = expectOk(await repo.completeTask(parent.id));
      expect(result.unlocked).toEqual([]);
      expect((await repo.getTask(child.id))?.isLocked).toBe(false);
    });
  });
});
