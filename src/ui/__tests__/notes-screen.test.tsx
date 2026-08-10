import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';

import { ThemeProvider } from '../ThemeProvider';
import NotesScreen from '../../../app/(tabs)/notes';

// The component barrel reaches Toast, which reaches reanimated — and reanimated's
// own mock still loads the native worklets module, so the entry animations Toast
// asks for are stubbed by hand instead.
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
}));

jest.mock('@/hooks', () => ({
  useNotes: jest.fn(),
  useNoteTags: jest.fn(),
  useNoteSearch: jest.fn(),
  useUpdateNote: jest.fn(),
  useArchiveNote: jest.fn(),
  useDeleteNote: jest.fn(),
  useChecklistNames: jest.fn(),
  useChecklistItems: jest.fn(),
  useToggleChecklistItem: jest.fn(),
  useAddChecklistItems: jest.fn(),
  useClearCompletedChecklistItems: jest.fn(),
  useRemoveChecklistItem: jest.fn(),
}));

type Mocks = Record<string, jest.Mock>;
const hooks = jest.requireMock('@/hooks') as Mocks;

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

function note(
  title: string,
  tag: string,
  bullets: string[],
  over: { id?: string; pinned?: boolean } = {},
) {
  const id = over.id ?? title.toLowerCase().replace(/\s+/g, '-');
  return {
    id,
    titleSummary: title,
    categoryTag: tag,
    createdAt: 0,
    updatedAt: 1_700_000_000_000,
    projectId: null,
    isPinned: over.pinned ?? false,
    isArchived: false,
    bullets: bullets.map((content, index) => ({
      id: `${id}-${index}`,
      noteId: id,
      content,
      orderIndex: index,
      bulletKind: 'text' as const,
      isCompleted: false,
      createdAt: 0,
    })),
  };
}

function item(listName: string, text: string, over: { id?: string; done?: boolean } = {}) {
  return {
    id: over.id ?? text.toLowerCase(),
    listName,
    itemText: text,
    isCompleted: over.done ?? false,
    createdAt: 0,
    quantity: null,
    projectId: null,
    orderIndex: 0,
    completedAt: null,
  };
}

function setup(
  over: {
    notes?: unknown[];
    tags?: unknown[];
    hits?: unknown[];
    lists?: unknown[];
    items?: unknown[];
  } = {},
) {
  const mutation = () => ({ mutate: jest.fn(), isPending: false });

  hooks.useNotes!.mockReturnValue(query(over.notes ?? []));
  hooks.useNoteTags!.mockReturnValue(query(over.tags ?? []));
  hooks.useNoteSearch!.mockReturnValue(query(over.hits ?? []));
  hooks.useChecklistNames!.mockReturnValue(query(over.lists ?? []));
  hooks.useChecklistItems!.mockReturnValue(query(over.items ?? []));

  const toggle = mutation();
  hooks.useToggleChecklistItem!.mockReturnValue(toggle);
  for (const name of [
    'useUpdateNote',
    'useArchiveNote',
    'useDeleteNote',
    'useAddChecklistItems',
    'useClearCompletedChecklistItems',
    'useRemoveChecklistItem',
  ]) {
    hooks[name]!.mockReturnValue(mutation());
  }
  return { toggle };
}

function wrap(ui: React.ReactElement) {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider forceScheme="dark">{ui}</ThemeProvider>
    </SafeAreaProvider>,
  );
}

describe('notes screen', () => {
  it('teaches the user what to say when there are no notes', async () => {
    setup();
    await wrap(<NotesScreen />);
    expect(screen.getByText(/note under hardware/)).toBeTruthy();
  });

  it('shows the tag, the first two bullets and the bullet count', async () => {
    setup({
      notes: [note('Robotics', 'hardware', ['M3 screws', '20mm standoffs', 'order Thursday'])],
      tags: [{ tag: 'hardware', count: 1 }],
    });
    await wrap(<NotesScreen />);

    expect(screen.getByText('Robotics')).toBeTruthy();
    expect(screen.getByText('hardware 1')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('+1 more')).toBeTruthy();
  });

  it('swaps the list for search hits once the field settles', async () => {
    setup({
      notes: [note('Browse note', 'hardware', ['a'])],
      hits: [{ note: note('Search hit', 'hardware', ['b']), score: 1 }],
    });
    await wrap(<NotesScreen />);
    expect(screen.getByText('Browse note')).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText('Search notes'), 'screw');

    // The field is debounced, so the swap is deliberately not synchronous.
    await waitFor(() => expect(screen.getByText('Search hit')).toBeTruthy());
    expect(screen.queryByText('Browse note')).toBeNull();
  });

  it('opens the first list and ticks an item off by its words', async () => {
    const { toggle } = setup({
      lists: [{ name: 'Shopping', open: 2, total: 3 }],
      items: [item('Shopping', 'Milk', { id: 'i1' }), item('Shopping', 'Bread', { id: 'i2' })],
    });
    await wrap(<NotesScreen />);
    await fireEvent.press(screen.getByText('Lists'));

    expect(screen.getByText('Shopping')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Milk'));

    expect(toggle.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ listName: 'Shopping', itemQuery: 'Milk', completed: true, itemId: 'i1' }),
      expect.anything(),
    );
  });
});
