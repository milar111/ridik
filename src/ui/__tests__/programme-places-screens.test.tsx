import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ok } from '@/core/result';
import type { CurriculumEntry, GeofenceTrigger, SavedPlace } from '@/db/schema';
import { defaultSettings } from '@/repositories/settings';

import { ThemeProvider } from '../ThemeProvider';

/* The screens read through the real hooks; only the repository layer under them
   is faked, so the query keys and the render paths are the production ones. */
const mockRepos = {
  curriculum: {
    listEntries: jest.fn(),
    upcomingOccurrences: jest.fn(),
    updateEntry: jest.fn(),
    deleteEntry: jest.fn(),
  },
  places: { listPlaces: jest.fn(), upsertPlace: jest.fn(), deletePlace: jest.fn() },
  geofences: {
    listAllTriggers: jest.fn(),
    deactivateTrigger: jest.fn(),
    deleteTrigger: jest.fn(),
  },
  settings: { getAll: jest.fn() },
};

jest.mock('@/repositories', () => ({ getRepositories: () => mockRepos }));

/* `@/hooks/useSystem` binds expo-location, the calendar and the speech
   recogniser at import time. Places only asks it four questions, so the whole
   native surface is replaced by the answers. */
let mockMonitored = 0;
let mockDropped = 0;
/* Both halves of the "nothing is being watched" story: the OS refusing, and
   the cap. The screen has to tell them apart. */
let mockPermission = {
  available: true,
  foreground: true,
  background: true,
  granted: true,
  canAskAgain: false,
  needsBackgroundExplanation: false,
};
const mockRequestPermission = jest.fn();
const mockRefreshGeofences = jest.fn();
/* The pin is the only way coordinates enter the screen now, so both halves of
   it answer: a fix, then the address that fix reverse-geocodes to. */
