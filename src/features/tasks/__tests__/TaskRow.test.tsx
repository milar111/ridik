import { fireEvent, render, screen } from '@testing-library/react-native';

import { startOfDay } from '@/core/time';
import type { Task } from '@/db/schema';
import { ThemeProvider } from '@/ui/ThemeProvider';

import { DependencyGraph } from '../DependencyGraph';
import { TaskRow } from '../TaskRow';

// RNTL 14 renders asynchronously; every render/press must be awaited.
function wrap(ui: React.ReactElement) {
  return render(<ThemeProvider forceScheme="dark">{ui}</ThemeProvider>);
}

function task(extra: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'Order the servos',
    dueDate: null,
    isCompleted: false,
    isLocked: false,
    createdAt: 0,
    notes: null,
    projectId: 'p1',
    priority: 2,
    estimatedMinutes: 30,
    completedAt: null,
    unlockedAt: null,
    calendarEventId: null,
    source: 'voice',
    updatedAt: 0,
    ...extra,
  };
}

describe('TaskRow', () => {
  it('shows the title and its due, project and estimate metadata', async () => {
    await wrap(
      <TaskRow
        task={task({ dueDate: startOfDay(Date.now()) })}
        projectName="Robot"
        onToggle={jest.fn()}
        onOpen={jest.fn()}
        onQuickActions={jest.fn()}
      />,
    );

    expect(screen.getByText('Order the servos')).toBeTruthy();
    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getByText('Robot')).toBeTruthy();
    expect(screen.getByText('30m')).toBeTruthy();
  });

  it('keeps the box, the row and the long press as three separate actions', async () => {
    const onToggle = jest.fn();
    const onOpen = jest.fn();
    const onQuickActions = jest.fn();
    await wrap(
      <TaskRow
        task={task()}
        testID="row"
        onToggle={onToggle}
        onOpen={onOpen}
        onQuickActions={onQuickActions}
      />,
    );

    await fireEvent.press(screen.getByTestId('row-box'));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('row'));
    expect(onOpen).toHaveBeenCalledTimes(1);

    await fireEvent(screen.getByTestId('row'), 'longPress');
    expect(onQuickActions).toHaveBeenCalledTimes(1);
  });

  it('reports completion state to accessibility', async () => {
    await wrap(
      <TaskRow
        task={task({ isCompleted: true, completedAt: 1 })}
        testID="row"
        onToggle={jest.fn()}
        onOpen={jest.fn()}
        onQuickActions={jest.fn()}
      />,
    );
    expect(screen.getByTestId('row-box').props.accessibilityState).toMatchObject({ checked: true });
  });
});

describe('DependencyGraph', () => {
  it('teaches the user how to create a chain when there is none', async () => {
    await wrap(<DependencyGraph nodes={[task()]} edges={[]} onOpen={jest.fn()} />);
    expect(screen.getByText('No dependency chains yet')).toBeTruthy();
  });

  it('draws a node per linked task and opens the one that was tapped', async () => {
    const onOpen = jest.fn();
    const print = task({ id: 'print', title: 'Print frame' });
    const assemble = task({ id: 'assemble', title: 'Assemble' });
    await wrap(
      <DependencyGraph
        nodes={[print, assemble]}
        edges={[{ parentTaskId: 'print', childTaskId: 'assemble' }]}
        onOpen={onOpen}
      />,
    );

    await fireEvent.press(screen.getByTestId('graph-node-assemble'));
    expect(onOpen).toHaveBeenCalledWith(assemble);
  });
});
