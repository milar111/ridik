/**
 * Render tests for the two project routes.
 *
 * Mocked at the hook boundary: the screens' contract is "given this overview,
 * show these rows and call these mutations", and the real repositories would
 * drag SQLite into a render test.
 */
import { render, screen, fireEvent } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { Project, ProjectItem, ProjectSection } from '@/db/schema';
import type { ProjectOverview } from '@/repositories/projects';
import type { ColorScheme } from '@/ui/theme';
import { ThemeProvider } from '@/ui/ThemeProvider';

import ProjectsScreen from '../../../../app/projects';
import ProjectDetailScreen from '../../../../app/project/[id]';

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockToggle = jest.fn();
const mockAdd = jest.fn();
const mockMove = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack }),
  useLocalSearchParams: () => ({ id: 'p1' }),
}));

// Sharing pulls in expo-print and the mail composer; neither has a native side
// under jest and neither is what these tests are about.
jest.mock('@/features/export', () => ({
  projectMarkdown: () => '# markdown',
  shareAsFile: async () => ({ ok: true, value: { uri: 'file://x', shared: true } }),
  copyToClipboard: async () => ({ ok: true, value: undefined }),
}));

type QueryLike = {
  data: unknown;
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  error: unknown;
  refetch: () => void;
};

const idle = (data: unknown): QueryLike => ({
  data,
  isPending: false,
  isError: false,
  isFetching: false,
  error: null,
  refetch: jest.fn(),
});

let mockSummariesQuery: QueryLike = idle([]);
let mockOverviewQuery: QueryLike = idle(null);

jest.mock('@/hooks', () => ({
  useProjectSummaries: () => mockSummariesQuery,
  useProjectOverview: () => mockOverviewQuery,
  useCreateProject: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useSetProjectStatus: () => ({ mutate: jest.fn(), isPending: false }),
  useArchiveProject: () => ({ mutate: jest.fn(), isPending: false }),
  useToggleProjectItem: () => ({ mutate: mockToggle, isPending: false }),
  useAddProjectItems: () => ({ mutate: mockAdd, isPending: false }),
  useUpdateProjectItem: () => ({ mutate: jest.fn(), isPending: false }),
  useMoveProjectItem: () => ({ mutate: mockMove, isPending: false }),
  useReorderProjectItems: () => ({ mutate: mockReorder, isPending: false }),
  useDeleteProjectItem: () => ({ mutate: jest.fn(), isPending: false }),
  useDeleteProject: () => ({ mutate: jest.fn(), isPending: false }),
}));

const mockReorder = jest.fn();

const AT = 1_700_000_000_000;

function project(patch: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Japan trip',
    kind: 'trip',
    description: null,
    status: 'active',
    startDate: null,
    targetDate: null,
    color: null,
    emoji: '✈️',
    createdAt: AT,
    updatedAt: AT,
    ...patch,
  };
}

function item(patch: Partial<ProjectItem> = {}): ProjectItem {
  return {
    id: 'i1',
    projectId: 'p1',
    sectionId: null,
    kind: 'todo',
    content: 'Pack slippers',
    detail: null,
    isCheckbox: true,
    isCompleted: false,
    completedAt: null,
    orderIndex: 0,
    dueDate: null,
    createdAt: AT,
    updatedAt: AT,
    ...patch,
  };
}

function overview(patch: Partial<ProjectOverview> = {}): ProjectOverview {
  return {
    project: project(),
    sections: [{ section: null, items: [item()] }],
    counts: { total: 1, done: 0, openTodos: 1 },
    linked: { tasks: [], notes: [], checklists: [], transactions: [] },
    ...patch,
  };
}

// Without explicit metrics the provider waits for a native layout event that
// never arrives under jest, and renders nothing at all.
const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function wrap(ui: React.ReactElement, scheme: ColorScheme = 'dark') {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider forceScheme={scheme}>{ui}</ThemeProvider>
    </SafeAreaProvider>,
  );
}

