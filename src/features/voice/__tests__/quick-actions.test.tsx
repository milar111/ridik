/**
 * The launcher long-press, which has to fire exactly once per tap.
 *
 * `expo-quick-actions/hooks` cannot deliver that, and the way it fails is
 * invisible in a diff: `useQuickActionCallback`'s effect depends on
 * `[QuickActions.initial, callback]`, `initial` is a module-level constant that
 * is read once at load and never cleared, and an inline callback is a new
 * identity on every render. So the effect re-runs on every render of its host
 * and re-delivers the same launch action each time.
 *
 * That was harmless while the handler called `startListening()` — a redundant
 * start on an already-listening store. It stopped being harmless when the
 * handler learned to *navigate*: the host is `VoiceDock`, mounted app-wide and
 * re-rendering on every path change and every partial transcript, so one
 * long-press meant the user could not open the menu (popped back to home on the
 * next render) and could not finish a sentence (each partial re-armed home,
 * which restarts the recogniser and discards the utterance in flight).
 */
import { render } from '@testing-library/react-native';
import { Text } from 'react-native';

const mockNavigate = jest.fn();
const mockPush = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({
    navigate: mockNavigate,
    push: mockPush,
    replace: jest.fn(),
    back: jest.fn(),
    setParams: jest.fn(),
    canGoBack: () => true,
  }),
}));

/* The library as it actually behaves: `initial` is whatever the app was
   launched with, evaluated at import and never cleared. */
let mockInitial: { id: string; params?: Record<string, string> } | null = null;
const mockListeners: ((action: unknown) => void)[] = [];
const mockSetItems = jest.fn(async () => {});
jest.mock('expo-quick-actions', () => ({
  get initial() {
    return mockInitial;
  },
  setItems: (...args: unknown[]) => mockSetItems(...(args as [])),
  addListener: (listener: (action: unknown) => void) => {
    mockListeners.push(listener);
    return {
      remove: () => {
        const index = mockListeners.indexOf(listener);
        if (index >= 0) mockListeners.splice(index, 1);
      },
    };
  },
}));

import { resetQuickActionsForTest, useQuickActionRouting } from '../useQuickActions';

function Harness({ tick }: { tick: number }) {
  useQuickActionRouting();
  return <Text>{`dock ${tick}`}</Text>;
}

beforeEach(() => {
  mockNavigate.mockClear();
  mockPush.mockClear();
  mockSetItems.mockClear();
  mockListeners.length = 0;
  mockInitial = null;
  resetQuickActionsForTest();
});

describe('the launcher long-press', () => {
  it('opens the microphone once for one launch, however often the dock re-renders', async () => {
    mockInitial = { id: 'speak', params: { action: 'speak' } };

    const view = await render(<Harness tick={0} />);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith({ pathname: '/', params: { speak: '1' } });

    // What the real host does constantly: a path change, then a partial
    // transcript, then another. Each one is a render of `VoiceDock`.
    await view.rerender(<Harness tick={1} />);
    await view.rerender(<Harness tick={2} />);
    await view.rerender(<Harness tick={3} />);

    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });

  it('does not replay the launch action when the dock is mounted again', async () => {
    mockInitial = { id: 'speak', params: { action: 'speak' } };

    const first = await render(<Harness tick={0} />);
    await first.unmount();
    await render(<Harness tick={0} />);

    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });

  /* A genuine second long-press arrives as an event rather than as `initial`,
     and it is a genuine second intent. */
  it('honours a long-press made while the app was already running', async () => {
    await render(<Harness tick={0} />);
    expect(mockNavigate).not.toHaveBeenCalled();

    for (const listener of [...mockListeners]) listener({ id: 'speak', params: { action: 'speak' } });
    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });

  it('opens the briefing once for the other action', async () => {
    mockInitial = { id: 'briefing', params: { action: 'briefing' } };

    const view = await render(<Harness tick={0} />);
    await view.rerender(<Harness tick={1} />);

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/briefing');
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('publishes both actions to the OS, once', async () => {
    const view = await render(<Harness tick={0} />);
    await view.rerender(<Harness tick={1} />);

    expect(mockSetItems).toHaveBeenCalledTimes(1);
    expect((mockSetItems.mock.calls[0] as unknown as [{ id: string }[]])[0].map((a) => a.id)).toEqual(
      ['speak', 'briefing'],
    );
  });

  it('leaves the app alone on an ordinary launch', async () => {
    await render(<Harness tick={0} />);
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
