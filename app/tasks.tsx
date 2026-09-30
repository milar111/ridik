import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { countLabel } from '@/core/format';
import type { Task } from '@/db/schema';
import {
  ActiveTasks,
  BlockedTasks,
  blockersByTask,
  DependencyGraph,
  DoneTasks,
  LoadError,
  QuickActions,
  TaskDetailSheet,
  TaskRowSkeleton,
  useTaskActions,
} from '@/features/tasks';
import { useActiveTasks, useProjects, useTaskGraph, useTasks } from '@/hooks';
import { Segmented } from '@/ui/components/Controls';
import { useRefresh } from '@/ui/components/Refresh';
import { MIC_CLEARANCE, Screen } from '@/ui/components/Screen';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { useTheme } from '@/ui/ThemeProvider';
import { AnimatedPressable, usePressScale } from '@/ui/motionHooks';

type TaskView = 'active' | 'blocked' | 'done';

const VIEWS: { value: TaskView; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'done', label: 'Done' },
];

/**
 * No SQL `limit` here on purpose: the repository orders by *due date*, so a
 * limit would keep the oldest-dated rows and drop what was finished today.
 * `DoneTasks` caps the list after it has sorted on completion time.
 */
const DONE_FILTER = { completed: true } as const;

export default function TasksScreen() {
  const { colors, spacing } = useTheme();
  /*
   * The tab can be opened *into*, and the reason is a real dead end.
   *
   * "I can't solder the board until the bearings arrive" files a dependency
   * and then the soldering task vanishes from Active — correctly, it is
   * blocked — with the only trace a "· 1 blocked" in the subtitle. So the
   * receipt said the link had been made, the tap on it opened the screen where
   * the task is not, and the honest question that came back was "where should
   * I see that?".
   */
  const params = useLocalSearchParams<{ view?: string }>();
  const [view, setView] = useState<TaskView>(
    params.view === 'blocked' || params.view === 'done' ? params.view : 'active',
  );
  const [showGraph, setShowGraph] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [quickTask, setQuickTask] = useState<Task | null>(null);

  const active = useActiveTasks();
  const done = useTasks(DONE_FILTER);
  const projects = useProjects();
  // One graph query serves three things: the blocked list, its blockers and the
  // DAG view. Splitting them would have the same rows fetched three ways.
  const graph = useTaskGraph();

  const nodes = useMemo(() => graph.data?.nodes ?? [], [graph.data]);
  const edges = useMemo(() => graph.data?.edges ?? [], [graph.data]);

  const projectNames = useMemo(
    () => new Map((projects.data ?? []).map((project) => [project.id, project.name])),
    [projects.data],
  );
  const blocked = useMemo(
    () => nodes.filter((task) => task.isLocked === true && task.isCompleted !== true),
    [nodes],
  );
  const blockers = useMemo(() => blockersByTask(nodes, edges), [nodes, edges]);
  const byId = useMemo(() => new Map(nodes.map((task) => [task.id, task])), [nodes]);

  const actions = useTaskActions({ onOpenUnlocked: (task) => setDetailId(task.id) });
  const handlers = {
    onToggle: actions.toggle,
    onOpen: (task: Task) => setDetailId(task.id),
    onQuickActions: (task: Task) => setQuickTask(task),
  };

  const refresh = () => {
    void active.refetch();
    void done.refetch();
    void graph.refetch();
    // Project names label every row; a rename must not survive a pull.
    void projects.refetch();
  };

  // The sheet must never render a snapshot the graph has already moved past.
  const quick = quickTask ? byId.get(quickTask.id) ?? quickTask : null;

  const activeCount = active.data?.length ?? 0;
  const subtitle = `${countLabel(activeCount, 'task')} ready · ${blocked.length} blocked`;

  // A bare 21pt glyph in a 44×40 box: deeper travel, because the icon is the
  // only thing that can move.
  const viewPress = usePressScale({ scale: 0.86 });

  // A hook, not `<Refresh />`: what reaches `refreshControl` has to be the
  // `RefreshControl` element itself. This screen's `Screen` is `scroll={false}`,
  // so a wrapper would empty only the list below rather than the whole page,
  // which reads as "no tasks".
  const refreshControl = useRefresh({
    refreshing: active.isRefetching || graph.isRefetching,
    onRefresh: refresh,
  });

  return (
    <Screen
      back
      title="Tasks"
      subtitle={subtitle}
      scroll={false}
      contentStyle={{ flex: 1, paddingHorizontal: 0, gap: 0 }}
      right={
        <AnimatedPressable
          accessibilityRole="button"
          accessibilityLabel={showGraph ? 'Show task lists' : 'Show dependency graph'}
          accessibilityState={{ selected: showGraph }}
          onPress={() => setShowGraph((on) => !on)}
          hitSlop={8}
          {...viewPress.handlers}
          style={[
            {
              width: 44,
              height: 40,
              alignItems: 'flex-end',
              justifyContent: 'center',
            },
            viewPress.style,
          ]}
        >
          <Ionicons
            name={showGraph ? 'list-outline' : 'git-network-outline'}
            size={21}
            color={showGraph ? colors.accent : colors.textSecondary}
          />
        </AnimatedPressable>
      }
    >
      {showGraph ? (
        // Loading and failure are branches here too: without them a failed read
        // renders "no dependency chains yet", which tells the user their
        // chains are gone rather than that the read did not happen.
        <ErrorBoundary label="dependency graph">
          {graph.isError ? (
            <View style={{ paddingHorizontal: spacing.lg }}>
              <LoadError error={graph.error} onRetry={() => void graph.refetch()} />
            </View>
          ) : graph.isLoading ? (
            <View style={{ paddingHorizontal: spacing.lg }}>
              <TaskRowSkeleton />
            </View>
          ) : (
            <DependencyGraph nodes={nodes} edges={edges} onOpen={(task) => setDetailId(task.id)} />
          )}
        </ErrorBoundary>
      ) : (
        <>
          <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.md }}>
            {/* The count rides on the tab, not only in the subtitle. A tab
                that says how much is behind it is the difference between a
                third segment nobody presses and one that asks to be. */}
            <Segmented
              options={VIEWS.map((entry) =>
                entry.value === 'blocked' && blocked.length > 0
                  ? { ...entry, label: `Blocked ${blocked.length}` }
                  : entry,
              )}
              value={view}
              onChange={setView}
            />
          </View>

          <ScrollView
            contentContainerStyle={{
              paddingHorizontal: spacing.lg,
              paddingBottom: MIC_CLEARANCE,
              gap: spacing.lg,
            }}
            showsVerticalScrollIndicator={false}
            refreshControl={refreshControl}
          >
            <ErrorBoundary label="task list">
              {view === 'active' ? (
                active.isError ? (
                  <LoadError error={active.error} onRetry={() => void active.refetch()} />
                ) : active.isLoading ? (
                  <TaskRowSkeleton />
                ) : (
                  <ActiveTasks
                    tasks={active.data ?? []}
                    projectNames={projectNames}
                    {...handlers}
                  />
                )
              ) : view === 'blocked' ? (
                graph.isError ? (
                  <LoadError error={graph.error} onRetry={() => void graph.refetch()} />
                ) : graph.isLoading ? (
                  <TaskRowSkeleton />
                ) : (
                  <BlockedTasks
                    tasks={blocked}
                    blockers={blockers}
                    projectNames={projectNames}
                    {...handlers}
                  />
                )
              ) : done.isError ? (
                <LoadError error={done.error} onRetry={() => void done.refetch()} />
              ) : done.isLoading ? (
                <TaskRowSkeleton />
              ) : (
                <DoneTasks tasks={done.data ?? []} projectNames={projectNames} {...handlers} />
              )}
            </ErrorBoundary>
          </ScrollView>
        </>
      )}

      {/* One sheet at a time: presenting a modal while another is dismissing
          drops the second one on iOS. */}
      <TaskDetailSheet
        taskId={quick ? null : detailId}
        actions={actions}
        onClose={() => setDetailId(null)}
        onOpenTask={(task) => setDetailId(task.id)}
      />
      <QuickActions
        task={quick}
        actions={actions}
        onClose={() => setQuickTask(null)}
        onOpenDetail={(task) => setDetailId(task.id)}
      />
    </Screen>
  );
}
