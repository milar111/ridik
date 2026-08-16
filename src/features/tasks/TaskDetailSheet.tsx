import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { truncate } from '@/core/format';
import { normalise } from '@/core/match';
import { toAppError } from '@/core/result';
import { formatDuration } from '@/core/time';
import type { Task } from '@/db/schema';
import {
  useAddTaskDependencies,
  useProjects,
  useRemoveTaskDependency,
  useTask,
  useTaskBlockers,
  useTaskDependents,
  useTaskGraph,
  useTasks,
  type TaskPatch,
} from '@/hooks';
import { wouldCreateCycle } from '@/repositories/tasks';
import { Button } from '@/ui/components/Button';
import { Card, Divider } from '@/ui/components/Card';
import { Badge, Chip, Input } from '@/ui/components/Controls';
import { Section } from '@/ui/components/Screen';
import { Spinner } from '@/ui/components/Spinner';
import { Txt } from '@/ui/components/Text';
import { colorForTag } from '@/ui/theme';
import { useTheme } from '@/ui/ThemeProvider';
import { AnimatedPressable, usePressScale } from '@/ui/motionHooks';

import { bucketOf, dueLabel, PRIORITY_LABEL } from './buckets';
import { InlineError } from './Feedback';
import { dayAtDefaultHour, ESTIMATE_CHOICES } from './schedule';
import { Sheet } from './Sheet';
import type { TaskActions } from './useTaskActions';

export function TaskDetailSheet({
  taskId,
  actions,
  onClose,
  onOpenTask,
}: {
  taskId: string | null;
  actions: TaskActions;
  onClose: () => void;
  onOpenTask: (task: Task) => void;
}) {
  const { data: task, isLoading } = useTask(taskId ?? undefined);
  if (!taskId) return null;

  return (
    <Sheet visible onClose={onClose} title="Task" subtitle={task ? stateOf(task).label : undefined}>
      {task ? (
        <DetailBody task={task} actions={actions} onClose={onClose} onOpenTask={onOpenTask} />
      ) : isLoading ? (
        <Spinner accessibilityLabel="Loading this task" />
      ) : (
        <Txt variant="caption" tone="tertiary">
          That task no longer exists.
        </Txt>
      )}
    </Sheet>
  );
}

function stateOf(task: Task): { label: string; tone: 'success' | 'warning' | 'accent' } {
  if (task.isCompleted === true) return { label: 'Done', tone: 'success' };
  if (task.isLocked === true) return { label: 'Blocked', tone: 'warning' };
  return { label: 'Ready', tone: 'accent' };
}

