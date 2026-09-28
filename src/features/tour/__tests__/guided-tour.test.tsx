/**
 * The tour, and the four ways it can go wrong quietly.
 *
 * It is the first thing a new install sees after the disclosure, and it now
 * *walks the app* — nine screens, opened one at a time — rather than sitting on
 * home. So the failure modes it has are navigation's: a step that draws before
 * its screen has arrived, a walk that leaves somebody nine Backs from where
 * they started, and a close offered in the middle of it that strands them on
 * the Places screen with no idea how they got there.
 *
 * The router here is a real little state machine rather than a bag of spies,
 * because what is being asserted is the *route the user ends up on*, and a
 * `push` mock that records a call without moving cannot answer that.
 */
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';

import { ThemeProvider } from '@/ui/ThemeProvider';

import { GuidedTour } from '../GuidedTour';
import { TourProvider } from '../TourContext';
import { TOUR_STEPS } from '../steps';

let mockSeen = false;
let mockLoading = false;
const mockSet = jest.fn();

jest.mock('@/hooks/useSettings', () => {
  const { useRef } = jest.requireActual('react') as typeof import('react');
  return {
    useSetting: () => {
      // Mocked as a hook, because it is one. A mock that calls none makes the
      // render counts match and hides the crash a hook below an early return
      // produces on a device.
      useRef(null);
      return {
        value: mockSeen,
        isLoading: mockLoading,
        error: null,
        set: mockSet,
        setAsync: jest.fn(),
        isSaving: false,
      };
    },
  };
});

/**
 * The navigation stack, as the tour actually moves it.
 *
 * A real little state machine rather than a bag of spies: what is asserted here
 * is *the route the user ends up on*, and a `push` mock that records a call
 * without moving cannot answer that. It is also subscribed to rather than read,
 * because expo-router's `usePathname` is reactive — a mock that reads a module
 * variable navigates correctly and never re-renders, so every assertion after
 * the first press looks for a card that was never redrawn.
 */
let mockStack: string[] = ['/'];
const mockListeners = new Set<() => void>();
const mockGo = (change: () => void) => {
  change();
  mockListeners.forEach((listener) => listener());
};
const path = () => mockStack[mockStack.length - 1]!;

jest.mock('expo-router', () => {
  const { useSyncExternalStore } = jest.requireActual('react') as typeof import('react');
  // Stable, like the real one: a fresh object each render would re-run every
  // effect that depends on the router.
  const router = {
    push: (href: string) => mockGo(() => void mockStack.push(href)),
    replace: (href: string) =>
      mockGo(() => {
        mockStack[mockStack.length - 1] = href;
      }),
    dismissAll: () =>
      mockGo(() => {
        mockStack = ['/'];
      }),
    canGoBack: () => mockStack.length > 1,
    back: () => mockGo(() => void mockStack.pop()),
    navigate: jest.fn(),
  };
  return {
    usePathname: () =>
      useSyncExternalStore(
        (notify: () => void) => {
          mockListeners.add(notify);
          return () => mockListeners.delete(notify);
        },
        () => mockStack[mockStack.length - 1],
      ),
    useRouter: () => router,
  };
});

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const wrap = (enabled = true) =>
  render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider>
        <TourProvider>
          <GuidedTour enabled={enabled} />
        </TourProvider>
      </ThemeProvider>
    </SafeAreaProvider>,
  );

/**
 * Press Next and let the hop land.
 *
 * A hop is one navigation now — pushed from home, replaced between screens —
 * so there is no timer to run out. The clock is advanced anyway because the
 * card's own entrance is animated and a pending frame would otherwise leak an
 * `act()` scope into the next test.
 */
const next = async () => {
  await fireEvent.press(screen.getByTestId('guided-tour-next'));
  await act(async () => {
    jest.advanceTimersByTime(500);
  });
  expect(screen.getByTestId('guided-tour-card')).toBeTruthy();
};

