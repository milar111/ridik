import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';

import { freezeClock } from '@/core/clock';
import { DateTime, setZoneOverride } from '@/core/time';
import type { Task } from '@/db/schema';
import { ToastProvider } from '@/ui/components';
import { ThemeProvider } from '@/ui/ThemeProvider';

import TasksScreen from '../../../../app/tasks';

jest.mock('@/hooks', () => ({
  useActiveTasks: jest.fn(),
  useTasks: jest.fn(),
  useProjects: jest.fn(),
  useTaskGraph: jest.fn(),
  useTask: jest.fn(),
  useTaskBlockers: jest.fn(),
  useTaskDependents: jest.fn(),
  useCompleteTask: jest.fn(),
  useUncompleteTask: jest.fn(),
  useUpdateTask: jest.fn(),
  useDeleteTask: jest.fn(),
  useAddTaskDependencies: jest.fn(),
  useRemoveTaskDependency: jest.fn(),
}));

const hooks = jest.requireMock('@/hooks') as Record<string, jest.Mock>;

const ZONE = 'Europe/Sofia';

/*
 * The fixtures are built in ZONE and the screen renders in whatever
 * `currentZone()` says, which is the *device's* unless something overrides it.
 * On this machine those happen to agree; on a CI runner, which is UTC, they do
 * not — "Today 17:30" rendered as 14:30 and the suite failed only there.
 *
 * A test that passes because of where its author lives is worse than no test,
 * and this is an app whose central invariant is that a stored instant never
 * moves. Pinning both ends is the fix.
 */
beforeAll(() => setZoneOverride(ZONE));
afterAll(() => setZoneOverride(null));
const NOW = DateTime.fromISO('2026-08-11T12:00', { zone: ZONE }).toMillis();
const at = (iso: string): number => DateTime.fromISO(iso, { zone: ZONE }).toMillis();

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function task(id: string, title: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title,
    dueDate: null,
    isCompleted: false,
    isLocked: false,
    notes: null,
    priority: 2,
    projectId: null,
    estimatedMinutes: null,
    completedAt: null,
    unlockedAt: null,
    calendarEventId: null,
    source: 'voice',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

const query = (data: unknown, over: Record<string, unknown> = {}) => ({
  data,
  isLoading: false,
  isError: false,
  isRefetching: false,
  isSuccess: true,
  error: null,
  refetch: jest.fn(),
  ...over,
});

/** Every hook the tab and both its sheets reach for, defaulted to "empty". */
function setup(
  over: {
    active?: Task[];
    done?: Task[];
    nodes?: Task[];
    edges?: { parentTaskId: string; childTaskId: string }[];
    graph?: Record<string, unknown>;
  } = {},
) {
  const mutation = () => ({ mutate: jest.fn(), isPending: false });

  hooks.useActiveTasks!.mockReturnValue(query(over.active ?? []));
  hooks.useTasks!.mockReturnValue(query(over.done ?? []));
  hooks.useProjects!.mockReturnValue(query([]));
  hooks.useTaskGraph!.mockReturnValue(
    query({ nodes: over.nodes ?? [], edges: over.edges ?? [] }, over.graph),
  );
  hooks.useTask!.mockReturnValue(query(null));
  hooks.useTaskBlockers!.mockReturnValue(query([]));
  hooks.useTaskDependents!.mockReturnValue(query([]));

  const complete = mutation();
  const remove = mutation();
  hooks.useCompleteTask!.mockReturnValue(complete);
  hooks.useDeleteTask!.mockReturnValue(remove);
  for (const name of [
    'useUncompleteTask',
    'useUpdateTask',
    'useAddTaskDependencies',
    'useRemoveTaskDependency',
  ]) {
    hooks[name]!.mockReturnValue(mutation());
  }
  return { complete, remove };
}

function wrap() {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider forceScheme="dark">
        <ToastProvider>
          <TasksScreen />
        </ToastProvider>
      </ThemeProvider>
    </SafeAreaProvider>,
  );
}

let unfreeze: () => void;

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
  unfreeze = freezeClock(NOW);
});

afterEach(() => {
  unfreeze();
  jest.useRealTimers();
});

