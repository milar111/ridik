/**
 * The busiest moment in the app, drawn as something that moves.
 *
 * `ellipsis-horizontal` is three dots that never move, and it was what both
 * mics showed while a turn was in flight — a still indicator at the only
 * moment the user has nothing to do but decide whether the app has stopped.
 * Reanimated's values cannot be sampled from a test, so what is held here is
 * the wiring: three dots exist, they are one object to a screen reader, and a
 * glyph is not what gets drawn.
 */
import { render, screen } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useVoiceStore } from '@/features/voice/store';

import { ThemeProvider } from '../ThemeProvider';
import { ThinkingDots } from '../components/ThinkingDots';

jest.mock('expo-router', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

import { HomeMic } from '@/features/home/HomeMic';

function wrap(ui: React.ReactElement) {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <QueryClientProvider client={new QueryClient()}>
        <ThemeProvider>{ui}</ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  useVoiceStore.getState().reset();
  useVoiceStore.getState().discardRecovered();
});

describe('the working indicator', () => {
  it('is three dots', async () => {
    const tree = await wrap(<ThinkingDots color="#fff" />);
    // The row plus one view per dot.
    expect(tree.toJSON()).toBeTruthy();
    expect(JSON.stringify(tree.toJSON()).match(/borderRadius/g)?.length).toBe(3);
  });

  /*
    One object, not three. A screen reader walking three unlabelled dots says
    nothing three times; the caption beside them is what carries the state, and
    `accessibilityState.busy` on the mic is what carries it in a vocabulary
    both platforms already speak.
  */
  it('says nothing to a screen reader', async () => {
    const tree = await wrap(<ThinkingDots color="#fff" />);
    expect(JSON.stringify(tree.toJSON())).toContain('"accessibilityElementsHidden":true');
  });

  it('replaces the mic glyph while a turn is in flight', async () => {
    useVoiceStore.setState({ status: 'thinking' });
    await wrap(<HomeMic />);

    expect(screen.getByTestId('home-mic-caption').props.children).toBe('WORKING ON IT');
    // The still ellipsis is gone. It is the thing this replaced — and the mic
    // still says `busy`, which is the half a screen reader can use.
    expect(screen.queryByText('ellipsis-horizontal')).toBeNull();
    expect(screen.getByTestId('home-mic').props.accessibilityState).toEqual({ busy: true });
  });
});