function section(patch: Partial<ProjectSection> = {}): ProjectSection {
  return {
    id: 's1',
    projectId: 'p1',
    title: 'Packing',
    orderIndex: 0,
    createdAt: AT,
    ...patch,
  };
}

beforeEach(() => {
  mockSummariesQuery = idle([]);
  mockOverviewQuery = idle(null);
});

describe('projects list', () => {
  it('teaches the voice path when there is nothing yet', async () => {
    await wrap(<ProjectsScreen />);
    expect(screen.getByText('No projects yet')).toBeTruthy();
    expect(
      screen.getByText(/for my Japan trip, remind me to pack slippers/),
    ).toBeTruthy();
  });

  it('groups projects by status and opens one on tap', async () => {
    mockSummariesQuery = idle([
      { project: project(), counts: { total: 4, done: 1, openTodos: 3 } },
      {
        project: project({ id: 'p2', name: 'Kitchen', status: 'paused', emoji: null }),
        counts: { total: 0, done: 0, openTodos: 0 },
      },
    ]);
    await wrap(<ProjectsScreen />);

    expect(screen.getByText('ACTIVE · 1')).toBeTruthy();
    expect(screen.getByText('PAUSED · 1')).toBeTruthy();
    expect(screen.getByText('1/4 done · 3 open')).toBeTruthy();
    expect(screen.getByText('Empty')).toBeTruthy();

    await fireEvent.press(screen.getByText('Japan trip'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/project/[id]', params: { id: 'p1' } });
  });
});

describe('project detail', () => {
  it('renders the items and ticks one optimistically', async () => {
    mockOverviewQuery = idle(overview());
    await wrap(<ProjectDetailScreen />);

    expect(screen.getByText('Japan trip')).toBeTruthy();
    expect(screen.getByText('0 of 1 done · 1 still open')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('project-item-i1'));
    expect(mockToggle).toHaveBeenCalledWith(
      { itemId: 'i1', completed: true },
      expect.anything(),
    );
  });

  it('adds a typed item to the project', async () => {
    mockOverviewQuery = idle(overview());
    await wrap(<ProjectDetailScreen />);

    await fireEvent.changeText(screen.getByTestId('project-add-input'), 'Buy sunscreen');
    await fireEvent.press(screen.getByTestId('project-add-submit'));

    expect(mockAdd).toHaveBeenCalledWith(
      {
        projectId: 'p1',
        items: [
          {
            content: 'Buy sunscreen',
            kind: 'todo',
            isCheckbox: true,
            sectionTitle: null,
          },
        ],
      },
      expect.anything(),
    );
  });

  it('shows the linked tab with its own empty coaching', async () => {
    mockOverviewQuery = idle(overview());
    await wrap(<ProjectDetailScreen />);

    await fireEvent.press(screen.getByText('Linked · 0'));
    expect(screen.getByText('Nothing filed against this project yet')).toBeTruthy();
  });

  it('says so when the project is gone', async () => {
    mockOverviewQuery = idle(null);
    await wrap(<ProjectDetailScreen />);
    expect(screen.getByText('This project is gone')).toBeTruthy();
  });

  /**
   * A section the user has emptied still comes back from the overview, so the
   * group has to draw itself with no rows rather than collapse to nothing.
   */
  it('draws a section that has been emptied', async () => {
    mockOverviewQuery = idle(
      overview({
        sections: [
          { section: null, items: [item()] },
          { section: section({ id: 's2', title: 'Empty one' }), items: [] },
        ],
      }),
    );
    await wrap(<ProjectDetailScreen />);
    expect(screen.getByText('EMPTY ONE')).toBeTruthy();
    expect(screen.getByText('Nothing here yet.')).toBeTruthy();
  });

  it('walks the item menu into the move-to-section menu', async () => {
    mockOverviewQuery = idle(
      overview({
        sections: [
          { section: null, items: [item({ isCheckbox: false, kind: 'idea' })] },
          { section: section(), items: [] },
        ],
      }),
    );
    await wrap(<ProjectDetailScreen />);

    await fireEvent.press(screen.getByTestId('project-item-i1'));
    await fireEvent.press(screen.getByText('Move to section…'));
    await fireEvent.press(screen.getByText('Packing'));

    expect(mockMove).toHaveBeenCalledWith({ itemId: 'i1', sectionId: 's1' }, expect.anything());
  });

  /**
   * Nobody reorders a project list, and the arrows sat one row above Delete.
   * The repository can still reorder; the menu no longer offers it.
   */
  /*
   * Reordering survives the deletion of the up/down pair, as one option. The
   * pair was a lot of taps for a list nobody sorts precisely, and it sat
   * directly above Delete; "bring this to the top" is what it was really for.
   */
  it('reorders by moving an item to the top, not a row at a time', async () => {
    mockOverviewQuery = idle(
      overview({
        sections: [{ section: null, items: [item(), item({ id: 'i2', content: 'Second' })] }],
        counts: { total: 2, done: 0, openTodos: 2 },
      }),
    );
    await wrap(<ProjectDetailScreen />);

    await fireEvent.press(screen.getByLabelText('Actions for Second'));
    expect(screen.queryByText('Move up')).toBeNull();
    expect(screen.queryByText('Move down')).toBeNull();
    expect(screen.getByText('Move to section…')).toBeTruthy();

    await fireEvent.press(screen.getByText('Move to top'));
    expect(mockReorder).toHaveBeenCalledWith(
      { projectId: 'p1', orderedIds: ['i2', 'i1'] },
      expect.anything(),
    );
  });

  /** Sharing is the header icon; the menu carried a second copy of it. */
  it('keeps the project menu to status and delete', async () => {
    mockOverviewQuery = idle(overview());
    await wrap(<ProjectDetailScreen />);

    await fireEvent.press(screen.getByTestId('project-menu'));

    expect(screen.queryByText('Share as markdown')).toBeNull();
    expect(screen.getByText('Mark active')).toBeTruthy();
    expect(screen.getByText('Delete project')).toBeTruthy();
    expect(screen.getByTestId('project-share')).toBeTruthy();
    // The four statuses are one radio group; the rule is what stops the
    // irreversible option reading as a fifth thing the project could be.
    expect(screen.getByTestId('rule-above-Delete project')).toBeTruthy();
  });

  /**
   * Light mode is the theme nobody develops in, so it is the one a hard-coded
   * colour survives in. Rendering the densest screen there is the cheapest guard.
   */
  it('renders every linked kind, in light mode', async () => {
    mockOverviewQuery = idle(
      overview({
        project: project({ targetDate: AT, description: 'Two weeks in September' }),
        linked: {
          tasks: [{ id: 't1', title: 'Book flights', isCompleted: false, isLocked: true } as never],
          notes: [{ id: 'n1', titleSummary: 'Visa rules', categoryTag: 'travel' } as never],
          checklists: [
            { id: 'c1', itemText: 'Adapter', quantity: 2, listName: 'Packing' } as never,
          ],
          transactions: [
            {
              id: 'x1',
              amount: 40,
              currency: 'EUR',
              category: 'food',
              description: null,
              direction: 'expense',
              createdAt: AT,
            } as never,
          ],
        },
      }),
    );
    await wrap(<ProjectDetailScreen />, 'light');

    await fireEvent.press(screen.getByText('Linked · 4'));
    expect(screen.getByText('Book flights')).toBeTruthy();
    expect(screen.getByText('Adapter ×2')).toBeTruthy();
    // The money card's net, and the row it came from.
    expect(screen.getAllByText('−€40.00')).toHaveLength(2);
    expect(screen.getByText(/€40\.00 out/)).toBeTruthy();

    // Every row leads back to the screen that owns it.
    await fireEvent.press(screen.getByText('Visa rules'));
    expect(mockPush).toHaveBeenCalledWith('/note/n1');

    // Checklists have no screen of their own; the row must name the pane and
    // the list, or it lands back on the dead `/checklists`.
    await fireEvent.press(screen.getByText('Adapter ×2'));
    expect(mockPush).toHaveBeenCalledWith('/notes?pane=lists&list=Packing');
  });
});
