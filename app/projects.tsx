/**
 * Projects, grouped by the only thing that changes how you read them: status.
 *
 * Each row answers "how far along is this and when is it due" without opening
 * anything, because the common case is a glance, not a visit.
 */
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { useRouter } from 'expo-router';

import { countLabel } from '@/core/format';
import {
  useArchiveProject,
  useCreateProject,
  useProjectSummaries,
  useSetProjectStatus,
  type ProjectSummary,
} from '@/hooks';
import type { CreateProjectInput, ProjectStatus } from '@/repositories/projects';
import {
  CreateProjectSheet,
  ErrorRow,
  MenuSheet,
  ProjectCard,
  SkeletonRows,
  STATUS_LABEL,
  STATUS_ORDER,
  errorMessage,
  type MenuOption,
} from '@/features/projects';
import { Button, EmptyState, Screen, Section, useRefresh, useToast } from '@/ui/components';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { REFLOW_MS } from '@/ui/motion';
import { useStaggeredEntry } from '@/ui/motionHooks';
import { useTheme } from '@/ui/ThemeProvider';

const VOICE_HINT = "Try: 'for my Japan trip, remind me to pack slippers'";

export default function ProjectsScreen() {
  const { spacing } = useTheme();
  const router = useRouter();
  const toast = useToast();

  const summaries = useProjectSummaries();
  const create = useCreateProject();
  const setStatus = useSetProjectStatus();
  const archive = useArchiveProject();

  const [composing, setComposing] = useState(false);
  const [menuFor, setMenuFor] = useState<ProjectSummary | null>(null);

  const rows = useMemo(() => summaries.data ?? [], [summaries.data]);
  // `offset` is what makes the arrival one wave down the page rather than one
  // per heading: the groups are a single list broken by status, and restarting
  // the count at each heading would read as three lists loading separately.
  const groups = useMemo(() => {
    const present = STATUS_ORDER.map((status) => ({
      status,
      rows: rows.filter((row) => row.project.status === status),
    })).filter((group) => group.rows.length > 0);

    // Each group's offset is the row count of every group above it.
    return present.map((group, index) => ({
      ...group,
      offset: present.slice(0, index).reduce((sum, above) => sum + above.rows.length, 0),
    }));
  }, [rows]);
  const arrive = useStaggeredEntry({ from: 'below' });

  const activeCount = rows.filter((row) => row.project.status === 'active').length;

  const submit = async (input: CreateProjectInput) => {
    try {
      const project = await create.mutateAsync(input);
      setComposing(false);
      // Straight into the empty project: the next thing the user wants is to
      // put something in it.
      router.push({ pathname: '/project/[id]', params: { id: project.id } });
    } catch (error) {
      toast.show({
        message: 'Could not create that project',
        detail: errorMessage(error),
        tone: 'danger',
      });
    }
  };

  const menuOptions = (summary: ProjectSummary): MenuOption[] => {
    const current = summary.project.status;
    const move = (status: ProjectStatus) => () =>
      setStatus.mutate(
        { projectId: summary.project.id, status },
        {
          onError: (error) =>
            toast.show({ message: errorMessage(error), tone: 'danger' }),
        },
      );
    return [
      {
        label: 'Open',
        icon: 'open-outline',
        tone: 'accent',
        onPress: () =>
          router.push({ pathname: '/project/[id]', params: { id: summary.project.id } }),
      },
      { label: 'Mark active', icon: 'play-outline', selected: current === 'active', onPress: move('active') },
      { label: 'Pause', icon: 'pause-outline', selected: current === 'paused', onPress: move('paused') },
      { label: 'Mark done', icon: 'checkmark-done-outline', selected: current === 'done', onPress: move('done') },
      {
        label: 'Archive',
        icon: 'archive-outline',
        selected: current === 'archived',
        onPress: () =>
          archive.mutate(summary.project.id, {
            onError: (error) => toast.show({ message: errorMessage(error), tone: 'danger' }),
          }),
      },
    ];
  };

  // A hook, not `<Refresh />`: what reaches `refreshControl` has to be the
  // `RefreshControl` element itself. See the note in `Refresh.tsx`.
  const refreshControl = useRefresh({
    refreshing: summaries.isFetching && !summaries.isPending,
    onRefresh: () => void summaries.refetch(),
  });

  return (
    <Screen
      back
      title="Projects"
      subtitle={rows.length === 0 ? undefined : countLabel(activeCount, 'active project')}
      right={
        <Button
          label="New"
          icon="add"
          variant="primary"
          size="sm"
          onPress={() => setComposing(true)}
          accessibilityLabel="New project"
          testID="project-new"
        />
      }
      refreshControl={refreshControl}
    >
      <ErrorBoundary label="projects">
        {summaries.isPending ? (
          <SkeletonRows count={5} height={78} />
        ) : summaries.isError ? (
          <ErrorRow
            message={errorMessage(summaries.error, 'Could not load your projects.')}
            onRetry={() => void summaries.refetch()}
            busy={summaries.isFetching}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="albums-outline"
            title="No projects yet"
            hint={`A project holds the ideas, lists and spending for one thing — a trip, an event, a course. ${VOICE_HINT}`}
          />
        ) : (
          <View style={{ gap: spacing.lg }}>
            {groups.map((group) => (
              <Section
                key={group.status}
                title={`${STATUS_LABEL[group.status]} · ${group.rows.length}`}
                compact
              >
                <View style={{ gap: spacing.sm }}>
                  {group.rows.map((summary, index) => (
                    // Pausing or finishing a project moves its card to another
                    // heading entirely; `layout` is what makes that a move
                    // rather than a card blinking out of one group and into
                    // another.
                    <Animated.View
                      key={summary.project.id}
                      entering={arrive(group.offset + index)}
                      layout={LinearTransition.duration(REFLOW_MS)}
                    >
                      <ProjectCard
                        summary={summary}
                        onPress={() =>
                          router.push({
                            pathname: '/project/[id]',
                            params: { id: summary.project.id },
                          })
                        }
                        onLongPress={() => setMenuFor(summary)}
                      />
                    </Animated.View>
                  ))}
                </View>
              </Section>
            ))}
          </View>
        )}
      </ErrorBoundary>

      <CreateProjectSheet
        visible={composing}
        busy={create.isPending}
        onClose={() => setComposing(false)}
        onCreate={(input) => void submit(input)}
      />

      <MenuSheet
        visible={menuFor !== null}
        title={menuFor?.project.name}
        subtitle={menuFor ? STATUS_LABEL[menuFor.project.status] : undefined}
        options={menuFor ? menuOptions(menuFor) : []}
        onClose={() => setMenuFor(null)}
      />
    </Screen>
  );
}
