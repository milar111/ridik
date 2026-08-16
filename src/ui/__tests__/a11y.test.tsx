/**
 * The two mechanisms, and the one rule that keeps them from talking over each
 * other: an element either carries `accessibilityLiveRegion` (Android speaks
 * it) or its words are announced (iOS speaks them) — never both on both, which
 * is how a sentence gets said twice.
 *
 * The interesting behaviour is the memory. Announcing on every render would
 * make a screen reader unusable; deduping on the string alone would swallow the
 * *second* identical receipt, which is the one that says the app heard you.
 */
import { AccessibilityInfo, Text } from 'react-native';
import { act, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';

import { ThemeProvider } from '../ThemeProvider';
import { ToastProvider, useToast } from '../components/Toast';
import { useAnnounce } from '../a11y';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

let announce: jest.SpyInstance;

beforeEach(() => {
  announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
});

afterEach(() => {
  announce.mockRestore();
});

function Speaker({ message }: { message: string | null }) {
  useAnnounce(message);
  return <Text>{message ?? 'nothing'}</Text>;
}

describe('useAnnounce', () => {
  it('says a sentence once, however often the component renders', async () => {
    const view = await render(<Speaker message="Done. Task added" />);
    await view.rerender(<Speaker message="Done. Task added" />);

    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('says the same sentence again when it has been cleared in between', async () => {
    const view = await render(<Speaker message="Listening. Tap to send." />);
    await view.rerender(<Speaker message={null} />);
    await view.rerender(<Speaker message="Listening. Tap to send." />);

    expect(announce).toHaveBeenCalledTimes(2);
  });

  it('has nothing to say about an empty one', async () => {
    await render(<Speaker message="   " />);

    expect(announce).not.toHaveBeenCalled();
  });
});

/* A toast is the end of the receipt's own path: "Undone", or the reason an undo
   could not be applied. It appears somewhere nobody is looking and leaves again
   after three seconds, which for a screen reader means it never existed. */
describe('a toast', () => {
  function Raiser() {
    const toast = useToast();
    return (
      <Text
        testID="raise"
        onPress={() => toast.show({ message: 'Undone', detail: 'Task added: milk' })}
      >
        raise
      </Text>
    );
  }

  it('is announced and carries a live region', async () => {
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <ThemeProvider forceScheme="dark">
          <ToastProvider>
            <Raiser />
          </ToastProvider>
        </ThemeProvider>
      </SafeAreaProvider>,
    );

    await act(async () => {
      screen.getByTestId('raise').props.onPress();
    });

    expect(announce).toHaveBeenCalledWith('Undone. Task added: milk');
    expect(screen.getByTestId('toast').props.accessibilityLiveRegion).toBe('polite');
  });
});
