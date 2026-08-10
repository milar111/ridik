import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';

import { ThemeProvider } from '../ThemeProvider';
import NoteDetailScreen from '../../../app/note/[id]';

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
    if (name.startsWith('useNote')) continue;
    const mutate = jest.fn();
    mutations[name] = mutate;
    hooks[name]!.mockReturnValue({ mutate, isPending: false });
  }
  hooks.useNote!.mockReturnValue(query(data));
  hooks.useNoteTags!.mockReturnValue(query([]));
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
    expect(screen.getByText('M3 screws')).toBeTruthy();
    // The todo bullet is a checkbox; the plain one is not.
    expect(screen.getByLabelText('Order standoffs').props.accessibilityState).toMatchObject({
      checked: false,
    });
  });

  /**
   * The tag is the note's grouping key and half of the unique (title, tag)
   * pair, so it cannot be typed over in place: the chip only opens the picker.
   */
  it('changes the tag through the picker, not a text field', async () => {
    const mutations = setup(NOTE);
    hooks.useNoteTags!.mockReturnValue(query([{ tag: 'travel', count: 2 }]));
    await wrap(<NoteDetailScreen />);

    expect(screen.queryByLabelText('Note tag')).toBeNull();

    await fireEvent.press(screen.getByLabelText('hardware'));
    expect(screen.getByText('Change tag')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('travel'));
    expect(mutations.useUpdateNote).toHaveBeenCalledWith(
      { id: 'n1', patch: { categoryTag: 'travel' } },
      expect.anything(),
    );
  });

  /**
   * The bulk "turn N bullets into todos" wrote to every plain bullet from a
   * menu row that never said which ones. Promotion is per bullet now, on the
   * row it changes.
   */
  it('offers no bulk edit in the note menu', async () => {
    setup(NOTE);
    await wrap(<NoteDetailScreen />);

    // The plain bullet is still promoted, one row at a time.
    await fireEvent.press(screen.getByLabelText('Actions for M3 screws'));
    expect(screen.getByLabelText('Make this a todo')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('Note actions'));

    expect(screen.getByText('Share')).toBeTruthy();
    expect(screen.queryByText(/into todos/)).toBeNull();
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
