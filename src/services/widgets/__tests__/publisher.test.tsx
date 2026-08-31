import { render } from '@testing-library/react-native';

import { useWidgetPublisher } from '@/hooks/useWidgetPublisher';
import { setEmberChoice } from '@/hooks/useEmber';
import { DEFAULT_EMBER } from '@/ui/theme';

jest.mock('@/hooks/useToday', () => ({ useToday: jest.fn() }));
jest.mock('@/features/today/useNow', () => ({ useNow: jest.fn() }));
jest.mock('@/hooks/useChecklists', () => ({
  useChecklistNames: jest.fn(),
  useChecklistItems: jest.fn(),
}));
jest.mock('@/services/widgets/publish', () => ({ publishWidgetSnapshot: jest.fn() }));
jest.mock('@/hooks/useWidgetSources', () => ({ useWidgetSources: jest.fn() }));
/**
 * Mocked **as a hook**, not as a plain function.
 *
 * `useActiveFocusSession` calls `useQuery`, and a stub that calls nothing makes
 * the hook counts match by accident — which is how a real hook-order fork gets
 * past a test that was written for it (AGENTS.md records the `PlanGroup` case).
 * `useRef` here keeps this stub costing exactly one hook, as the real one does.
 */
jest.mock('@/hooks/useFocus', () => {
  const { useRef } = jest.requireActual('react');
  return {
    useActiveFocusSession: () => useRef({ data: null, isPending: false }).current,
  };
});

const { useToday } = jest.requireMock('@/hooks/useToday');
const { useNow } = jest.requireMock('@/features/today/useNow');
const checklists = jest.requireMock('@/hooks/useChecklists');
const { publishWidgetSnapshot } = jest.requireMock('@/services/widgets/publish');
const { useWidgetSources } = jest.requireMock('@/hooks/useWidgetSources');

const NOW = 1_786_575_000_000;

function Probe(): null {
  useWidgetPublisher();
  return null;
}

/** Enough of a `TodaySnapshot` for the builder; the shape is asserted elsewhere. */
const TODAY = {
  date: '2026-08-13',
  zone: 'Europe/Sofia',
  at: NOW,
  dayStart: NOW - 3_600_000,
  dayEnd: NOW + 3_600_000,
  events: [],
  classes: [],
  dueTasks: [],
  overdueTasks: [],
  habits: [],
  commitments: [],
  focus: null,
  sync: { pending: 0, inFlight: 0, failed: 0, badge: 0 },
  activity: [],
};

const pending = () => ({ data: undefined, isPending: true });
const settled = (data: unknown) => ({ data, isPending: false });
/** A query that failed: no data, but no longer pending either. */
const failed = () => ({ data: undefined, isPending: false });

function setup({
  names,
  items,
  sourcesSettled = true,
}: {
  names: { data: unknown; isPending: boolean };
  items: { data: unknown; isPending: boolean };
  sourcesSettled?: boolean;
}) {
  useToday.mockReturnValue({ data: TODAY });
  useNow.mockReturnValue(NOW);
  checklists.useChecklistNames.mockReturnValue(names);
  checklists.useChecklistItems.mockReturnValue(items);
  useWidgetSources.mockReturnValue({
    monthEvents: [],
    habitHistory: {},
    counts: { events: 0, tasks: 0, habits: 0, lists: 0 },
    settled: sourcesSettled,
  });
}

const published = () => publishWidgetSnapshot.mock.calls.at(-1)?.[0];

describe('useWidgetPublisher', () => {
  /* Today resolves a beat before the checklists do. Publishing in that gap
     writes `list: null`, which the list widget draws as "No lists yet" — and
     if the app closes before the next publish, that sentence is what stays on
     the home screen while the list still exists. */
  it('does not publish a day whose lists have not answered yet', async () => {
    setup({ names: pending(), items: pending() });

    await render(<Probe />);

    expect(publishWidgetSnapshot).not.toHaveBeenCalled();
  });

  it('waits for the items too, not just the names', async () => {
    setup({ names: settled([{ name: 'Hardware', open: 2, total: 5 }]), items: pending() });

    await render(<Probe />);

    expect(publishWidgetSnapshot).not.toHaveBeenCalled();
  });

  it('publishes the list once both have answered', async () => {
    setup({
      names: settled([{ name: 'Hardware', open: 2, total: 5 }]),
      items: settled([
        { itemText: 'M4 bolts', isCompleted: false },
        { itemText: 'Threadlock', isCompleted: true },
      ]),
    });

    await render(<Probe />);

    expect(published().list).toEqual({
      name: 'Hardware',
      open: 1,
      total: 2,
      rows: [
        { text: 'M4 bolts', done: false },
        { text: 'Threadlock', done: true },
      ],
    });
  });

  /* A disabled query stays pending forever in TanStack v5, so a gate that only
     watched `items` would never open for someone who keeps no lists at all. */
  it('publishes for someone who has no lists rather than waiting forever', async () => {
    setup({ names: settled([]), items: pending() });

    await render(<Probe />);

    expect(published().list).toBeNull();
  });

  /* One failing checklist query must not hold the other four widgets hostage. */
  it('publishes the rest of the day when the lists fail to load', async () => {
    setup({ names: failed(), items: pending() });

    await render(<Probe />);

    expect(published().list).toBeNull();
    expect(published().version).toBeGreaterThan(0);
  });

  /* The month and the habit rails are the first widget data that is not already
     in TodaySnapshot. Publishing before they answer draws a blank August over a
     month that has events in it. */
  it('waits for the month and the rails as well as the lists', async () => {
    setup({ names: settled([]), items: pending(), sourcesSettled: false });

    await render(<Probe />);

    expect(publishWidgetSnapshot).not.toHaveBeenCalled();
  });

  /* The widgets have to be drawn in the colour the app is drawn in, and both
     read it from the same store — so a publish cannot go out in last week's
     palette while the screen behind it is already in this week's. */
  it('publishes the ember the app is painting with', async () => {
    setup({ names: settled([]), items: pending() });
    setEmberChoice('rust');

    await render(<Probe />);

    expect(published().ember).toBe('rust');
    setEmberChoice(DEFAULT_EMBER);
  });

  it('shows the list with something still open on it, not merely the first', async () => {
    setup({
      names: settled([
        { name: 'Done with', open: 0, total: 3 },
        { name: 'Hardware', open: 2, total: 5 },
      ]),
      items: settled([{ itemText: 'M4 bolts', isCompleted: false }]),
    });

    await render(<Probe />);

    expect(published().list.name).toBe('Hardware');
  });
});
