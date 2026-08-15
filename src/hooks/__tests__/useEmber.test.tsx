/**
 * The colour setting, from the row in SQLite to the palette on screen.
 *
 * The interesting thing about this one is where it is read. `ThemeProvider` is
 * mounted *above* the query client in the root layout, so it cannot ask a query
 * what colour to paint; it reads a store, and the store is filled from the
 * repository once on mount and kept in step by the screen that writes it. Both
 * halves of that are here, because either one failing leaves an app that is the
 * right colour only some of the time.
 */
import { Text } from 'react-native';
import { render, renderHook, screen, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ThemeProvider, useTheme } from '@/ui/ThemeProvider';
import { defaultSettings } from '@/repositories/settings';
import { DEFAULT_EMBER, embers } from '@/ui/theme';

import { emberChoice, loadEmber, setEmberChoice, useEmber } from '../useEmber';

const mockRepos = {
  settings: { get: jest.fn(), getAll: jest.fn(), set: jest.fn() },
};

jest.mock('@/repositories', () => ({ getRepositories: () => mockRepos }));

let client: QueryClient;

beforeEach(() => {
  // The store is module state, like the palette it feeds: reset it or one test
  // paints the next one.
  setEmberChoice(DEFAULT_EMBER);
  // One client per test, built here rather than inside the wrapper: a wrapper
  // that mints a client is a new client on every render, and each abandoned one
  // keeps a timer alive after the test that made it has finished.
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  mockRepos.settings.get.mockResolvedValue(DEFAULT_EMBER);
  mockRepos.settings.getAll.mockResolvedValue(defaultSettings());
  mockRepos.settings.set.mockImplementation(async (_key: string, value: unknown) => value);
});

afterEach(() => {
  client.clear();
});

function wrap(ui: React.ReactElement) {
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function Painted(): React.ReactElement {
  const theme = useTheme();
  return <Text>{`${theme.ember}:${theme.cells.hot}`}</Text>;
}

describe('the stored ember', () => {
  it('is what the app paints with, one mount later', async () => {
    mockRepos.settings.get.mockResolvedValue('rust');

    await render(
      <ThemeProvider forceScheme="light">
        <Painted />
      </ThemeProvider>,
    );

    expect(await screen.findByText(`rust:${embers.rust.light.hot}`)).toBeTruthy();
  });

  /* A database that is not open yet, or a build with no repositories behind it,
     must leave the default in place rather than throw inside the provider every
     screen in the app renders under. */
  it('degrades to the default when it cannot be read at all', async () => {
    mockRepos.settings.get.mockRejectedValue(new Error('database is not open'));

    await render(
      <ThemeProvider forceScheme="dark">
        <Painted />
      </ThemeProvider>,
    );

    expect(screen.getByText(`${DEFAULT_EMBER}:${embers.ember.dark.hot}`)).toBeTruthy();
    await waitFor(() => expect(mockRepos.settings.get).toHaveBeenCalled());
  });

  it('survives a restart, because the row is the truth', async () => {
    mockRepos.settings.get.mockResolvedValue('kiln');
    await loadEmber();
    expect(emberChoice()).toBe('kiln');

    // A "restart": the store is back where a fresh process finds it, and the
    // next load brings the choice back rather than the default.
    setEmberChoice(DEFAULT_EMBER);
    await loadEmber();
    expect(emberChoice()).toBe('kiln');
  });
});

describe('choosing one', () => {
  it('repaints immediately and persists in the background', async () => {
    const { result } = await renderHook(() => useEmber(), { wrapper: ({ children }) => wrap(children) });

    await act(async () => result.current.set('kiln'));

    expect(emberChoice()).toBe('kiln');
    expect(mockRepos.settings.set).toHaveBeenCalledWith('ember', 'kiln');
    await waitFor(() => expect(result.current.value).toBe('kiln'));
    // The write invalidates the settings, so the refetch it starts is part of
    // this test rather than something left running behind it.
    await waitFor(() => expect(client.isFetching()).toBe(0));
  });

  it('offers every ember, the default first, with what to call each one', async () => {
    const { result } = await renderHook(() => useEmber(), { wrapper: ({ children }) => wrap(children) });

    expect(result.current.options.map((option) => option.name)).toEqual(['ember', 'kiln', 'rust']);
    expect(result.current.options[0]!.name).toBe(DEFAULT_EMBER);
    for (const option of result.current.options) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.note.length).toBeGreaterThan(0);
    }
  });

  /* The screen's own read starts at the declared default while the query is in
     flight. Mirroring *that* into the store would flash the whole app back to
     orange every time somebody who had chosen rust opened Settings. */
  it('does not flash the default over a choice that is already on screen', async () => {
    setEmberChoice('rust');
    let resolve = (_value: unknown) => {};
    mockRepos.settings.getAll.mockReturnValue(new Promise((r) => (resolve = r)));

    const { result } = await renderHook(() => useEmber(), { wrapper: ({ children }) => wrap(children) });

    expect(emberChoice()).toBe('rust');
    expect(result.current.value).toBe('rust');

    await act(async () => {
      resolve({ ...defaultSettings(), ember: 'rust' });
    });
    expect(emberChoice()).toBe('rust');
  });
});