beforeEach(() => {
  jest.useFakeTimers();
  mockSeen = false;
  mockLoading = false;
  mockStack = ['/'];
  mockListeners.clear();
  mockSet.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('the guided tour', () => {
  it('starts on the first step of the real screen', async () => {
    await wrap();

    expect(await screen.findByTestId('guided-tour')).toBeTruthy();
    expect(screen.getByText(TOUR_STEPS[0]!.title)).toBeTruthy();
    expect(screen.getByText(`1 of ${TOUR_STEPS.length}`)).toBeTruthy();
  });

  /*
   * The point of the rewrite. A voice app has no menu, so a screen nobody has
   * been shown is a capability nobody knows about — "spent fifteen forty on
   * lunch" is not a sentence anybody guesses at a microphone.
   */
  it('opens the screen each step is about', async () => {
    await wrap();

    for (const [i, expected] of TOUR_STEPS.entries()) {
      expect(path()).toBe(expected.route);
      expect(screen.getByText(expected.title)).toBeTruthy();
      if (i < TOUR_STEPS.length - 1) await next();
    }
  });

  /*
   * Straight to the screen, and never through anything else.
   *
   * It walked through `/menu` for a while — the reasoning being that a person
   * shown nine screens learns nothing about reaching them — and the reasoning
   * was right about the problem and wrong about the price. The menu is a
   * presented sheet, so every hop became five moves and about three seconds:
   * sheet up, row lit, row pressed, sheet down, screen in. Nine of those is a
   * tour nobody finishes, and it was rejected on a real phone twice. Step four
   * rings the menu button on home instead, which is where somebody looks for
   * it, and the last step says what else is in there.
   */
  it('never detours through the menu', async () => {
    await wrap();
    const seenRoutes: string[] = [];
    mockListeners.add(() => seenRoutes.push(path()));

    for (let i = 0; i < TOUR_STEPS.length - 1; i += 1) await next();

    expect(seenRoutes).not.toContain('/menu');
    expect(seenRoutes.length).toBeGreaterThan(0);
  });

  /* One stack frame for home and one for whatever is being looked at, however
     many screens it walks: pushed from home, replaced between screens. Nine
     pushes would leave somebody nine Backs from where they started. */
  it('never leaves a stack to climb back out of', async () => {
    await wrap();
    for (let i = 0; i < TOUR_STEPS.length - 1; i += 1) {
      await next();
      expect(mockStack.length).toBeLessThanOrEqual(2);
    }
  });

  it('covers the parts of the app a microphone cannot advertise', async () => {
    const routes = TOUR_STEPS.map((s) => s.route);
    for (const route of ['/calendar', '/tasks', '/notes', '/ledger', '/habits', '/places']) {
      expect(routes).toContain(route);
    }
  });

  /* A blank screen with a caption teaches nothing, so every step that is not
     pointing at a real control on home carries a faked example instead. */
  it('shows something on every step that has nothing to point at', async () => {
    for (const step of TOUR_STEPS) {
      if (step.target) continue;
      expect(step.sample).toBeTruthy();
    }
  });

  it('walks every step and marks itself seen at the end', async () => {
    await wrap();

    for (let i = 0; i < TOUR_STEPS.length - 1; i += 1) await next();

    expect(screen.getByText(TOUR_STEPS.at(-1)!.title)).toBeTruthy();
    expect(mockSet).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('guided-tour-next'));
    expect(mockSet).toHaveBeenCalledWith(true);
    // And it is *gone*, not merely recorded. `mockSet` here never changes what
    // the hook reports, which is the real behaviour of a mutation that has not
    // come back yet — and ending the tour on the setting alone left the card up
    // for the length of a database round trip, showing step one again on the
    // way out because `finish` had already reset the index.
    expect(screen.queryByTestId('guided-tour-card')).toBeNull();
  });

  /*
   * There is no close, on any step, by decision.
   *
   * One was offered on the home steps and taken out: a corner × on the first
   * screen of an app somebody has just installed is a thing to press to make
   * the app start, and pressing it skipped the only explanation the product
   * gets to give. The walk is fourteen taps of Next and it ends by coming home
   * — that is the way out.
   */
  it('has no close on it', async () => {
    await wrap();
    expect(screen.queryByTestId('guided-tour-close')).toBeNull();

    while (path() === '/') await next();
    expect(screen.queryByTestId('guided-tour-close')).toBeNull();
  });

  it('comes home when it is over', async () => {
    await wrap();
    for (let i = 0; i < TOUR_STEPS.length - 1; i += 1) await next();
    await fireEvent.press(screen.getByTestId('guided-tour-next'));

    expect(path()).toBe('/');
  });

  /*
   * Started from somewhere that is not a step, with nothing underneath it.
   *
   * "Show me around" lives on `/examples`, and that screen can be the *only*
   * thing on the stack — opened by a deep link, or the app killed while it was
   * open. `dismissAll` is a no-op there, so the tour came up on the examples
   * list, dimmed it, and stayed: no card, no way forward, and the one route
   * every step needs unreachable. Found on a real phone; a simulator that had
   * always reached that screen through home never showed it.
   */
  it('gets home from a screen with nothing underneath it', async () => {
    mockStack = ['/examples'];
    await wrap();

    await act(async () => {
      jest.advanceTimersByTime(500);
    });

    expect(path()).toBe('/');
    expect(await screen.findByTestId('guided-tour-card')).toBeTruthy();
    expect(screen.getByText(TOUR_STEPS[0]!.title)).toBeTruthy();
  });

  it('does not run once it has been seen', async () => {
    mockSeen = true;
    await wrap();

    expect(screen.queryByTestId('guided-tour')).toBeNull();
  });

  /*
   * The guard that costs a frame of the microphone if it is missing.
   *
   * `useSetting` reports the declared default — `false`, "never seen" — until
   * SQLite answers, so without this the tour flashes over the first frame of
   * every launch on every install that has already walked it. `ConsentGate`
   * needs the same guard for the same reason, which is what makes it a rule.
   */
  it('draws nothing until the row has actually been read', async () => {
    mockLoading = true;
    await wrap();

    expect(screen.queryByTestId('guided-tour')).toBeNull();
  });

  it('waits for the screen it points at', async () => {
    await wrap(false);

    expect(screen.queryByTestId('guided-tour')).toBeNull();
  });

  /* A spotlight is a shape, so a person who cannot see it gets nothing from the
     tour at all unless the card says the same thing in words. */
  it('says each step out loud', async () => {
    await wrap();

    const card = await screen.findByTestId('guided-tour-card');
    await waitFor(() => expect(card.props.accessibilityLiveRegion).toBeDefined());
    expect(screen.getByText(TOUR_STEPS[0]!.body)).toBeTruthy();
  });
});
