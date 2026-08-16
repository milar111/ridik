/**
 * The screen that hands a database back.
 *
 * One thing here is worth a test more than anything else on it: the user is
 * told **merge, not replace** before the restore runs. "Restore" means
 * *replace* in most software anybody has ever met, and being wrong about which
 * one this is costs a database — so the sentence is asserted on the screen, in
 * the question, and against a file that cannot be restored at all.
 */
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ThemeProvider } from '../ThemeProvider';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true }),
  useFocusEffect: (effect: () => void | (() => void)) => {
    const { useEffect } = jest.requireActual<typeof import('react')>('react');
    useEffect(effect, [effect]);
  },
}));

/* The pure half is the real thing — the sentence under test is written there,
   and a stubbed one would assert this file against itself. The barrel is
   mocked because it also carries the share sheet, the mail composer and the
   printer, none of which this screen touches. */
jest.mock('@/features/export', () => ({
  describeImport: jest.requireActual<typeof import('@/features/export/json')>(
    '@/features/export/json',
  ).describeImport,
}));

/* The settings row vocabulary this screen borrows binds the keychain at import
   time, and through it the speech recogniser. Only the one hook it uses is
   needed here. */
jest.mock('@/hooks/useSystem', () => ({
  useSetSecret: () => ({ mutate: jest.fn(), isPending: false }),
}));

type Plan = Record<string, unknown>;

const mockSave = jest.fn();
const mockLoad = jest.fn();
const mockRestore = jest.fn();
const mockShare = jest.fn();
const mockDelete = jest.fn();
let mockFiles: { uri: string; name: string; bytes: number; savedAt: number }[] = [];

jest.mock('@/hooks/useBackup', () => ({
  useBackups: () => ({ data: mockFiles, isLoading: false }),
  useSaveBackup: () => ({ mutate: mockSave, isPending: false }),
  useLoadBackup: () => ({ mutate: mockLoad, isPending: false }),
  useRestoreBackup: () => ({ mutate: mockRestore, isPending: false }),
  useShareBackup: () => ({ mutate: mockShare, isPending: false }),
  useDeleteBackup: () => ({ mutate: mockDelete, isPending: false }),
}));

import BackupScreen from '../../../app/backup';

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider forceScheme="dark">
        <QueryClientProvider client={client}>
          <BackupScreen />
        </QueryClientProvider>
      </ThemeProvider>
    </SafeAreaProvider>,
  );
}

const plan = (over: Plan = {}): Plan => ({
  verdict: 'same',
  schemaVersion: 5,
  currentSchemaVersion: 5,
  exportedAt: Date.UTC(2026, 7, 11, 9, 0, 0),
  tables: [],
  incoming: 12,
  fresh: 9,
  existing: 3,
  unknownTables: [],
  unknownColumns: [],
  ...over,
});

const loaded = (over: Plan = {}) => ({
  name: 'ridik-2026-08-11-0900.json',
  backup: { format: 'ridik.backup', version: 1, schemaVersion: 5, exportedAt: 0, tables: {} },
  plan: plan(over),
  rows: 12,
});

beforeEach(() => {
  mockFiles = [];
  mockSave.mockReset();
  mockLoad.mockReset();
  mockRestore.mockReset();
  mockShare.mockReset();
  mockDelete.mockReset();
});

describe('backup screen', () => {
  it('says on the screen that a restore adds and never deletes', async () => {
    await wrap();

    expect(await screen.findByText(/Nothing on this/)).toBeTruthy();
    expect(screen.getByText(/skipped and counted/)).toBeTruthy();
  });

  it('says where the only copy of this database lives', async () => {
    await wrap();
    expect(await screen.findByText(/no account and no server/)).toBeTruthy();
  });

  /* The question, and its counted consequence for *this* file. Nothing may be
     written before it has been answered. */
  it('asks before it restores, and the question states the semantics', async () => {
    await wrap();

    await fireEvent.press(screen.getByRole('button', { name: 'Choose a file' }));
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(mockRestore).not.toHaveBeenCalled();

    const [, handlers] = mockLoad.mock.calls[0] as [unknown, { onSuccess: (v: unknown) => void }];
    await act(async () => handlers.onSuccess(loaded()));

    expect(await screen.findByText('Restore this backup?')).toBeTruthy();
    expect(screen.getByText(/This adds 9 rows/)).toBeTruthy();
    expect(screen.getByText(/3 rows are already here/)).toBeTruthy();
    expect(screen.getByText(/Nothing is deleted/)).toBeTruthy();
    // Still nothing written: the dialog is the gate, not a progress report.
    expect(mockRestore).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(mockRestore).toHaveBeenCalledTimes(1));
  });

  it('does not offer to restore a file it cannot read', async () => {
    await wrap();

    await fireEvent.press(screen.getByRole('button', { name: 'Choose a file' }));
    const [, handlers] = mockLoad.mock.calls[0] as [unknown, { onSuccess: (v: unknown) => void }];
    await act(async () =>
      handlers.onSuccess(
        loaded({
          verdict: 'newer',
          refusal:
            'That backup came from a newer version of Ridik than this one. Update the app, then restore it.',
        }),
      ),
    );

    expect(screen.queryByText('Restore this backup?')).toBeNull();
    expect(mockRestore).not.toHaveBeenCalled();
  });

  /* Cancelling the picker is an answer. Telling the user off for changing
     their mind is not. */
  it('says nothing when the picker is cancelled', async () => {
    await wrap();

    await fireEvent.press(screen.getByRole('button', { name: 'Choose a file' }));
    const [, handlers] = mockLoad.mock.calls[0] as [unknown, { onSuccess: (v: unknown) => void }];
    await act(async () => handlers.onSuccess(null));

    expect(screen.queryByText('Restore this backup?')).toBeNull();
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it('lists what is already on the phone, newest first, with a way back to it', async () => {
    mockFiles = [
      { uri: 'file:///b/ridik-2026-08-11-0900.json', name: 'ridik-2026-08-11-0900.json', bytes: 2048, savedAt: Date.UTC(2026, 7, 11, 9, 0, 0) },
    ];
    await wrap();

    expect(await screen.findByText('ridik-2026-08-11-0900.json')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Restore' }));
    expect(mockLoad).toHaveBeenCalledWith(
      { uri: 'file:///b/ridik-2026-08-11-0900.json', name: 'ridik-2026-08-11-0900.json' },
      expect.anything(),
    );
  });

  it('tells the truth about deleting a backup: it is a copy, not your data', async () => {
    mockFiles = [
      { uri: 'file:///b/one.json', name: 'one.json', bytes: 10, savedAt: Date.UTC(2026, 7, 11) },
    ];
    await wrap();

    await fireEvent.press(screen.getByRole('button', { name: 'Delete one.json' }));
    expect(await screen.findByText('Delete this backup?')).toBeTruthy();
    expect(screen.getByText(/copy of your data, not your data/)).toBeTruthy();
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
