import { render, screen, fireEvent } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { defaultSettings } from '@/repositories/settings';
import {
  describeTrial,
  TRIAL_TOTAL_REQUESTS,
  TRIAL_TOTAL_TOKENS,
} from '@/services/billing/allowance';
import { emberChoice, setEmberChoice } from '@/hooks/useEmber';
import { DEFAULT_EMBER, embers } from '@/ui/theme';

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
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn(), canGoBack: () => true }),
  /* `useNavigateOnce` releases its guard when the screen is focused again, so
     every group that navigates through it needs this. Without it the hook threw
     on the first render and the surrounding `ErrorBoundary` swallowed it — the
     Plan group has been silently rendering as its fallback in this suite, which
     is exactly the failure an error boundary is built to hide. */
  useFocusEffect: (effect: () => void | (() => void)) => {
    const { useEffect } = jest.requireActual<typeof import('react')>('react');
    useEffect(effect, [effect]);
  },
}));

let mockAssistantMode: 'hosted' | 'personal-key' | 'offline';
jest.mock('@/hooks/useAssistant', () => ({
  useAssistantMode: () => ({ data: mockAssistantMode, isLoading: false }),
}));

jest.mock('@/features/export', () => ({
  copyToClipboard: jest.fn(async () => ({ ok: true, value: undefined })),
}));

/* The two facts the Plan row is built out of, supplied here.
   `currentEntitlement()` waits on a provider that no test registers and then
   times out after five seconds, which left the Plan group rendering its
   skeleton in this suite forever; and `isStoreBuild()` is module state that
   only a real store SDK can move, so it can only be answered from outside. */
let mockEntitlement: Entitlement;
let mockStoreBuild: boolean;
/* Whether the store has answered yet. Every other test in this file wants it
   answered, and for a long time this mock could not express anything else —
   which is precisely what hid a crash that only happens on the way *between*
   the two states. See the transition test at the bottom of the file. */
let mockEntitlementLoading: boolean;

jest.mock('@/hooks/useBilling', () => ({
  useEntitlement: () => ({
    data: mockEntitlementLoading ? undefined : mockEntitlement,
    isLoading: mockEntitlementLoading,
    isError: false,
  }),
  /* The durable half of the trial ledger. Undefined here — these tests drive
     the settings rows, and `mergeTrial` takes the larger of the two, so an
     absent keychain read must leave the stored value standing.

     It calls a real hook, and that is the whole point rather than a detail. The
     thing being guarded against is a hook read placed below an early return,
     which React catches by *counting hooks per render*. A mock that consumes no
     hook slot makes that count identical either way — so the transition test
     below passed against the very bug it was written for until this line
     existed. A stand-in for a hook has to be a hook. */
  useTrialLedger: () => {
    (require('react') as typeof import('react')).useRef(null);
    return { data: undefined, isLoading: false, isError: false };
  },
  mergeTrial: (durable: unknown, stored: unknown) => durable ?? stored,
}));

jest.mock('@/services/billing/entitlement', () => ({
  ...jest.requireActual<typeof import('@/services/billing/entitlement')>(
    '@/services/billing/entitlement',
  ),
  isStoreBuild: () => mockStoreBuild,
}));

import { FREE, type Entitlement } from '@/services/billing/entitlement';

import SettingsScreen from '../../../app/settings';

/** Without seeded metrics the provider withholds its children until layout. */
const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

