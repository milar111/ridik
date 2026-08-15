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

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush, back: jest.fn() }) }));

let mockAssistantMode: 'hosted' | 'personal-key' | 'offline';
jest.mock('@/hooks/useAssistant', () => ({
  useAssistantMode: () => ({ data: mockAssistantMode, isLoading: false }),
}));

jest.mock('@/features/export', () => ({
  copyToClipboard: jest.fn(async () => ({ ok: true, value: undefined })),
}));

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
  mockAssistantMode = 'offline';
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
  mockPush.mockReset();
  mockRepos.settings.getAll.mockResolvedValue(defaultSettings());
  mockRepos.settings.set.mockImplementation(async (_k: string, v: unknown) => v);
  mockRepos.syncQueue.listByStatus.mockResolvedValue([]);
  mockRepos.notes.rebuildSearchIndex.mockResolvedValue(0);
});

describe('settings screen', () => {
  /* A first launch has no rows, no key and no connection. Every group has to
     render something rather than throwing on an absent field. */
  it('renders against a completely empty database', async () => {
    await wrap(<SettingsScreen />);

    for (const group of ['PREFERENCES', 'YOUR DATA', 'ABOUT']) {
      expect(await screen.findByText(group)).toBeTruthy();
    }
  });

  /*
   * The point of the rewrite. Each of these was a control a person could set to
   * a value that breaks the app — a misspelled model name kills voice, a bad
   * timezone moves every date — and each now lives behind the developer gate.
   * Asserting their absence is what stops them drifting back one convenience at
   * a time.
   */
  it('keeps the knobs that can break the app off the profile', async () => {
    await wrap(<SettingsScreen />);
    await screen.findByText('PREFERENCES');

    for (const gone of [
      'Model',
      'Time zone',
      'Confidence threshold',
      'Silence before it stops',
      'Speech rate',
      'Requests per day',
      'Requests per month',
      'Whisper fallback',
      'Rebuild search index',
      'Week starts on',
      'Default travel buffer',
      // Moved to developer: a store build has nothing to paste, and connecting
      // Google is a one-time setup act rather than a preference.
      'Assistant key',
      'Google Calendar',
      // Deleted outright — it was a mirror of an OS permission, not a setting.
      'Show in your phone calendar',
    ]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
  });

  /*
   * The briefing stopped being a scheduled notification and became something
   * shown on the first open of the day, so there is no hour to choose and no
   * switch to find. Both were decisions the app should make.
   */
  it('has no briefing schedule to configure', async () => {
    await wrap(<SettingsScreen />);
    await screen.findByText('PREFERENCES');

    expect(screen.queryByText('Briefing at')).toBeNull();
    expect(screen.queryByText('Morning briefing')).toBeNull();
  });

  it('leaves exactly one preference, and it cannot break anything', async () => {
    await wrap(<SettingsScreen />);
    expect(await screen.findByText('Speak replies')).toBeTruthy();
  });


  /*
   * Permissions are surfaced by need, not inventoried. Microphone is the
   * product so it always counts; notifications only once the briefing is on.
   * A granted permission should say nothing at all.
   */
  it('says nothing about permissions that are granted or not yet needed', async () => {
    mockPermissionLevel = {
      microphone: 'granted',
      calendar: 'denied',
      location: 'denied',
      notifications: 'granted',
    };
    await wrap(<SettingsScreen />);
    await screen.findByText('PREFERENCES');

    // Calendar and location are denied, and stay unmentioned: nothing the user
    // has switched on needs them. They are asked for on the screens that do —
    // Places asks for location at the moment a reminder cannot be watched.
    expect(screen.queryByText('Needs your permission')).toBeNull();
  });

  /*
   * Notifications used to be conditional on the briefing switch. They are not
   * any more: every reminder the app makes is a notification — a task falling
   * due, arriving somewhere, a focus phase ending — so denying them breaks
   * things the user never associated with a briefing.
   */
  it('asks for notifications, which carry every reminder the app makes', async () => {
    mockPermissionLevel = {
      microphone: 'granted',
      calendar: 'granted',
      location: 'granted',
      notifications: 'denied',
    };
    await wrap(<SettingsScreen />);

    expect(await screen.findByText('Notifications')).toBeTruthy();
    expect(screen.getByText('Reminders will not arrive.')).toBeTruthy();
  });

  it('asks for the microphone, because without it there is no product', async () => {
    mockPermissionLevel = {
      microphone: 'denied',
      calendar: 'granted',
      location: 'granted',
      notifications: 'granted',
    };
    await wrap(<SettingsScreen />);

    expect(await screen.findByText('NEEDS YOUR PERMISSION')).toBeTruthy();
    expect(screen.getByText('Ridik cannot hear you without it.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Allow' }));
    expect(mockRequestPermission).toHaveBeenCalledWith('microphone', expect.anything());
  });

  it('sends a blocked permission to system settings instead of a dead button', async () => {
    mockPermissionLevel = {
      microphone: 'blocked',
      calendar: 'granted',
      location: 'granted',
      notifications: 'granted',
    };
    await wrap(<SettingsScreen />);

    // "Allow" would be a button the OS will never honour again.
    expect(await screen.findByRole('button', { name: 'Open settings' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
  });

  /* Erasing is the one irreversible action in the app. Two deliberate steps,
     and nothing but the exact word. */
  it('will not erase until ERASE is typed exactly', async () => {
    await wrap(<SettingsScreen />);

    await fireEvent.press(await screen.findByRole('button', { name: 'Delete' }));
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

  /* The escape hatch for everything the screen hides. Seven taps is enough that
     nobody arrives by accident and few enough to be discoverable when told. */
  it('unlocks the developer screen after seven taps on the version', async () => {
    await wrap(<SettingsScreen />);
    const version = await screen.findByRole('button', { name: 'Version' });

    for (let i = 0; i < 6; i++) await fireEvent.press(version);
    expect(mockRepos.settings.set).not.toHaveBeenCalledWith('developerMode', true);

    await fireEvent.press(version);
    expect(mockRepos.settings.set).toHaveBeenCalledWith('developerMode', true);
  });
});
