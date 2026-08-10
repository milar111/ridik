/**
 * A layered layout for the prerequisite DAG, computed with plain arithmetic so
 * the view can draw it with absolutely-positioned Views and no graph library.
 *
 * Column = topological depth, i.e. how many prerequisites deep a task sits. That
 * is the only ordering the user cares about: everything in column 0 can be
 * started now, everything to its right is waiting on what is to its left.
 */
import type { Task } from '@/db/schema';
import type { DependencyEdge } from '@/repositories/tasks';

export type GraphMetrics = {
  nodeWidth: number;
  nodeHeight: number;
  colGap: number;
  rowGap: number;
  padding: number;
};

export const GRAPH_METRICS: GraphMetrics = {
  nodeWidth: 146,
  nodeHeight: 52,
  colGap: 54,
  rowGap: 10,
  padding: 16,
};

export type LaidOutNode = {
  task: Task;
  col: number;
  row: number;
  x: number;
  y: number;
};

export type LaidOutEdge = {
  key: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** X of the vertical segment: just before the child, so it clears the gap. */
  turnX: number;
  /** The prerequisite is done — the chain has already flowed through this edge. */
  satisfied: boolean;
};

export type GraphLayout = {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
  columns: number;
};

export const EMPTY_LAYOUT: GraphLayout = { nodes: [], edges: [], width: 0, height: 0, columns: 0 };

/**
 * Only tasks that take part in a dependency appear.
 *
 * A user with sixty loose tasks and two chains would otherwise get a wall of
 * disconnected boxes with the actual structure lost inside it; an isolated node
 * carries no information a list does not already show better.
 */
export function layoutGraph(
  nodes: readonly Task[],
  edges: readonly DependencyEdge[],
  metrics: GraphMetrics = GRAPH_METRICS,
): GraphLayout {
  const byId = new Map(nodes.map((task) => [task.id, task]));
  const linked = edges.filter(
    (edge) => byId.has(edge.parentTaskId) && byId.has(edge.childTaskId),
  );
  if (linked.length === 0) return EMPTY_LAYOUT;

  const present = new Set<string>();
  for (const edge of linked) {
    present.add(edge.parentTaskId);
    present.add(edge.childTaskId);
  }
  // Creation order is the stable tiebreaker everywhere below, so capture it once.
  const order = new Map<string, number>();
  const participating: Task[] = [];
  for (const task of nodes) {
    if (!present.has(task.id)) continue;
    order.set(task.id, participating.length);
    participating.push(task);
  }

  const depth = computeDepths(participating, linked);
  const columns = groupIntoColumns(participating, depth);
  orderColumns(columns, linked, order);

  const laidOut: LaidOutNode[] = [];
  const position = new Map<string, LaidOutNode>();
  columns.forEach((column, col) => {
    column.forEach((task, row) => {
      const node: LaidOutNode = {
        task,
        col,
        row,
        x: metrics.padding + col * (metrics.nodeWidth + metrics.colGap),
        y: metrics.padding + row * (metrics.nodeHeight + metrics.rowGap),
      };
      laidOut.push(node);
      position.set(task.id, node);
    });
  });

  const drawnEdges: LaidOutEdge[] = [];
  for (const edge of linked) {
    const from = position.get(edge.parentTaskId);
    const to = position.get(edge.childTaskId);
    if (!from || !to) continue;
    drawnEdges.push({
      key: `${edge.parentTaskId}->${edge.childTaskId}`,
      fromX: from.x + metrics.nodeWidth,
      fromY: from.y + metrics.nodeHeight / 2,
      toX: to.x,
      toY: to.y + metrics.nodeHeight / 2,
      turnX: to.x - metrics.colGap / 2,
      satisfied: from.task.isCompleted === true,
    });
  }

  const rows = columns.reduce((max, column) => Math.max(max, column.length), 0);
  return {
    nodes: laidOut,
    edges: drawnEdges,
    columns: columns.length,
    width:
      metrics.padding * 2 +
      columns.length * metrics.nodeWidth +
      Math.max(0, columns.length - 1) * metrics.colGap,
    height:
      metrics.padding * 2 + rows * metrics.nodeHeight + Math.max(0, rows - 1) * metrics.rowGap,
  };
}

