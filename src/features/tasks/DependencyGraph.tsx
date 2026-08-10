import { Fragment, useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { Task } from '@/db/schema';
import type { DependencyEdge } from '@/repositories/tasks';
import { Chip, EmptyState } from '@/ui/components/Controls';
import { MIC_CLEARANCE } from '@/ui/components/Screen';
import { Txt } from '@/ui/components/Text';
import { useTheme } from '@/ui/ThemeProvider';

import { GRAPH_METRICS, layoutGraph, type LaidOutEdge } from './graphLayout';

/**
 * The prerequisite DAG, drawn with Views.
 *
 * Columns are topological depth, so the leftmost column is everything that can
 * be started today and every arrow points at work that is still waiting. Lines
 * are rendered before the nodes so an edge that has to cross a column passes
 * behind the boxes instead of through their labels.
 */
export function DependencyGraph({
  nodes,
  edges,
  onOpen,
}: {
  nodes: readonly Task[];
  edges: readonly DependencyEdge[];
  onOpen: (task: Task) => void;
}) {
  const { colors, radius, spacing } = useTheme();
  const layout = useMemo(() => layoutGraph(nodes, edges), [nodes, edges]);

  if (layout.nodes.length === 0) {
    return (
      <EmptyState
        icon="git-network-outline"
        title="No dependency chains yet"
        hint="Try: “I need to 3D print the frame and order the servos before I can assemble the robot”"
      />
    );
  }

  return (
    <View style={{ flex: 1, gap: spacing.sm }}>
      <View style={[styles.legend, { paddingHorizontal: spacing.lg }]}>
        <Chip size="sm" label="Ready" color={colors.accent} />
        <Chip size="sm" label="Blocked" color={colors.warning} />
        <Chip size="sm" label="Done" color={colors.success} />
        <Txt variant="micro" tone="tertiary" style={{ flex: 1 }} numberOfLines={1}>
          Linked tasks only
        </Txt>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <ScrollView
          style={{ width: layout.width }}
          contentContainerStyle={{ paddingBottom: MIC_CLEARANCE }}
          showsVerticalScrollIndicator={false}
        >
          <View style={{ width: layout.width, height: layout.height }}>
            {layout.edges.map((edge) => (
              <Connector
                key={edge.key}
                edge={edge}
                color={edge.satisfied ? colors.success : colors.borderStrong}
              />
            ))}

            {layout.nodes.map(({ task, x, y }) => {
              const done = task.isCompleted === true;
              const locked = task.isLocked === true && !done;
              const tint = done ? colors.success : locked ? colors.warning : colors.accent;
              const state = done ? 'done' : locked ? 'blocked' : 'ready';
              return (
                <Pressable
                  key={task.id}
                  testID={`graph-node-${task.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${task.title}, ${state}`}
                  onPress={() => onOpen(task)}
                  style={({ pressed }) => [
                    styles.node,
                    {
                      left: x,
                      top: y,
                      width: GRAPH_METRICS.nodeWidth,
                      height: GRAPH_METRICS.nodeHeight,
                      backgroundColor: colors.surface,
                      borderColor: colors.border,
                      borderLeftColor: tint,
                      borderRadius: radius.sm,
                      opacity: pressed ? 0.7 : 1,
                    },
                  ]}
                >
                  <Ionicons
                    name={done ? 'checkmark-circle' : locked ? 'lock-closed' : 'ellipse-outline'}
                    size={11}
                    color={tint}
                  />
                  <Txt
                    variant="micro"
                    tone={done ? 'tertiary' : 'primary'}
                    numberOfLines={2}
                    style={[{ flex: 1 }, done ? styles.struck : null]}
                  >
                    {task.title}
                  </Txt>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </ScrollView>
    </View>
  );
}

/** Three thin Views: out of the parent, down the gutter, into the child. */
function Connector({ edge, color }: { edge: LaidOutEdge; color: string }) {
  return (
    <Fragment>
      <View
        style={[
          styles.line,
          {
            left: Math.min(edge.fromX, edge.turnX),
            top: edge.fromY,
            width: Math.abs(edge.turnX - edge.fromX),
            height: LINE,
            backgroundColor: color,
          },
        ]}
      />
      <View
        style={[
          styles.line,
          {
            left: edge.turnX,
            top: Math.min(edge.fromY, edge.toY),
            width: LINE,
            height: Math.abs(edge.toY - edge.fromY),
            backgroundColor: color,
          },
        ]}
      />
      <View
        style={[
          styles.line,
          {
            left: Math.min(edge.turnX, edge.toX),
            top: edge.toY,
            width: Math.abs(edge.toX - edge.turnX),
            height: LINE,
            backgroundColor: color,
          },
        ]}
      />
      <Ionicons
        name="caret-forward"
        size={10}
        color={color}
        style={{ position: 'absolute', left: edge.toX - 7, top: edge.toY - 5 }}
      />
    </Fragment>
  );
}

/** Hairlines round to nothing on some densities; a connector has to stay visible. */
const LINE = 1;

const styles = StyleSheet.create({
  legend: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  node: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: 3,
  },
  line: { position: 'absolute' },
  struck: { textDecorationLine: 'line-through' },
});