describe('Tasks screen', () => {
  it('renders all four views against a completely empty database', async () => {
    setup();
    await wrap();

    expect(screen.getByText('Nothing to do right now')).toBeTruthy();
    expect(screen.getByText('0 tasks ready · 0 blocked')).toBeTruthy();

    // Empty database, so the tab carries no count.
    await fireEvent.press(screen.getByText('Blocked'));
    expect(screen.getByText('Nothing is blocked')).toBeTruthy();

    await fireEvent.press(screen.getByText('Done'));
    expect(screen.getByText('Nothing completed yet')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('Show dependency graph'));
    expect(screen.getByText('No dependency chains yet')).toBeTruthy();
  });

  it('offers a retry instead of an empty graph when the read failed', async () => {
    // A failed read has no data at all — the screen's `?? []` guards must hold.
    setup({
      graph: { data: undefined, isSuccess: false, isError: true, error: new Error('disk is gone') },
    });
    await wrap();

    await fireEvent.press(screen.getByLabelText('Show dependency graph'));
    // The empty state would claim the user has no chains; this one says why.
    expect(screen.queryByText('No dependency chains yet')).toBeNull();
    expect(screen.getByText('Could not load tasks')).toBeTruthy();
  });

  it('groups active work by when it is due', async () => {
    setup({
      active: [
        task('a', 'Order the servos', { dueDate: at('2026-08-09T09:00') }),
        task('b', 'Ring the glazier', { dueDate: at('2026-08-11T17:30') }),
        task('c', 'Sand the frame'),
      ],
    });
    await wrap();

    expect(screen.getByText('OVERDUE')).toBeTruthy();
    expect(screen.getByText('TODAY')).toBeTruthy();
    expect(screen.getByText('NO DATE')).toBeTruthy();
    expect(screen.getByText('Today 17:30')).toBeTruthy();
    expect(screen.getByText('3 tasks ready · 0 blocked')).toBeTruthy();
  });

  it('names what a blocked task waits on and how much of it is done', async () => {
    const print = task('print', 'Print the frame', { isCompleted: true, completedAt: NOW });
    const order = task('order', 'Order the servos');
    const assemble = task('assemble', 'Assemble the robot', { isLocked: true });
    setup({
      nodes: [print, order, assemble],
      edges: [
        { parentTaskId: 'print', childTaskId: 'assemble' },
        { parentTaskId: 'order', childTaskId: 'assemble' },
      ],
    });
    await wrap();

    // The tab carries its own count now: a blocked task leaves Active, and a
    // third segment that says nothing is one nobody presses to find out where
    // the task went — which is exactly the question the dependency feature got
    // back from a real user.
    await fireEvent.press(screen.getByText('Blocked 1'));
    expect(screen.getByText('Assemble the robot')).toBeTruthy();
    expect(screen.getByText('Waiting on:')).toBeTruthy();
    expect(screen.getByText('1/2 done')).toBeTruthy();
  });

  it('reads the whole completed list, so a limit cannot drop what was just finished', async () => {
    setup({ done: [task('d', 'Fit the hinges', { isCompleted: true, completedAt: NOW })] });
    await wrap();

    // A SQL limit here would keep the oldest *due* rows: the repository orders
    // by due date, not by completion. The cap belongs after the sort.
    expect(hooks.useTasks).toHaveBeenCalledWith({ completed: true });

    await fireEvent.press(screen.getByText('Done'));
    expect(screen.getByText('Fit the hinges')).toBeTruthy();
  });

  it('completes a row from its box and announces what that unlocked', async () => {
    const { complete } = setup({ active: [task('t1', 'Order the servos')] });
    complete.mutate.mockImplementation(
      (_id: string, options: { onSuccess: (r: unknown) => void }) =>
        options.onSuccess({
          task: task('t1', 'Order the servos', { isCompleted: true }),
          unlocked: [task('t2', 'Assemble the robot')],
        }),
    );
    await wrap();

    await fireEvent.press(screen.getByTestId('task-t1-box'));

    expect(complete.mutate).toHaveBeenCalledWith('t1', expect.anything());
    // Spec 5.4: the chain is invisible until this moment, so it announces itself.
    expect(screen.getByText('Unlocked next step')).toBeTruthy();
    expect(screen.getByText('Assemble the robot')).toBeTruthy();
  });

  /** Three verbs and nothing that edits: a long press cannot destroy a task. */
  it('holds only complete, snooze and open details in the long-press menu', async () => {
    setup({ active: [task('t1', 'Order the servos')] });
    hooks.useTask!.mockReturnValue(query(task('t1', 'Order the servos')));
    await wrap();

    await fireEvent(screen.getByLabelText('Order the servos'), 'longPress');

    expect(screen.getByText('Complete')).toBeTruthy();
    expect(screen.getByText('Snooze to tomorrow')).toBeTruthy();
    expect(screen.getByText('Open details')).toBeTruthy();
    expect(screen.queryByText('Delete')).toBeNull();
    expect(screen.queryByText('DUE')).toBeNull();

    /*
     * The menu lost the controls, not the app: this is the tap that still
     * reaches them, and it is the only one left that does.
     *
     * It used to check for PRIORITY, which the sheet no longer has — priority,
     * estimate, project and notes are all set by voice now and none of them
     * earns a control. What has to survive that cut is asserted instead: the
     * deadline, which is what the whole screen buckets by, and the delete,
     * which is the one destructive act with nowhere else to live.
     */
    await fireEvent.press(screen.getByLabelText('Open details'));
    expect(screen.getByText('DUE')).toBeTruthy();
    expect(screen.getByText('Delete task')).toBeTruthy();
    // And the four that went, stay gone.
    expect(screen.queryByText('PRIORITY')).toBeNull();
    expect(screen.queryByText('ESTIMATE')).toBeNull();
    expect(screen.queryByText('PROJECT')).toBeNull();
    expect(screen.queryByText('Notes')).toBeNull();
  });

  /**
   * The delete used to be "tap again" on a button that relabelled itself under
   * the finger. The confirmation is its own target now, as it is on an event.
   */
  it('confirms a delete beside the button, not on top of it', async () => {
    const { remove } = setup({ active: [task('t1', 'Order the servos')] });
    hooks.useTask!.mockReturnValue(query(task('t1', 'Order the servos')));
    await wrap();

    await fireEvent.press(screen.getByLabelText('Order the servos'));
    await fireEvent.press(screen.getByText('Delete task'));

    expect(remove.mutate).not.toHaveBeenCalled();
    expect(screen.queryByText('Tap again to delete')).toBeNull();
    expect(screen.getByText(/This cannot be undone/)).toBeTruthy();

    await fireEvent.press(screen.getByTestId('task-delete-confirm'));
    expect(remove.mutate).toHaveBeenCalledWith('t1', expect.anything());
  });
});