const mockLocate = jest.fn();
const mockAddressSearch = jest.fn();
const mockGeocode = jest.fn();
jest.mock('@/hooks/useSystem', () => ({
  useCurrentPosition: () => ({ mutate: mockLocate, isPending: false }),
  useReverseGeocode: () => ({ mutate: mockGeocode, isPending: false }),
  useGeocodeAddress: () => ({ mutate: mockAddressSearch, isPending: false }),
  useRefreshGeofences: () => ({ mutate: mockRefreshGeofences, isPending: false }),
  useRequestPermission: () => ({ mutate: mockRequestPermission, isPending: false }),
  useGeofenceStatus: () => ({
    data: {
      monitored: mockMonitored,
      dropped: mockDropped,
      capped: mockDropped > 0,
      totalActive: 0,
      permission: mockPermission,
    },
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
  mockPermission = {
    available: true,
    foreground: true,
    background: true,
    granted: true,
    canAskAgain: false,
    needsBackgroundExplanation: false,
  };
  mockRequestPermission.mockReset();
  mockRefreshGeofences.mockReset();
  mockLocate.mockReset();
  mockGeocode.mockReset();
  mockLocate.mockImplementation((_input, options) =>
    options?.onSuccess?.({ latitude: 42.7, longitude: 23.3 }),
  );
  mockGeocode.mockImplementation((_coords, options) => options?.onSuccess?.('12 Sofia St'));
  mockRepos.curriculum.listEntries.mockResolvedValue([]);
  mockRepos.curriculum.upcomingOccurrences.mockResolvedValue([]);
  mockRepos.curriculum.updateEntry.mockImplementation(async (_id, patch) =>
    ok(classRow({ subjectName: 'Chemistry', ...patch })),
  );
  mockRepos.curriculum.deleteEntry.mockResolvedValue(true);
  mockRepos.places.listPlaces.mockResolvedValue([]);
  mockRepos.places.upsertPlace.mockResolvedValue(place({ label: 'the lab' }));
  mockRepos.places.deletePlace.mockResolvedValue(true);
  mockRepos.geofences.listAllTriggers.mockResolvedValue([]);
  mockRepos.geofences.deleteTrigger.mockResolvedValue(true);
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

  /* Switching a class off left it on screen while quietly removing it from the
     dates homework resolves against; the sheet no longer offers that state. */
  it('has no active toggle in the entry sheet', async () => {
    mockRepos.curriculum.listEntries.mockResolvedValue([classRow({ subjectName: 'Physics' })]);

    await wrap(<CurriculumScreen />);
    await fireEvent.press(await screen.findByText('List'));
    await fireEvent.press(screen.getByLabelText('Edit Physics'));

    expect(screen.getByText('Edit class')).toBeTruthy();
    expect(screen.queryByLabelText('Active')).toBeNull();
    expect(screen.queryByText(/never counts towards a due date/)).toBeNull();
  });

  /* Rows switched off before the toggle went are the only inactive ones left,
     and with no control for it the save is the only way back on. */
  it('switches a class back on when it is saved', async () => {
    mockRepos.curriculum.listEntries.mockResolvedValue([
      classRow({ subjectName: 'Chemistry', isActive: false }),
    ]);

    await wrap(<CurriculumScreen />);
    await fireEvent.press(await screen.findByText('List'));
    await fireEvent.press(screen.getByLabelText('Edit Chemistry'));
    await fireEvent.press(screen.getByText('Save'));

    await waitFor(() =>
      expect(mockRepos.curriculum.updateEntry).toHaveBeenCalledWith(
        'chemistry',
        expect.objectContaining({ isActive: true }),
      ),
    );
  });

  it('asks before deleting a class', async () => {
    mockRepos.curriculum.listEntries.mockResolvedValue([classRow({ subjectName: 'Physics' })]);

    await wrap(<CurriculumScreen />);
    await fireEvent.press(await screen.findByText('List'));
    await fireEvent.press(screen.getByLabelText('Edit Physics'));
    await fireEvent.press(screen.getByText('Delete'));

    expect(mockRepos.curriculum.deleteEntry).not.toHaveBeenCalled();
    expect(screen.getByText(/^Delete “Physics”/)).toBeTruthy();

    await fireEvent.press(screen.getByText('Keep'));
    expect(screen.queryByText(/^Delete “Physics”/)).toBeNull();

    // The first press reopens the confirm; only the one inside it deletes.
    await fireEvent.press(screen.getByText('Delete'));
    await fireEvent.press(screen.getByText('Delete'));
    await waitFor(() => expect(mockRepos.curriculum.deleteEntry).toHaveBeenCalledWith('physics'));
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

  /* Foreground-only location is where the OS leaves every Android user who
     answers "While using the app", and it stops every region — so the screen
     must not blame the cap for it and send them pruning reminders that were
     never the problem. */
  it('blames the missing permission, not the cap, when the OS is watching nothing', async () => {
    mockRepos.geofences.listAllTriggers.mockResolvedValue([trigger({ id: 't1', label: 'the lab' })]);
    mockMonitored = 0;
    mockPermission = {
      ...mockPermission,
      background: false,
      granted: false,
      canAskAgain: true,
      needsBackgroundExplanation: true,
    };

    await wrap(<PlacesScreen />);

    expect(await screen.findByText('1 reminder waiting on location access')).toBeTruthy();
    expect(screen.queryByText(/wait their turn/)).toBeNull();

    await fireEvent.press(screen.getByText('Allow always'));
    expect(mockRequestPermission).toHaveBeenCalledWith('location');
  });

  it('sends a hard-refused permission to system settings rather than a dead button', async () => {
    mockRepos.geofences.listAllTriggers.mockResolvedValue([trigger({ id: 't1', label: 'the lab' })]);
    mockMonitored = 0;
    mockPermission = { ...mockPermission, background: false, granted: false, canAskAgain: false };

    await wrap(<PlacesScreen />);

    expect(await screen.findByText('Open settings')).toBeTruthy();
    expect(screen.queryByText('Allow always')).toBeNull();
  });

  /* One wrong digit used to move a geofence to another country, and there is no
     map on this screen to catch it against: the pin comes from the phone. */
  it('pins a place you are not standing in, by name rather than by coordinate', async () => {
    // Deleting the latitude/longitude fields removed the only way to add a
    // place you are not currently at. An address is the safe replacement: a
    // wrong one reads wrong, where a wrong digit in 42.6501 does not.
    mockAddressSearch.mockImplementation((query: string, opts: { onSuccess: (r: unknown) => void }) =>
      opts.onSuccess({ coords: { latitude: 42.65, longitude: 23.38 }, address: query }),
    );

    await wrap(<PlacesScreen />);
    await fireEvent.press(await screen.findByText('Add'));
    await fireEvent.changeText(screen.getByTestId('place-name'), 'the lab');
    await fireEvent.changeText(
      screen.getByTestId('place-address-search'),
      'Technical University, Sofia',
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Find' }));

    expect(mockAddressSearch).toHaveBeenCalledWith(
      'Technical University, Sofia',
      expect.anything(),
    );
    expect(screen.getByText('Technical University, Sofia')).toBeTruthy();
  });

  it('takes a pin from the phone instead of typed coordinates', async () => {
    await wrap(<PlacesScreen />);
    await fireEvent.press(await screen.findByText('Add'));

    expect(screen.getByText('New place')).toBeTruthy();
    expect(screen.queryByText('LATITUDE')).toBeNull();
    expect(screen.queryByText('LONGITUDE')).toBeNull();
    expect(screen.queryByText('Look up address')).toBeNull();
    expect(screen.getByText(/^Not pinned yet/)).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('place-name'), 'the lab');
    await fireEvent.press(screen.getByText('Add place'));
    expect(mockRepos.places.upsertPlace).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByText('Use my current location'));
    // The address is reverse-geocoded off the fix, not typed.
    expect(screen.getByText('12 Sofia St')).toBeTruthy();

    await fireEvent.press(screen.getByText('Add place'));
    await waitFor(() =>
      expect(mockRepos.places.upsertPlace).toHaveBeenCalledWith({
        label: 'the lab',
        latitude: 42.7,
        longitude: 23.3,
        radiusMeters: 150,
        address: '12 Sofia St',
      }),
    );
  });

  /* The pin moved, so the street that described the old one is a lie, and there
     is no field left to correct it in. */
  it('drops the old address when the pin moves and the lookup gives nothing back', async () => {
    mockRepos.places.listPlaces.mockResolvedValue([
      place({ label: 'the lab', address: '12 Sofia St' }),
    ]);
    mockGeocode.mockImplementation(() => undefined);

    await wrap(<PlacesScreen />);
    await fireEvent.press(await screen.findByLabelText('Edit the lab'));
    // Once in the row behind the sheet, once in the sheet.
    expect(screen.getAllByText('12 Sofia St')).toHaveLength(2);

    await fireEvent.press(screen.getByText('Use my current location'));
    expect(screen.getAllByText('12 Sofia St')).toHaveLength(1);
    expect(screen.getByText('42.7000, 23.3000')).toBeTruthy();
  });

  /* `place_save` takes anything from 50 m to 5 km. Snapping that to the nearest
     named size showed the wrong circle and then made the display true. */
  it('keeps a stored radius the named sizes cannot express', async () => {
    mockRepos.places.listPlaces.mockResolvedValue([
      place({ label: 'the lab', radiusMeters: 2000 }),
    ]);

    await wrap(<PlacesScreen />);
    await fireEvent.press(await screen.findByLabelText('Edit the lab'));
    await fireEvent.press(screen.getByText('Save place'));

    await waitFor(() =>
      expect(mockRepos.places.upsertPlace).toHaveBeenCalledWith(
        expect.objectContaining({ radiusMeters: 2000 }),
      ),
    );
  });

  /* `upsertPlace` keys on the label, so a rename inserted a second row and left
     every reminder anchored to the one it had just orphaned. */
  it('will not rename a place that already exists', async () => {
    mockRepos.places.listPlaces.mockResolvedValue([place({ label: 'the lab' })]);

    await wrap(<PlacesScreen />);
    await fireEvent.press(await screen.findByLabelText('Edit the lab'));

    expect(screen.getByText('Edit place')).toBeTruthy();
    expect(screen.queryByTestId('place-name')).toBeNull();
    expect(screen.getByText(/cannot be changed here/)).toBeTruthy();
  });

  it('sizes a place by name rather than by 25 m steps', async () => {
    mockRepos.places.listPlaces.mockResolvedValue([place({ label: 'the lab' })]);

    await wrap(<PlacesScreen />);
    await fireEvent.press(await screen.findByLabelText('Edit the lab'));

    expect(screen.queryByLabelText('Smaller radius')).toBeNull();
    expect(screen.queryByLabelText('Larger radius')).toBeNull();

    await fireEvent.press(screen.getByText('This block · 600 m'));
    await fireEvent.press(screen.getByText('Save place'));
    await waitFor(() =>
      expect(mockRepos.places.upsertPlace).toHaveBeenCalledWith(
        expect.objectContaining({ label: 'the lab', radiusMeters: 600 }),
      ),
    );
  });

  it('asks before deleting a place', async () => {
    mockRepos.places.listPlaces.mockResolvedValue([place({ label: 'the lab' })]);

    await wrap(<PlacesScreen />);
    await fireEvent.press(await screen.findByLabelText('Edit the lab'));
    await fireEvent.press(screen.getByText('Delete'));

    expect(mockRepos.places.deletePlace).not.toHaveBeenCalled();
    expect(screen.getByText(/^Delete “the lab”/)).toBeTruthy();

    await fireEvent.press(screen.getByText('Keep'));
    expect(screen.queryByText(/^Delete “the lab”/)).toBeNull();

    // The first press reopens the confirm; only the one inside it deletes.
    await fireEvent.press(screen.getByText('Delete'));
    await fireEvent.press(screen.getByText('Delete'));
    await waitFor(() => expect(mockRepos.places.deletePlace).toHaveBeenCalledWith('the lab'));
  });

  it('asks before deleting a reminder', async () => {
    mockRepos.geofences.listAllTriggers.mockResolvedValue([
      trigger({ id: 't1', label: 'the lab' }),
    ]);

    await wrap(<PlacesScreen />);
    await fireEvent.press(await screen.findByLabelText('Delete the reminder at the lab'));

    expect(mockRepos.geofences.deleteTrigger).not.toHaveBeenCalled();
    expect(screen.getByText('Delete this reminder for good?')).toBeTruthy();

    await fireEvent.press(screen.getByText('Keep'));
    expect(screen.queryByText('Delete this reminder for good?')).toBeNull();

    await fireEvent.press(screen.getByLabelText('Delete the reminder at the lab'));
    await fireEvent.press(screen.getByLabelText('Yes, delete the reminder at the lab'));
    await waitFor(() => expect(mockRepos.geofences.deleteTrigger).toHaveBeenCalledWith('t1'));
    expect(mockRefreshGeofences).toHaveBeenCalled();
  });
});