/**
 * Longest-path depth via Kahn's algorithm.
 *
 * The repository refuses cycles, but this runs on rows read from disk, so
 * anything the queue never reaches is parked in column 0 rather than looping
 * forever — a wrong-but-visible node beats a hung screen.
 */
function computeDepths(nodes: readonly Task[], edges: readonly DependencyEdge[]): Map<string, number> {
  const children = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const task of nodes) indegree.set(task.id, 0);
  for (const edge of edges) {
    const list = children.get(edge.parentTaskId);
    if (list) list.push(edge.childTaskId);
    else children.set(edge.parentTaskId, [edge.childTaskId]);
    indegree.set(edge.childTaskId, (indegree.get(edge.childTaskId) ?? 0) + 1);
  }

  const depth = new Map<string, number>(nodes.map((task) => [task.id, 0]));
  const queue = nodes.filter((task) => (indegree.get(task.id) ?? 0) === 0).map((task) => task.id);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    const here = depth.get(id) ?? 0;
    for (const child of children.get(id) ?? []) {
      depth.set(child, Math.max(depth.get(child) ?? 0, here + 1));
      const remaining = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, remaining);
      if (remaining === 0) queue.push(child);
    }
  }
  return depth;
}

function groupIntoColumns(nodes: readonly Task[], depth: Map<string, number>): Task[][] {
  const deepest = nodes.reduce((max, task) => Math.max(max, depth.get(task.id) ?? 0), 0);
  const columns: Task[][] = Array.from({ length: deepest + 1 }, () => []);
  for (const task of nodes) columns[depth.get(task.id) ?? 0]!.push(task);
  return columns;
}

/**
 * One barycentre pass, left to right: a node sits opposite the average row of
 * its prerequisites. It is not optimal crossing reduction, but at the ~20 nodes
 * this view is meant for it turns a scribble into something readable for free.
 */
function orderColumns(
  columns: Task[][],
  edges: readonly DependencyEdge[],
  order: Map<string, number>,
): void {
  const parents = new Map<string, string[]>();
  for (const edge of edges) {
    const list = parents.get(edge.childTaskId);
    if (list) list.push(edge.parentTaskId);
    else parents.set(edge.childTaskId, [edge.parentTaskId]);
  }

  const rowOf = new Map<string, number>();
  columns.forEach((column, index) => {
    if (index === 0) {
      column.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    } else {
      const centre = new Map<string, number>();
      for (const task of column) {
        const rows = (parents.get(task.id) ?? [])
          .map((id) => rowOf.get(id))
          .filter((row): row is number => row !== undefined);
        centre.set(
          task.id,
          rows.length === 0
            ? Number.MAX_SAFE_INTEGER
            : rows.reduce((sum, row) => sum + row, 0) / rows.length,
        );
      }
      column.sort((a, b) => {
        const delta = (centre.get(a.id) ?? 0) - (centre.get(b.id) ?? 0);
        return delta !== 0 ? delta : (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
      });
    }
    column.forEach((task, row) => rowOf.set(task.id, row));
  });
}

/** Prerequisites per task, for the blocked list — one pass over the whole graph. */
export function blockersByTask(
  nodes: readonly Task[],
  edges: readonly DependencyEdge[],
): Map<string, Task[]> {
  const byId = new Map(nodes.map((task) => [task.id, task]));
  const result = new Map<string, Task[]>();
  for (const edge of edges) {
    const parent = byId.get(edge.parentTaskId);
    if (!parent) continue;
    const list = result.get(edge.childTaskId);
    if (list) list.push(parent);
    else result.set(edge.childTaskId, [parent]);
  }
  return result;
}