function DetailBody({
  task,
  actions,
  onClose,
  onOpenTask,
}: {
  task: Task;
  actions: TaskActions;
  onClose: () => void;
  onOpenTask: (task: Task) => void;
}) {
  const { colors, spacing } = useTheme();
  const { data: projects = [] } = useProjects();
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Re-seeded per task, never per cache write: an invalidation landing while the
  // user types would otherwise yank the field back to the stored value.
  useEffect(() => {
    setTitle(task.title);
    setNotes(task.notes ?? '');
    setConfirmDelete(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  const state = stateOf(task);
  const done = task.isCompleted === true;
  const bucket = bucketOf(task.dueDate);

  // Through `actions`, not a bare mutation: that is where the tab's one
  // "the write failed, here is why" path lives, and a silently dropped edit
  // looks exactly like a saved one once the optimistic patch rolls back.
  const commit = (patch: TaskPatch) => actions.setField(task, patch);

  /** A blank title is unrenderable everywhere it appears, so it reverts instead. */
  const commitTitle = () => {
    const next = title.trim();
    if (next.length === 0) {
      setTitle(task.title);
      return;
    }
    if (next !== task.title) commit({ title: next });
  };

  return (
    <>
      <Input
        label="Title"
        value={title}
        onChangeText={setTitle}
        returnKeyType="done"
        onSubmitEditing={commitTitle}
        onBlur={commitTitle}
      />

      <View style={[styles.row, { gap: spacing.sm }]}>
        <Badge label={state.label} tone={state.tone} />
        {task.priority === 1 ? <Badge label="High priority" tone="accent" /> : null}
        <View style={{ flex: 1 }} />
        <Button
          label={done ? 'Reopen' : 'Complete'}
          icon={done ? 'arrow-undo-outline' : 'checkmark'}
          variant={done ? 'secondary' : 'primary'}
          size="sm"
          onPress={() => actions.toggle(task)}
        />
      </View>

      <Section
        compact
        title="Due"
        right={
          <Txt variant="micro" tone={bucket === 'overdue' ? 'danger' : 'tertiary'}>
            {task.dueDate != null ? dueLabel(task.dueDate) : 'None'}
          </Txt>
        }
      >
        <View style={styles.chips}>
          <Chip
            label="Today"
            selected={bucket === 'today'}
            onPress={() => actions.setDue(task, dayAtDefaultHour(0))}
          />
          <Chip
            label="Tomorrow"
            selected={bucket === 'tomorrow'}
            onPress={() => actions.setDue(task, dayAtDefaultHour(1))}
          />
          <Chip label="Next week" onPress={() => actions.setDue(task, dayAtDefaultHour(7))} />
          {task.dueDate != null ? (
            <Chip label="Clear" icon="close" onPress={() => actions.setDue(task, null)} />
          ) : null}
        </View>
      </Section>

      <Section compact title="Priority">
        <View style={styles.chips}>
          {[1, 2, 3].map((level) => (
            <Chip
              key={level}
              label={PRIORITY_LABEL[level] ?? String(level)}
              selected={task.priority === level}
              color={level === 1 ? colors.accent : colors.textSecondary}
              onPress={() => actions.setPriority(task, level)}
            />
          ))}
        </View>
      </Section>

      <Section
        compact
        title="Estimate"
        right={
          <Txt variant="micro" tone="tertiary">
            {task.estimatedMinutes != null ? formatDuration(task.estimatedMinutes) : 'None'}
          </Txt>
        }
      >
        <View style={styles.chips}>
          {ESTIMATE_CHOICES.map((minutes) => (
            <Chip
              key={minutes}
              label={formatDuration(minutes)}
              selected={task.estimatedMinutes === minutes}
              onPress={() => commit({ estimatedMinutes: minutes })}
            />
          ))}
          {task.estimatedMinutes != null ? (
            <Chip label="Clear" icon="close" onPress={() => commit({ estimatedMinutes: null })} />
          ) : null}
        </View>
      </Section>

      <Section compact title="Project">
        <View style={styles.chips}>
          <Chip
            label="None"
            selected={task.projectId == null}
            color={colors.textSecondary}
            onPress={() => commit({ projectId: null })}
          />
          {projects.map((project) => (
            <Chip
              key={project.id}
              label={truncate(project.name, 22)}
              selected={task.projectId === project.id}
              color={project.color ?? colorForTag(project.name)}
              onPress={() => commit({ projectId: project.id })}
            />
          ))}
        </View>
      </Section>

      <Input
        label="Notes"
        value={notes}
        onChangeText={setNotes}
        multiline
        placeholder="Anything you would otherwise forget…"
        style={{ minHeight: 64, textAlignVertical: 'top' }}
        onBlur={() => {
          const next = notes.trim();
          if (next !== (task.notes ?? '')) commit({ notes: next.length > 0 ? next : null });
        }}
      />

      <Prerequisites task={task} />
      <Dependents task={task} onOpenTask={onOpenTask} />

      {confirmDelete ? (
        <View style={{ gap: spacing.sm }}>
          <Txt variant="caption" tone="secondary">
            Delete “{task.title}”? This cannot be undone.
          </Txt>
          <View style={styles.actions}>
            <Button
              label="Delete"
              icon="trash-outline"
              variant="danger"
              onPress={() => actions.remove(task, { onDeleted: onClose })}
              testID="task-delete-confirm"
            />
            <Button label="Keep" variant="ghost" onPress={() => setConfirmDelete(false)} />
          </View>
        </View>
      ) : (
        <Button
          label="Delete task"
          icon="trash-outline"
          variant="danger"
          fullWidth
          onPress={() => setConfirmDelete(true)}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------ prerequisites */

/** The exact sentence the spec asks for: name the loop, do not just refuse. */
function loopMessage(parent: Task): string {
  return `That would create a loop: ${parent.title} already waits on this.`;
}

function Prerequisites({ task }: { task: Task }) {
  const { colors, spacing } = useTheme();
  const { data: blockers = [] } = useTaskBlockers(task.id);
  const { data: graph } = useTaskGraph();
  const { data: candidates = [] } = useTasks({ completed: false });
  const link = useAddTaskDependencies();
  const unlink = useRemoveTaskDependency();

  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const addPress = usePressScale({ scale: 0.9 });

  const edges = graph?.edges ?? [];
  const linked = useMemo(() => new Set(blockers.map((b) => b.id)), [blockers]);

  const matches = useMemo(() => {
    const needle = normalise(query);
    return candidates
      .filter((candidate) => candidate.id !== task.id && !linked.has(candidate.id))
      .filter((candidate) => needle.length === 0 || normalise(candidate.title).includes(needle))
      .slice(0, 8);
  }, [candidates, linked, query, task.id]);

  const add = (parent: Task) => {
    // Checked before the write as well as after it: the loop is knowable from
    // the graph already on screen, so the answer should be instant.
    if (wouldCreateCycle(edges, parent.id, task.id)) {
      setProblem(loopMessage(parent));
      return;
    }
    setProblem(null);
    link.mutate(
      { childId: task.id, parentIds: [parent.id] },
      {
        onSuccess: () => {
          setQuery('');
          setAdding(false);
        },
        onError: (error) => {
          const app = toAppError(error);
          setProblem(app.code === 'cycle' ? loopMessage(parent) : app.userMessage);
        },
      },
    );
  };

  return (
    <Section
      compact
      title="Prerequisites"
      right={
        <AnimatedPressable
          accessibilityRole="button"
          accessibilityLabel={adding ? 'Cancel adding a prerequisite' : 'Add a prerequisite'}
          // An 11pt label is a 14pt target; the slop is what makes it 44.
          hitSlop={{ top: 15, bottom: 15, left: 16, right: 16 }}
          onPress={() => {
            setAdding((open) => !open);
            setProblem(null);
          }}
          {...addPress.handlers}
          style={addPress.style}
        >
          <Txt variant="micro" tone="accent">
            {adding ? 'CANCEL' : 'ADD'}
          </Txt>
        </AnimatedPressable>
      }
    >
      {blockers.length === 0 ? (
        <Txt variant="caption" tone="tertiary">
          Nothing has to happen first.
        </Txt>
      ) : (
        <Card padded={false}>
          {blockers.map((blocker, i) => {
            const complete = blocker.isCompleted === true;
            return (
              <View key={blocker.id}>
                {i > 0 ? <Divider inset={38} /> : null}
                <View style={styles.linkRow}>
                  <Ionicons
                    name={complete ? 'checkmark-circle' : 'ellipse-outline'}
                    size={16}
                    color={complete ? colors.success : colors.warning}
                  />
                  <Txt variant="caption" style={{ flex: 1 }} numberOfLines={2}>
                    {blocker.title}
                  </Txt>
                  <RemoveButton
                    label={`Remove prerequisite ${blocker.title}`}
                    onPress={() =>
                      unlink.mutate(
                        { parentId: blocker.id, childId: task.id },
                        { onError: (error) => setProblem(toAppError(error).userMessage) },
                      )
                    }
                  />
                </View>
              </View>
            );
          })}
        </Card>
      )}

      {adding ? (
        <View style={{ gap: spacing.sm, marginTop: spacing.xs }}>
          <Input
            autoFocus
            value={query}
            onChangeText={setQuery}
            placeholder="Which task has to happen first?"
          />
          {matches.length === 0 ? (
            <Txt variant="micro" tone="tertiary">
              No open task matches that.
            </Txt>
          ) : (
            <Card padded={false}>
              {matches.map((candidate, i) => (
                <View key={candidate.id}>
                  {i > 0 ? <Divider inset={13} /> : null}
                  <LinkRow label={`Wait on ${candidate.title}`} onPress={() => add(candidate)}>
                    <Ionicons name="add" size={16} color={colors.accent} />
                    <Txt variant="caption" style={{ flex: 1 }} numberOfLines={1}>
                      {candidate.title}
                    </Txt>
                  </LinkRow>
                </View>
              ))}
            </Card>
          )}
        </View>
      ) : null}

      {problem ? <InlineError message={problem} /> : null}
    </Section>
  );
}

/* ----------------------------------------------------------------- link row */

/**
 * A tappable row in one of the dependency cards.
 *
 * Extracted for the press state: both lists build their rows in a `map`, and a
 * hook cannot be called from inside one. The pressed background swap these had
 * is gone — a row that both flashes and sinks answers one finger twice.
 *
 * This whole sheet is inside a React Native `Modal`, so the movement has to
 * come from a shared value driven by an effect. `usePressScale` is exactly
 * that; a layout animation here would silently never run.
 */
function LinkRow({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: React.ReactNode;
}) {
  const press = usePressScale({ scale: 0.98 });
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      {...press.handlers}
      style={[styles.linkRow, press.style]}
    >
      {children}
    </AnimatedPressable>
  );
}

/** The ✕ on a prerequisite. It had no press feedback at all before. */
function RemoveButton({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors } = useTheme();
  const press = usePressScale({ scale: 0.85 });
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={14}
      onPress={onPress}
      {...press.handlers}
      style={press.style}
    >
      <Ionicons name="close" size={16} color={colors.textTertiary} />
    </AnimatedPressable>
  );
}

/* --------------------------------------------------------------- dependents */

function Dependents({ task, onOpenTask }: { task: Task; onOpenTask: (task: Task) => void }) {
  const { colors } = useTheme();
  const { data: dependents = [] } = useTaskDependents(task.id);

  return (
    <Section compact title="Waiting on this">
      {dependents.length === 0 ? (
        <Txt variant="caption" tone="tertiary">
          Nothing is waiting on this.
        </Txt>
      ) : (
        <Card padded={false}>
          {dependents.map((dependent, i) => (
            <View key={dependent.id}>
              {i > 0 ? <Divider inset={38} /> : null}
              <LinkRow label={`Open ${dependent.title}`} onPress={() => onOpenTask(dependent)}>
                <Ionicons
                  name={dependent.isLocked === true ? 'lock-closed' : 'arrow-forward'}
                  size={15}
                  color={dependent.isLocked === true ? colors.warning : colors.accent}
                />
                <Txt variant="caption" style={{ flex: 1 }} numberOfLines={1}>
                  {dependent.title}
                </Txt>
                <Ionicons name="chevron-forward" size={14} color={colors.textTertiary} />
              </LinkRow>
            </View>
          ))}
        </Card>
      )}
    </Section>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  actions: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    minHeight: 44,
    paddingHorizontal: 12,
  },
});
