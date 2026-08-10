import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { CurriculumEntry, GeofenceTrigger, SavedPlace } from '@/db/schema';
import { defaultSettings } from '@/repositories/settings';

import { ThemeProvider } from '../ThemeProvider';

/* The screens read through the real hooks; only the repository layer under them
   is faked, so the query keys and the render paths are the production ones. */
const mockRepos = {
  curriculum: {
    listEntries: jest.fn(),
    upcomingOccurrences: jest.fn(),
  },
  places: { listPlaces: jest.fn() },
  geofences: { listAllTriggers: jest.fn(), deactivateTrigger: jest.fn() },
  settings: { getAll: jest.fn() },
};

jest.mock('@/repositories', () => ({ getRepositories: () => mockRepos }));

/* `@/hooks/useSystem` binds expo-location, the calendar and the speech
   recogniser at import time. Places only asks it four questions, so the whole
   native surface is replaced by the answers. */
let mockMonitored = 0;
let mockDropped = 0;
const mockRefreshGeofences = jest.fn();
jest.mock('@/hooks/useSystem', () => ({
  useCurrentPosition: () => ({ mutate: jest.fn(), isPending: false }),
  useReverseGeocode: () => ({ mutate: jest.fn(), isPending: false }),
  useRefreshGeofences: () => ({ mutate: mockRefreshGeofences, isPending: false }),
  useGeofenceStatus: () => ({
    data: { monitored: mockMonitored, dropped: mockDropped, capped: mockDropped > 0, totalActive: 0 },
  }),
}));

/* Reanimated 4 boots its worklets runtime on import and has no native side
   here; the toast stack (pulled in by the component barrel) is the only thing
   in these trees that touches it. */
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

import CurriculumScreen from '../../../app/curriculum';
import PlacesScreen from '../../../app/places';

/** Without seeded metrics the provider withholds its children until layout. */
const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

// RNTL 14 renders asynchronously; every render/press must be awaited.
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