async function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const tree = (node: React.ReactElement) => (
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider forceScheme="dark">
        <QueryClientProvider client={client}>{node}</QueryClientProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
  const view = await render(tree(ui));
  /* Re-rendering goes back through the same providers and the same client.
     RNTL's own `rerender` replaces the *entire* tree with whatever it is given,
     so handing it a bare screen pulls the query client out from under the
     component being tested — which fails as "No QueryClient set" rather than as
     anything to do with the thing under test. */
  return { ...view, rerender: (node: React.ReactElement) => view.rerender(tree(node)) };
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
  // The palette is module state so that the theme can be read above the query
  // client; put it back where a fresh launch finds it.
  setEmberChoice(DEFAULT_EMBER);
  // A personal build by default: nothing to buy, so nothing to say about a trial.
  mockStoreBuild = false;
  mockEntitlement = FREE;
  mockEntitlementLoading = false;
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

    for (const group of ['COLOUR', 'YOUR DATA', 'ABOUT']) {
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
    await screen.findByText('COLOUR');

    for (const gone of [
      'Model',
      'Time zone',
      'Confidence threshold',
      'Silence before it stops',
      'Speech rate',
      'Requests per day',
      'Requests per month',
      // Both belong to the operator's invoice, not to the person using the app:
      // a trial counter anyone could zero is not a trial, and a switch that
      // pretends a store is present would lock a personal build.
      'Free trial',
      'Simulate a store build',
      'Whisper fallback',
      'Rebuild search index',
      'Week starts on',
      'Default travel buffer',
      // Moved to developer: a store build has nothing to paste.
      'Assistant key',
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
    await screen.findByText('COLOUR');

    expect(screen.queryByText('Briefing at')).toBeNull();
    expect(screen.queryByText('Morning briefing')).toBeNull();
  });

  /*
   * The one decision that lets anything leave this phone, and it has to be
   * findable afterwards. A permission you cannot revoke is not a permission,
   * and both stores treat "we asked once at install" as an answer to a
   * different question.
   *
   * It passes this screen's own test, which almost nothing on `/developer`
   * does: set it to the worst value a stranger could pick and the app still
   * works. The worst value is "no", and "no" is a working app with an offline
   * assistant.
   */
  it('lets the assistant permission be found and changed afterwards', async () => {
    mockRepos.settings.getAll.mockResolvedValue({
      ...defaultSettings(),
      assistantConsent: 'granted',
    });
    await wrap(<SettingsScreen />);

    // The value, not the label, is what has to be awaited: the label is static
    // and the row renders before the settings read lands on it.
    expect(await screen.findByText(/The words of a request go to Google/)).toBeTruthy();
    expect(screen.getByText('Where your words go')).toBeTruthy();

    // Through the disclosure, never a bare switch: agreeing to something you
    // are not being shown is not agreement, and a switch has no way to show it.
    await fireEvent.press(screen.getByRole('button', { name: 'Change' }));
    expect(mockPush).toHaveBeenCalledWith('/consent');
  });

  it('says plainly that nothing is sent once it has been turned off', async () => {
    mockRepos.settings.getAll.mockResolvedValue({
      ...defaultSettings(),
      assistantConsent: 'declined',
    });
    await wrap(<SettingsScreen />);

    expect(await screen.findByText(/Nothing is sent/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeTruthy();
  });

  /*
   * The trial, on the one screen a person looks at to find out what they are
   * on.
   *
   * `describeTrial` has produced exactly the right sentence since the money
   * path was written and was imported by one file: the developer screen, behind
   * seven taps. A free user's first news of a 25-request limit therefore
   * arrived at request twenty, when the warning fired — which is the review
   * every app with a hidden trial collects.
   */
  it('tells a free user what the trial is before they have spent it', async () => {
    mockStoreBuild = true;
    mockRepos.settings.getAll.mockResolvedValue({
      ...defaultSettings(),
      llmTrialRequestsUsed: 18,
    });
    await wrap(<SettingsScreen />);

    expect(
      await screen.findByText(describeTrial({ requestsUsed: 18, tokensUsed: 0 })),
    ).toBeTruthy();
    expect(screen.getByText(/life of this install/)).toBeTruthy();
    // The developer screen's row stays where it is; this is the same fact in
    // the profile's own words.
    expect(screen.queryByText('Free trial')).toBeNull();
  });

  /* A spent trial is not a broken app, and the sentence has to say so — the
     assistant falls back to the offline matcher rather than stopping. */
  it('says a spent trial is spent, and that Ridik still works', async () => {
    mockStoreBuild = true;
    mockRepos.settings.getAll.mockResolvedValue({
      ...defaultSettings(),
      llmTrialRequestsUsed: TRIAL_TOTAL_REQUESTS + 4,
    });
    await wrap(<SettingsScreen />);

    expect(
      await screen.findByText(
        describeTrial({ requestsUsed: TRIAL_TOTAL_REQUESTS, tokensUsed: 0 }),
      ),
    ).toBeTruthy();
    expect(screen.getByText(/still listens/)).toBeTruthy();
  });

  /**
   * The trial has two ceilings, and this row knew about one of them.
   *
   * `resolveAssistantBudget` refuses on the lifetime *token* tripwire
   * independently of the request counter, so six long dictations — two of them
   * repaired — spend the whole allowance in six requests. Every turn then
   * answers "This install has used its free assistant allowance" while the one
   * row that exists so a free user is not misled about the limit reads "19 of
   * 25 free requests left", with a hint saying they last the life of the
   * install. That is the hidden-trial review, earned twice.
   */
  it('does not offer requests that the token allowance has already spent', async () => {
    mockStoreBuild = true;
    mockRepos.settings.getAll.mockResolvedValue({
      ...defaultSettings(),
      llmTrialRequestsUsed: 6,
      llmTrialTokensUsed: TRIAL_TOTAL_TOKENS,
    });
    await wrap(<SettingsScreen />);

    expect(await screen.findByText('Free assistant allowance spent')).toBeTruthy();
    expect(screen.queryByText(/free requests left/)).toBeNull();
    // And the hint agrees with the refusal the next turn will get.
    expect(screen.getByText(/They are spent/)).toBeTruthy();
  });

  /* Three ways this line would be a lie, and each is somebody it would be a lie
     to: a build with nothing to sell has no trial at all; a subscriber bought
     their way past it; and a store that could not be reached is not evidence
     that anybody is on one. */
  it('says nothing about a trial where there is not one', async () => {
    const cases: [string, () => void][] = [
      [
        'a personal build',
        () => {
          mockStoreBuild = false;
        },
      ],
      [
        'a subscriber',
        () => {
          mockStoreBuild = true;
          mockEntitlement = { ...FREE, active: true, plan: 'ridik_monthly', tier: 'pro', willRenew: true };
        },
      ],
      [
        'a store that did not answer',
        () => {
          mockStoreBuild = true;
          mockEntitlement = { ...FREE, known: false };
        },
      ],
    ];

    for (const [, arrange] of cases) {
      arrange();
      mockRepos.settings.getAll.mockResolvedValue({
        ...defaultSettings(),
        llmTrialRequestsUsed: 18,
      });
      const view = await wrap(<SettingsScreen />);

      await screen.findByText('COLOUR');
      expect(screen.queryByText(describeTrial({ requestsUsed: 18, tokensUsed: 0 }))).toBeNull();
      expect(screen.queryByText(/free requests left/)).toBeNull();
      await view.unmount();
    }
  });

  /* Two preferences now, and both pass the same test: set either one to the
     worst value you can find and the app still works. */
  /*
   * The screen is one microphone and one answer, and the test for a row here is
   * no longer "can a stranger break the app with it" but "does the app need to
   * ask at all". A switch is a decision taken before anything gets done, which
   * is the opposite of the product.
   *
   * What survives is not preferences. It is the plan, the disclosure of where
   * words go, the switch that lets anything leave the phone, the user's own
   * data, and one choice of colour that cannot be wrong — every ember is held
   * to the same contrast rules in `widget-tokens.test.ts`.
   */
  it('asks about nothing it could decide itself', async () => {
    await wrap(<SettingsScreen />);
    expect(await screen.findByText('COLOUR')).toBeTruthy();

    // Off by default, on for the life of the app, and it reads every
    // confirmation and the whole briefing out loud. It is behind the developer
    // gate now, beside the rate control it was always separated from.
    expect(screen.queryByText('Speak replies')).toBeNull();
    expect(screen.queryByText('PREFERENCES')).toBeNull();
  });

  /*
   * The review before sending is not on this screen because it is not a choice.
   * It shipped as a switch for one afternoon; sending is one tap and unsending
   * is not a thing that exists, so the only free correction point in the app
   * cannot be something a person can turn off and then dictate through.
   */
  /*
   * Google Calendar came *back* from the developer screen, and the reason is
   * worth keeping: the calendar screen draws a banner saying "Google Calendar
   * isn't connected" and sends you here to fix it, so hiding the row behind
   * seven taps on Version made the app advertise a destination that did not
   * exist. It passes this screen's own test — the worst value a stranger can
   * pick is "not connected", which is a working app whose events stay local.
   */
  it('lets Google Calendar be connected from where the banner sends you', async () => {
    await wrap(<SettingsScreen />);
    expect(await screen.findByText('Google Calendar')).toBeTruthy();
  });

  it('offers no way to skip the check before sending', async () => {
    await wrap(<SettingsScreen />);
    await screen.findByText('COLOUR');

    expect(screen.queryByText('Check before sending')).toBeNull();
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
    await screen.findByText('COLOUR');

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

  /*
   * The colour picker passes the same test the rest of the screen is held to:
   * there is no value a stranger could set it to that breaks anything, because
   * every ember is held to the ramp's contrast rules. So it belongs here rather
   * than behind the developer gate.
   */
  it("offers every ember, in the user's terms rather than the palette's", async () => {
    await wrap(<SettingsScreen />);

    expect(await screen.findByText('COLOUR')).toBeTruthy();
    for (const option of Object.values(embers)) {
      expect(screen.getByText(option.label)).toBeTruthy();
      expect(screen.getByText(option.note)).toBeTruthy();
    }
  });

  it('starts on the one the app already draws, and says which it is', async () => {
    await wrap(<SettingsScreen />);

    const chosen = await screen.findByRole('radio', { name: embers[DEFAULT_EMBER].label });
    expect(chosen.props.accessibilityState.selected).toBe(true);
    expect(
      screen.getByRole('radio', { name: embers.rust.label }).props.accessibilityState.selected,
    ).toBe(false);
  });

  it('writes the choice, and repaints before it has landed', async () => {
    await wrap(<SettingsScreen />);

    await fireEvent.press(await screen.findByRole('radio', { name: embers.kiln.label }));

    expect(emberChoice()).toBe('kiln');
    expect(mockRepos.settings.set).toHaveBeenCalledWith('ember', 'kiln');
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

  /**
   * What the confirmation is allowed to promise.
   *
   * It read "This deletes everything on this phone. There is no backup and no
   * undo." Both halves stopped being true the day Backup and restore shipped:
   * `wipeAllTables` empties SQLite tables and nothing else, the saved JSON sits
   * in the documents directory untouched, and the row two lines above says so
   * outright — "The copy kept on this phone survives “Delete all data”". Two
   * screens in one app stating opposite facts about the same button, and the
   * person it costs is the one who types ERASE before handing the phone on and
   * leaves a plaintext copy of every note, contact and transaction behind.
   */
  it('does not promise that erasing takes the backups with it', async () => {
    await wrap(<SettingsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Delete' }));

    await screen.findByPlaceholderText('ERASE');
    expect(screen.queryByText(/no backup/i)).toBeNull();
    // And it says what actually happens to them, on the screen where the
    // decision is made rather than on the one the user is not looking at.
    expect(screen.getByText(/Backup files you have already saved are not touched/)).toBeTruthy();
    expect(screen.getByText(/no undo/i)).toBeTruthy();
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

  /**
   * The sequence a real launch always takes, and the one nothing here rendered.
   *
   * `PlanGroup` returns a skeleton while the entitlement is in flight and the
   * row once it lands. A hook read *below* that return therefore runs on the
   * second render and not the first, which React refuses outright — "Rendered
   * more hooks than during the previous render" — and the whole group is
   * replaced by the error boundary's failure card.
   *
   * It was invisible from three directions at once. The entitlement is an async
   * store read, so this only happens on a device, where the first frame is
   * always the loading one; the surrounding `ErrorBoundary` turns the crash into
   * a card rather than a redbox, so the screen still looks like a screen; and
   * this suite mocked the entitlement as already answered, so the transition
   * never happened here at all. What it cost was the Plan row — the one row that
   * tells a free user their trial is finite, which is on this screen precisely
   * so nobody first hears about the limit from the warning at five requests
   * left.
   *
   * The assertion is deliberately about the *row*, not about the absence of an
   * error: a crash caught by a boundary is silent, so a test looking for a
   * thrown exception would pass either way.
   */
  it('renders the plan row when the entitlement lands after the first frame', async () => {
    mockStoreBuild = true;
    mockEntitlementLoading = true;

    const view = await wrap(<SettingsScreen />);
    expect(screen.queryByText('Free')).toBeNull();

    mockEntitlementLoading = false;
    await view.rerender(<SettingsScreen />);

    expect(await screen.findByText('Free')).toBeTruthy();
    expect(screen.queryByText(/could not be shown|went wrong/i)).toBeNull();
  });
});
