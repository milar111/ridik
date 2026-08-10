import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';

import { ThemeProvider } from '../ThemeProvider';
import NoteDetailScreen from '../../../app/note/[id]';
import ChecklistsScreen from '../../../app/checklists';

jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native');
  const builder: { duration: () => unknown } = { duration: () => builder };
  return {
    __esModule: true,
    default: { View },
    FadeInUp: builder,
    FadeOutUp: builder,
    LinearTransition: builder,
  };
});

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true }),
  useLocalSearchParams: () => jest.requireMock('expo-router').__params,
  __params: {} as Record<string, string>,
}));

// The share path is the only thing in these screens that touches the native
// export stack; the screens themselves are what is under test.
jest.mock('@/features/export', () => ({
  escapeMarkdown: (text: string) => text,
  shareAsFile: jest.fn(async () => ({ ok: true, value: { uri: 'file://x', shared: true } })),
  copyToClipboard: jest.fn(async () => ({ ok: true, value: undefined })),
}));

jest.mock('@/hooks', () => ({
  useNote: jest.fn(),
  useUpdateNote: jest.fn(),
  useArchiveNote: jest.fn(),
  useDeleteNote: jest.fn(),
  useNoteTags: jest.fn(),
  useAppendNoteBullets: jest.fn(),
  useToggleNoteBullet: jest.fn(),
  useUpdateNoteBullet: jest.fn(),
  useRemoveNoteBullet: jest.fn(),
  useReorderNoteBullets: jest.fn(),
  useChecklistNames: jest.fn(),
  useChecklistItems: jest.fn(),
  useToggleChecklistItem: jest.fn(),
  useAddChecklistItems: jest.fn(),
  useClearCompletedChecklistItems: jest.fn(),
  useRemoveChecklistItem: jest.fn(),
}));

type Mocks = Record<string, jest.Mock>;
const hooks = jest.requireMock('@/hooks') as Mocks;
const router = jest.requireMock('expo-router') as { __params: Record<string, string> };

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const query = (data: unknown) => ({
  data,
  isPending: false,
  isFetching: false,
  error: null,
  refetch: jest.fn(),
});

function bullet(id: string, content: string, kind: 'text' | 'todo', done = false) {
  return {
    id,
    noteId: 'n1',
    content,
    orderIndex: Number(id.slice(1)),
    bulletKind: kind,
    isCompleted: done,
    createdAt: 0,
  };
}

function setup(data: unknown) {
  const mutations: Mocks = {};
  for (const name of Object.keys(hooks)) {
    if (name.startsWith('useNote') || name === 'useChecklistNames' || name === 'useChecklistItems') {
      continue;
    }
    const mutate = jest.fn();
    mutations[name] = mutate;
    hooks[name]!.mockReturnValue({ mutate, isPending: false });
  }
  hooks.useNote!.mockReturnValue(query(data));
  hooks.useNoteTags!.mockReturnValue(query([]));
  hooks.useChecklistNames!.mockReturnValue(query([{ name: 'Shopping', open: 1, total: 2 }]));
  hooks.useChecklistItems!.mockReturnValue(
    query([
      { id: 'b', listName: 'Shopping', itemText: 'Bread', isCompleted: true, createdAt: 0, quantity: null, projectId: null, orderIndex: 1, completedAt: 1 },
      { id: 'm', listName: 'Shopping', itemText: 'Milk', isCompleted: false, createdAt: 0, quantity: '2', projectId: null, orderIndex: 0, completedAt: null },
    ]),
  );
  return mutations;
}

function wrap(ui: React.ReactElement) {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider forceScheme="dark">{ui}</ThemeProvider>
    </SafeAreaProvider>,
  );
}

const NOTE = {
  id: 'n1',
  titleSummary: 'Robotics',
  categoryTag: 'hardware',
  createdAt: 0,
  updatedAt: 0,
  projectId: null,
  isPinned: false,
  isArchived: false,
  bullets: [bullet('b0', 'M3 screws', 'text'), bullet('b1', 'Order standoffs', 'todo')],
};

describe('note detail screen', () => {
  beforeEach(() => {
    router.__params = { id: 'n1' };
  });

  it('renders the editable title and both bullet shapes', async () => {
    setup(NOTE);
    await wrap(<NoteDetailScreen />);

    expect(screen.getByLabelText('Note title').props.value).toBe('Robotics');
    expect(screen.getByLabelText('Note tag').props.value).toBe('hardware');
    expect(screen.getByText('M3 screws')).toBeTruthy();
    // The todo bullet is a checkbox; the plain one is not.
    expect(screen.getByLabelText('Order standoffs').props.accessibilityState).toMatchObject({
      checked: false,
    });
  });

  it('ticks a todo bullet off', async () => {
    const mutations = setup(NOTE);
    await wrap(<NoteDetailScreen />);

    await fireEvent.press(screen.getByLabelText('Order standoffs'));
    expect(mutations.useToggleNoteBullet).toHaveBeenCalledWith(
      { bulletId: 'b1', completed: true },
      expect.anything(),
    );
  });

  it('appends a bullet from the composer', async () => {
    const mutations = setup(NOTE);
    await wrap(<NoteDetailScreen />);

    await fireEvent.changeText(screen.getByLabelText('Add a bullet'), 'Cable ties');
    await fireEvent.press(screen.getByLabelText('Add bullet'));

    expect(mutations.useAppendNoteBullets).toHaveBeenCalledWith(
      { noteId: 'n1', contents: ['Cable ties'], kind: 'text' },
      expect.anything(),
    );
  });

  it('says so when the note has gone', async () => {
    setup(null);
    await wrap(<NoteDetailScreen />);
    expect(screen.getByText('That note is gone')).toBeTruthy();
  });
});

describe('checklists screen', () => {
  it('expands every list and sinks completed items to the bottom', async () => {
    setup(NOTE);
    router.__params = {};
    await wrap(<ChecklistsScreen />);

    expect(screen.getByText('1 list · 1 still open')).toBeTruthy();
    const rows = screen.getAllByRole('checkbox');
    expect(rows[0]?.props.accessibilityLabel).toBe('Milk');
    expect(rows[1]?.props.accessibilityLabel).toBe('Bread');
    expect(screen.getByText('Clear 1 done')).toBeTruthy();
  });
});
