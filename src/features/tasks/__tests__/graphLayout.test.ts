import { blockersByTask, GRAPH_METRICS, layoutGraph } from '../graphLayout';
import type { Task } from '@/db/schema';
import type { DependencyEdge } from '@/repositories/tasks';

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    dueDate: null,
    isCompleted: false,
    isLocked: false,
    createdAt: 0,
    notes: null,
    projectId: null,
    priority: 2,
    estimatedMinutes: null,
    completedAt: null,
    unlockedAt: null,
    calendarEventId: null,
    source: 'voice',
    updatedAt: 0,
    ...extra,
  };
}

const edge = (parentTaskId: string, childTaskId: string): DependencyEdge => ({
  parentTaskId,
  childTaskId,
});

describe('graph layout', () => {
  it('puts a node one column right of its deepest prerequisite', () => {
    const layout = layoutGraph(
      [task('print'), task('order'), task('assemble'), task('ship')],
      [edge('print', 'assemble'), edge('order', 'assemble'), edge('assemble', 'ship')],
    );

    const col = new Map(layout.nodes.map((node) => [node.task.id, node.col]));
    expect(col.get('print')).toBe(0);
    expect(col.get('order')).toBe(0);
    expect(col.get('assemble')).toBe(1);
    expect(col.get('ship')).toBe(2);
    expect(layout.columns).toBe(3);
  });

  it('drops tasks that take part in no dependency', () => {
    const layout = layoutGraph(
      [task('lonely'), task('a'), task('b')],
      [edge('a', 'b')],
    );
    expect(layout.nodes.map((n) => n.task.id).sort()).toEqual(['a', 'b']);
  });

  it('returns an empty layout when nothing is linked', () => {
    expect(layoutGraph([task('a')], []).nodes).toHaveLength(0);
  });

  it('sizes the canvas to the widest column and the tallest stack', () => {
    const layout = layoutGraph(
      [task('a'), task('b'), task('c')],
      [edge('a', 'c'), edge('b', 'c')],
    );
    const { nodeWidth, nodeHeight, colGap, rowGap, padding } = GRAPH_METRICS;
    expect(layout.width).toBe(padding * 2 + nodeWidth * 2 + colGap);
    expect(layout.height).toBe(padding * 2 + nodeHeight * 2 + rowGap);
  });

  it('marks an edge satisfied once its prerequisite is done, and points at the child', () => {
    const layout = layoutGraph(
      [task('a', { isCompleted: true }), task('b')],
      [edge('a', 'b')],
    );
    const [drawn] = layout.edges;
    expect(drawn?.satisfied).toBe(true);
    expect(drawn?.turnX).toBeLessThan(drawn?.toX ?? 0);
    expect(drawn?.turnX).toBeGreaterThan(drawn?.fromX ?? 0);
  });

  it('survives data that is already cyclic instead of looping forever', () => {
    const layout = layoutGraph([task('a'), task('b')], [edge('a', 'b'), edge('b', 'a')]);
    expect(layout.nodes).toHaveLength(2);
  });

  it('collects blockers per task from the whole graph in one pass', () => {
    const map = blockersByTask(
      [task('print'), task('order'), task('assemble')],
      [edge('print', 'assemble'), edge('order', 'assemble')],
    );
    expect(map.get('assemble')?.map((t) => t.id)).toEqual(['print', 'order']);
    expect(map.get('print')).toBeUndefined();
  });
});
