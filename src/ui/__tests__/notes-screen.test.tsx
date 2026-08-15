import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';

import { ThemeProvider } from '../ThemeProvider';
import NotesScreen from '../../../app/notes';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true }),
  useLocalSearchParams: () => jest.requireMock('expo-router').__params,
  __params: {} as Record<string, string>,
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
  const clear = mutation();
  const remove = mutation();
  hooks.useToggleChecklistItem!.mockReturnValue(toggle);
  hooks.useClearCompletedChecklistItems!.mockReturnValue(clear);
  hooks.useRemoveChecklistItem!.mockReturnValue(remove);
  for (const name of ['useUpdateNote', 'useArchiveNote', 'useDeleteNote', 'useAddChecklistItems']) {
    hooks[name]!.mockReturnValue(mutation());
  }
  return { toggle, clear, remove };
}

function wrap(ui: React.ReactElement) {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider forceScheme="dark">{ui}</ThemeProvider>
    </SafeAreaProvider>,
  );
}

describe('notes screen', () => {
  beforeEach(() => {
    router.__params = {};
  });

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

/* ------------------------------------------------------------------ lists -- */

describe('lists pane', () => {
  beforeEach(() => {
    router.__params = {};
  });

  const SHOPPING = [
    item('Shopping', 'Milk', { id: 'i1' }),
    item('Shopping', 'Bread', { id: 'i2', done: true }),
  ];

  async function openLists(over: Parameters<typeof setup>[0] = {}) {
    const mutations = setup(over);
    await wrap(<NotesScreen />);
    if (router.__params['pane'] !== 'lists') await fireEvent.press(screen.getByText('Lists'));
    return mutations;
  }

  it('is the only door: it counts the lists, starts one and leads nowhere else', async () => {
    await openLists({
      lists: [{ name: 'Shopping', open: 1, total: 2 }],
      items: SHOPPING,
    });

    expect(screen.getByText('1 list · 1 still open')).toBeTruthy();
    expect(screen.getByText('New list')).toBeTruthy();
    // The full-screen duplicate is gone; nothing may offer a way back to it.
    expect(screen.queryByText('Open all lists')).toBeNull();
    expect(screen.queryByText('Start a list')).toBeNull();
  });

  it('sinks ticked items to the bottom', async () => {
    await openLists({ lists: [{ name: 'Shopping', open: 1, total: 2 }], items: SHOPPING });

    const rows = screen.getAllByRole('checkbox');
    expect(rows[0]?.props.accessibilityLabel).toBe('Milk');
    expect(rows[1]?.props.accessibilityLabel).toBe('Bread');
  });

  it('opens on the list a deep link names, and only that one', async () => {
    router.__params = { pane: 'lists', list: 'shopping' };
    await openLists({
      lists: [
        { name: 'Hardware', open: 1, total: 1 },
        { name: 'Shopping', open: 1, total: 2 },
      ],
      items: SHOPPING,
    });

    // The pane followed the URL without the segmented control being touched,
    // and the named list is the one that opened — not the first.
    expect(screen.getByText('2 lists · 2 still open')).toBeTruthy();
    expect(screen.getAllByRole('checkbox')).toHaveLength(SHOPPING.length);
    expect(screen.getByLabelText('Shopping, 1 of 2 open').props.accessibilityState).toMatchObject({
      expanded: true,
    });
    expect(screen.getByLabelText('Hardware, 1 of 1 open').props.accessibilityState).toMatchObject({
      expanded: false,
    });
  });

  /**
   * The URL chooses the pane, it does not own it. Deriving `pane` from the
   * params instead of seeding state from them would nail the tab to Lists for
   * as long as a deep link's params survive, with the Notes half unreachable.
   */
  it('lets the segmented control back out of a pane the URL chose', async () => {
    router.__params = { pane: 'lists', list: 'shopping' };
    setup({ lists: [{ name: 'Shopping', open: 1, total: 2 }], items: SHOPPING, notes: [] });
    await wrap(<NotesScreen />);

    expect(screen.getByText('1 list · 1 still open')).toBeTruthy();

    // By role, because the screen's own title says "Notes" too.
    await fireEvent.press(screen.getByRole('tab', { name: 'Notes' }));
    expect(screen.queryByText('1 list · 1 still open')).toBeNull();
    expect(screen.getByLabelText('Search notes')).toBeTruthy();
  });

  it('removes a single item on the spot — the ✕ asks nothing', async () => {
    const { remove } = await openLists({
      lists: [{ name: 'Shopping', open: 1, total: 2 }],
      items: SHOPPING,
    });

    await fireEvent.press(screen.getByLabelText('Remove Milk'));
    expect(remove.mutate).toHaveBeenCalledWith('i1', expect.anything());
  });

  it('makes the bulk clear confirm itself, and lets it be called off', async () => {
    const { clear } = await openLists({
      lists: [{ name: 'Shopping', open: 1, total: 2 }],
      items: SHOPPING,
    });

    await fireEvent.press(screen.getByText('Clear 1 done'));
    expect(clear.mutate).not.toHaveBeenCalled();
    expect(screen.getByText(/cannot be undone/)).toBeTruthy();

    await fireEvent.press(screen.getByText('Keep'));
    expect(clear.mutate).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByText('Clear 1 done'));
    await fireEvent.press(screen.getByText('Clear 1'));
    expect(clear.mutate).toHaveBeenCalledWith('Shopping', expect.anything());
  });

  /**
   * The arm is worth nothing if it survives a change to what it would delete:
   * the user answered a question about one row and would be answering it about
   * two.
   */
  it('drops an armed clear when what is ticked changes under it', async () => {
    await openLists({ lists: [{ name: 'Shopping', open: 1, total: 2 }], items: SHOPPING });

    await fireEvent.press(screen.getByText('Clear 1 done'));
    expect(screen.getByText('Clear 1')).toBeTruthy();

    hooks.useChecklistItems!.mockReturnValue(
      query([
        item('Shopping', 'Milk', { id: 'i1', done: true }),
        item('Shopping', 'Bread', { id: 'i2', done: true }),
      ]),
    );
    // Collapsing and re-opening the section is the cheapest honest re-render.
    await fireEvent.press(screen.getByLabelText('Shopping, 1 of 2 open'));
    await fireEvent.press(screen.getByLabelText('Shopping, 1 of 2 open'));

    expect(screen.queryByText('Clear 1')).toBeNull();
    expect(screen.getByText('Clear 2 done')).toBeTruthy();
  });

  /**
   * With no lists there is no row to lean on, and "Start a list" is gone: the
   * header button is the only non-voice way left to begin one.
   */
  it('can still start the very first list', async () => {
    await openLists({ lists: [] });

    expect(screen.getByText('No lists yet')).toBeTruthy();
    await fireEvent.press(screen.getByText('New list'));
    expect(screen.getByLabelText('List name')).toBeTruthy();
    expect(screen.getByLabelText('First item')).toBeTruthy();
  });
});
