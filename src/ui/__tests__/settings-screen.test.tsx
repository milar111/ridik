import { render, screen, fireEvent } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { defaultSettings } from '@/repositories/settings';

import { ThemeProvider } from '../ThemeProvider';

/* Settings reads its app data through the real hooks; only the repositories
   under them are faked, so the query keys and render paths are production. */
const mockRepos = {
  settings: { getAll: jest.fn(), set: jest.fn() },
  syncQueue: { listByStatus: jest.fn() },
  notes: { rebuildSearchIndex: jest.fn() },
};

jest.mock('@/repositories', () => ({ getRepositories: () => mockRepos }));

/* `@/hooks/useSystem` binds the keychain, the calendar, the speech recogniser
   and expo-location at import time. Every device answer this screen renders is
   supplied here so the *screen* is what is under test. */
type Level = 'granted' | 'partial' | 'denied' | 'blocked' | 'unavailable';
let mockSecret: { present: boolean; preview: string | null };
let mockPermissionLevel: Record<string, Level>;
let mockCalendar: Record<string, unknown> | undefined;
let mockStats: Record<string, unknown> | undefined;
let mockBackground: Record<string, unknown> | undefined;
let mockLogs: { seq: number; at: number; level: string; scope: string; message: string }[];
const mockErase = jest.fn();
const mockRequestPermission = jest.fn();

const permission = (id: string, level: Level) => ({ id, level, detail: `${id} is ${level}` });