function classRow(over: Partial<CurriculumEntry> & { subjectName: string }): CurriculumEntry {
  return {
    id: over.subjectName.toLowerCase(),
    dayOfWeek: 1,
    startTime: '08:00',
    endTime: '09:30',
    location: null,
    weekParity: 'every',
    teacher: null,
    color: null,
    isActive: true,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function place(over: Partial<SavedPlace> & { label: string }): SavedPlace {
  return {
    id: over.label,
    latitude: 42.6977,
    longitude: 23.3219,
    radiusMeters: 150,
    address: null,
    createdAt: 0,
    ...over,
  };
}

function trigger(over: Partial<GeofenceTrigger> & { id: string; label: string }): GeofenceTrigger {
  return {
    latitude: 42.6977,
    longitude: 23.3219,
    radiusMeters: 150,
    triggerType: 'ENTER',
    actionDescription: `Do something at ${over.label}`,
    isActive: true,
    placeId: null,
    taskId: null,
    oneShot: false,
    cooldownSeconds: 900,
    lastTriggeredAt: null,
    expiresAt: null,
    registered: true,
    createdAt: 0,
    ...over,
  };
}

beforeEach(() => {
  mockMonitored = 0;
  mockDropped = 0;
  mockRefreshGeofences.mockReset();
  mockRepos.curriculum.listEntries.mockResolvedValue([]);
  mockRepos.curriculum.upcomingOccurrences.mockResolvedValue([]);
  mockRepos.places.listPlaces.mockResolvedValue([]);
  mockRepos.geofences.listAllTriggers.mockResolvedValue([]);
  mockRepos.settings.getAll.mockResolvedValue(defaultSettings());
});

describe('programme screen', () => {
  it('teaches the voice path when there is no timetable', async () => {
    await wrap(<CurriculumScreen />);
    expect(
      await screen.findByText("Try: 'every Monday at 8 I have Physics, Tuesday at 10 Math'"),
    ).toBeTruthy();
  });

  it('lists a class with its parity and the next occurrence homework will use', async () => {
    const entry = classRow({
      subjectName: 'Physics',
      dayOfWeek: 2,
      startTime: '10:00',
      endTime: '11:30',
      location: 'Room 204',
      teacher: 'Mrs Petrova',
      weekParity: 'odd',
    });
    const startsAt = Date.now() + 3 * 86_400_000;
    mockRepos.curriculum.listEntries.mockResolvedValue([entry]);
    mockRepos.curriculum.upcomingOccurrences.mockResolvedValue([
      { entry, startsAt, endsAt: startsAt + 5_400_000 },
    ]);

    await wrap(<CurriculumScreen />);
    await fireEvent.press(await screen.findByText('List'));

    expect(screen.getByText('Physics')).toBeTruthy();
    expect(screen.getByText('10:00–11:30')).toBeTruthy();
    expect(screen.getByText('Room 204 · Mrs Petrova')).toBeTruthy();
    expect(screen.getByText('ODD')).toBeTruthy();
    expect(screen.getByText(/^Next /)).toBeTruthy();
  });

  it('keeps a switched-off class visible but out of the next-occurrence line', async () => {
    mockRepos.curriculum.listEntries.mockResolvedValue([
      classRow({ subjectName: 'Chemistry', isActive: false }),
    ]);

    await wrap(<CurriculumScreen />);
    await fireEvent.press(await screen.findByText('List'));

    expect(screen.getByText('Chemistry')).toBeTruthy();
    expect(screen.getByText('OFF')).toBeTruthy();
    expect(screen.queryByText(/^Next /)).toBeNull();
  });
});

describe('places screen', () => {
  it('coaches the user with a spoken example when nothing is pinned', async () => {
    await wrap(<PlacesScreen />);
    expect(
      await screen.findByText(
        "Try: 'remind me to buy milk when I get to the supermarket' — then pin it here.",
      ),
    ).toBeTruthy();
  });

  it('shows a place with its radius and how many reminders hang off it', async () => {
    mockRepos.places.listPlaces.mockResolvedValue([place({ label: 'the lab', address: '12 Sofia St' })]);
    mockRepos.geofences.listAllTriggers.mockResolvedValue([
      trigger({ id: 't1', label: 'the lab', placeId: 'the lab' }),
    ]);
    mockMonitored = 1;

    await wrap(<PlacesScreen />);
    expect(await screen.findByText('the lab')).toBeTruthy();
    expect(screen.getByText('12 Sofia St')).toBeTruthy();
    expect(screen.getByText('150 m · 1 reminder here')).toBeTruthy();
    expect(screen.getByText('WATCHING')).toBeTruthy();
  });

  /* Deactivating writes a row; it does not un-register the region. Without the
     refresh the phone keeps watching a reminder the user just switched off and
     fires it on the next crossing. */
  it('hands the region back to the OS when a reminder is switched off', async () => {
    mockRepos.geofences.listAllTriggers.mockResolvedValue([
      trigger({ id: 't1', label: 'the lab' }),
    ]);
    mockRepos.geofences.deactivateTrigger.mockResolvedValue(true);

    await wrap(<PlacesScreen />);
    await fireEvent.press(
      await screen.findByLabelText('Switch off the reminder at the lab'),
    );

    await waitFor(() => expect(mockRefreshGeofences).toHaveBeenCalled());
    expect(mockRepos.geofences.deactivateTrigger).toHaveBeenCalledWith('t1');
  });

  it('explains the twenty-region cap when the OS is watching fewer than are live', async () => {
    mockRepos.geofences.listAllTriggers.mockResolvedValue(
      Array.from({ length: 22 }, (_, i) => trigger({ id: `t${i}`, label: `place ${i}` })),
    );
    mockMonitored = 20;
    mockDropped = 2;

    await wrap(<PlacesScreen />);
    expect(await screen.findByText('2 of 22 reminders are not being watched')).toBeTruthy();
  });
});
