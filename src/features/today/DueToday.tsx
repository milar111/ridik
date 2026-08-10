import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import { countLabel, truncate } from '@/core/format';
import { calendarDaysBetween, epochToLocal, formatTime } from '@/core/time';
import type { Task } from '@/db/schema';
import { invalidateKeys, qk, useCompleteTask } from '@/hooks';
import { Badge, Checkbox, Divider, Txt, useToast } from '@/ui/components';

/** Inside this window the clock is worth colouring; before it, it is metadata. */
const DUE_SOON_MS = 2 * 60 * 60_000;

type Row = { task: Task; /** Missed a previous day, not merely a time today. */ late: boolean };

/**
 * Everything with a deadline that has already passed or passes tonight.
 *
 * The checkbox is the whole interaction: one tap completes the task, the
 * optimistic patch inside `useCompleteTask` strikes it through before the write
 * lands, and if finishing it freed a blocked step the toast says which one. The
 * dependency chain is invisible until exactly this moment, so this is where the
 * app has to explain itself.
 */
export function DueToday({
  overdue,
  due,
  now,
  zone,
}: {
  overdue: readonly Task[];
  due: readonly Task[];
  now: number;
  zone: string;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const complete = useCompleteTask();
  // Local, not cache: the row has to strike through in *this list* the instant
  // it is ticked, and it belongs to another query's snapshot.
  const [done, setDone] = useState<ReadonlySet<string>>(() => new Set());

  const onComplete = useCallback(
    (task: Task) => {
      setDone((prev) => new Set(prev).add(task.id));
      complete.mutate(task.id, {
        // `useCompleteTask` refreshes the day; the briefing card sitting above
        // this list is composed from the same tasks, and a bullet still calling
        // this one overdue while the row is struck through is the screen
        // arguing with itself.
        onSettled: () => void invalidateKeys(client, [qk.briefing.all]),
        onSuccess: (result) => {
          const [first, ...rest] = result.unlocked;
          if (!first) return;
          toast.show({
            message: `Unlocked next step: ${first.title}`,
            detail: rest.length > 0 ? `and ${countLabel(rest.length, 'more', 'more')}` : undefined,
            tone: 'accent',
          });
        },
        onError: (error) => {
          setDone((prev) => {
            const next = new Set(prev);
            next.delete(task.id);
            return next;
          });
          toast.show({
            message: `Could not complete “${truncate(task.title, 40)}”`,
            detail: error.message,
            tone: 'danger',
          });
        },
      });
    },
    [client, complete, toast],
  );

  const rows: Row[] = [
    ...overdue.map((task) => ({ task, late: true })),
    ...due.map((task) => ({ task, late: false })),
  ];

  return (
    <View>
      {rows.map(({ task, late }, index) => (
        <View key={task.id}>
          {index > 0 ? <Divider inset={31} /> : null}
          <TaskRow
            task={task}
            late={late}
            checked={done.has(task.id)}
            now={now}
            zone={zone}
            onComplete={onComplete}
          />
        </View>
      ))}
    </View>
  );
}

function TaskRow({
  task,
  late,
  checked,
  now,
  zone,
  onComplete,
}: {
  task: Task;
  late: boolean;
  checked: boolean;
  now: number;
  zone: string;
  onComplete: (task: Task) => void;
}) {
  // Whole calendar days, so "yesterday at 23:00" is one day late rather than
  // the handful of hours a subtraction would report.
  const days = late && task.dueDate != null ? Math.max(1, calendarDaysBetween(task.dueDate, now, zone)) : 0;

  return (
    <Checkbox
      testID={`due-${task.id}`}
      checked={checked}
      onToggle={() => {
        if (!checked) onComplete(task);
      }}
      label={task.title}
      sublabel={task.notes ? truncate(task.notes, 64) : undefined}
      // The urgency is rendered to the right of the row, so it has to be spoken
      // explicitly or a screen reader hears an ordinary task.
      accessibilityLabel={[
        task.title,
        late
          ? `${countLabel(days, 'day')} late`
          : task.dueDate != null
            ? `due ${formatTime(task.dueDate, zone)}`
            : null,
      ]
        .filter(Boolean)
        .join(', ')}
      right={
        late ? (
          <Badge label={`${countLabel(days, 'day')} late`} tone="danger" />
        ) : (
          <DueClock dueDate={task.dueDate} zone={zone} now={now} />
        )
      }
    />
  );
}

/**
 * A midnight due date is a date, not a deadline — rendering "00:00" invents a
 * precision the user never gave, so those rows show nothing at all.
 */
function DueClock({ dueDate, zone, now }: { dueDate: number | null; zone: string; now: number }) {
  if (dueDate == null) return null;
  const local = epochToLocal(dueDate, zone);
  if (local.hour === 0 && local.minute === 0) return null;

  const tone = dueDate < now ? 'danger' : dueDate - now <= DUE_SOON_MS ? 'warning' : 'tertiary';
  return (
    <Txt variant="mono" tone={tone}>
      {formatTime(dueDate, zone)}
    </Txt>
  );
}