jest.mock('@/hooks/useSystem', () => ({
  // Slot-aware: the Whisper row renders alongside the assistant row, and a
  // shared answer would make the two indistinguishable in a query.
  useSecret: (slot: string) => ({
    data: slot === 'llm' ? mockSecret : { present: false, preview: null },
    isLoading: false,
  }),
  useSetSecret: () => ({ mutate: jest.fn(), isPending: false }),
  useCalendarConnection: () => ({
    data: mockCalendar,
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
  useConnectCalendar: () => ({ mutate: jest.fn(), isPending: false }),
  useDisconnectCalendar: () => ({ mutate: jest.fn(), isPending: false }),
  useSyncCalendarNow: () => ({ mutate: jest.fn(), isPending: false }),
  usePermissions: () => ({
    data: {
      microphone: permission('microphone', mockPermissionLevel.microphone!),
      calendar: permission('calendar', mockPermissionLevel.calendar!),
      location: permission('location', mockPermissionLevel.location!),
      notifications: permission('notifications', mockPermissionLevel.notifications!),
    },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
  useRequestPermission: () => ({
    mutate: mockRequestPermission,
    isPending: false,
    variables: undefined,
  }),
  useBackgroundStatus: () => ({ data: mockBackground }),
  useDatabaseStats: () => ({ data: mockStats }),
  useEraseAllData: () => ({ mutate: mockErase, isPending: false }),
  useExportEverything: () => ({ mutate: jest.fn(), isPending: false }),
  useLogEntries: () => mockLogs,
}));

jest.mock('@/features/export', () => ({
  copyToClipboard: jest.fn(async () => ({ ok: true, value: undefined })),
}));

/* Reanimated 4 boots its worklets runtime on import and has no native side
   here; the toast stack (pulled in by the component barrel) is the only thing
   in this tree that touches it. */
jest.mock('react-native-reanimated', () => {
  const React = require('react');
  const { View } = require('react-native');
  const modifier = { duration: () => modifier };
  return {
    __esModule: true,
    default: {
      View: ({ entering, exiting, layout, ...rest }: Record<string, unknown>) =>
        React.createElement(View, rest),
    },
    FadeInUp: modifier,
    FadeOutUp: modifier,
    LinearTransition: modifier,
  };
});

import SettingsScreen from '../../../app/settings';

/** Without seeded metrics the provider withholds its children until layout. */
const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider forceScheme="dark">
        <QueryClientProvider client={client}>{ui}</QueryClientProvider>
      </ThemeProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  mockSecret = { present: false, preview: null };
  mockPermissionLevel = {
    microphone: 'granted',
    calendar: 'denied',
    location: 'partial',
    notifications: 'blocked',
  };
  mockCalendar = { configured: false, connected: false, nativeMirror: false, pending: 0, inFlight: 0, failed: 0 };
  mockStats = { bytes: 0, totalRows: 0, tables: [], schemaVersion: 2 };
  mockBackground = { availability: 'available', taskRegistered: true, intervalMinutes: 15 };
  mockLogs = [];
  mockErase.mockReset();
  mockRequestPermission.mockReset();
  mockRepos.settings.getAll.mockResolvedValue(defaultSettings());
  mockRepos.settings.set.mockImplementation(async (_k: string, v: unknown) => v);
  mockRepos.syncQueue.listByStatus.mockResolvedValue([]);
  mockRepos.notes.rebuildSearchIndex.mockResolvedValue(0);
});

describe('settings screen', () => {
  /* A first launch has no rows, no key and no connection. Every group has to
     render something rather than throwing on an absent field. */
  it('renders every group against a completely empty database', async () => {
    await wrap(<SettingsScreen />);

    expect(await screen.findByText('Voice, sync and what lives on this phone')).toBeTruthy();
    for (const group of ['ACCOUNT', 'VOICE', 'SCHEDULE', 'PERMISSIONS', 'DATA', 'DIAGNOSTICS']) {
      expect(screen.getByText(group)).toBeTruthy();
    }
    expect(screen.getByText('Nothing saved yet.')).toBeTruthy();
    expect(screen.getByText('Nothing logged this session.')).toBeTruthy();
  });

  it('warns that no assistant key means pattern matching, not intelligence', async () => {
    await wrap(<SettingsScreen />);
    expect(await screen.findByText('Running in offline mode')).toBeTruthy();
  });

  it('drops the offline warning and masks the key once one is stored', async () => {
    mockSecret = { present: true, preview: '••••••••9f2a' };
    await wrap(<SettingsScreen />);

    expect(await screen.findByText('••••••••9f2a')).toBeTruthy();
    expect(screen.queryByText('Running in offline mode')).toBeNull();
  });

  /* The distinction that matters: a permission the OS will still prompt for
     gets a Grant button, one the user has hard-denied can only be fixed in
     system settings. Offering "Grant" there is a button that does nothing. */
  it('offers Grant only where the OS will still ask, and Settings where it will not', async () => {
    await wrap(<SettingsScreen />);
    await screen.findByText('PERMISSIONS');

    expect(screen.getByText('GRANTED')).toBeTruthy();
    expect(screen.getByText('NOT ASKED')).toBeTruthy();
    expect(screen.getByText('PARTIAL')).toBeTruthy();
    expect(screen.getByText('BLOCKED')).toBeTruthy();

    // calendar (denied) and location (partial) can still be asked; notifications
    // (blocked) cannot, and microphone (granted) needs nothing.
    expect(screen.getAllByText('Grant')).toHaveLength(2);

    await fireEvent.press(screen.getAllByText('Grant')[0]!);
    expect(mockRequestPermission).toHaveBeenCalledWith('calendar');
  });

  /* Erasing is the one irreversible action in the app. It must take two
     deliberate steps and reject anything but the exact word. */
  it('will not erase until ERASE is typed exactly', async () => {
    await wrap(<SettingsScreen />);

    // By role, not by text: the card's heading repeats the button's wording.
    await fireEvent.press(await screen.findByRole('button', { name: 'Erase all data' }));
    const field = await screen.findByPlaceholderText('ERASE');
    const confirm = () => screen.getByRole('button', { name: 'Erase everything' });

    await fireEvent.press(confirm());
    expect(mockErase).not.toHaveBeenCalled();

    await fireEvent.changeText(field, 'erase please');
    await fireEvent.press(confirm());
    expect(mockErase).not.toHaveBeenCalled();

    await fireEvent.changeText(field, 'ERASE');
    await fireEvent.press(confirm());
    expect(mockErase).toHaveBeenCalledTimes(1);
  });

  it('reports what is actually on disk once there are rows', async () => {
    mockStats = {
      bytes: 2 * 1024 * 1024,
      totalRows: 412,
      schemaVersion: 2,
      tables: [
        { table: 'notes', rows: 300 },
        { table: 'tasks', rows: 112 },
        { table: 'habits', rows: 0 },
      ],
    };

    await wrap(<SettingsScreen />);
    expect(await screen.findByText('2.0 MB · 412 rows')).toBeTruthy();
    expect(screen.getByText('notes 300 · tasks 112')).toBeTruthy();
  });
});
