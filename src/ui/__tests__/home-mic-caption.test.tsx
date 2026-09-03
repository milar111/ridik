/**
 * The line under the microphone, once it stopped being a line.
 *
 * It was one elided row, on the reasoning that a caption which grew would push
 * the button out from under your thumb. The reasoning was right and the
 * conclusion was wrong: a dictated sentence became "BOOK TWO HOURS FOR THE
 * ROBOT…", so the one moment you most want to see what was heard was the one
 * moment it was hidden. The space is reserved instead.
 */
import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useVoiceStore } from '@/features/voice/store';

import { ThemeProvider } from '../ThemeProvider';

jest.mock('expo-router', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

import { HomeMic } from '@/features/home/HomeMic';

const LONG =
  'Book two hours for the robotics report on Thursday afternoon and remind me to email ' +
  'the tutor the day before';

function wrap() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <QueryClientProvider client={new QueryClient()}>
        <ThemeProvider>
          <HomeMic />
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  useVoiceStore.getState().reset();
  useVoiceStore.getState().discardRecovered();
});

describe('the caption under the mic', () => {
  it('shows a long transcript whole rather than cutting it off', async () => {
    useVoiceStore.setState({ status: 'listening', partial: LONG });
    await wrap();

    const caption = screen.getByTestId('home-mic-caption');
    expect(caption.props.children).toBe(LONG);
    // One line was the defect. Nothing may pin it back to one.
    expect(caption.props.numberOfLines).toBeUndefined();
  });

  /*
    Your own words come back in the voice they were said in. `eyebrow` is a
    tracked, upper-cased *label* — right for "TAP TO SPEAK", and actively
    hostile to a paragraph: shouting is slower to read, and Android does not
    count `letterSpacing` when it measures a line.
  */
  it('stops shouting once it is carrying a sentence', async () => {
    useVoiceStore.setState({ status: 'listening', partial: LONG });
    await wrap();

    expect(screen.getByTestId('home-mic-caption').props.children).not.toMatch(/^BOOK TWO/);
  });

  it('keeps the resting hint as a label', async () => {
    await wrap();

    expect(screen.getByTestId('home-mic-caption').props.children).toBe(
      'TAP TO SPEAK · HOLD TO TYPE',
    );
  });

  /*
    The reason the original was one line, preserved. The box is a fixed height
    whatever is in it, so the disc above it cannot move while somebody is
    speaking — which is what the growing version would have done.
  */
  /*
    The reason the original was one line, preserved. The box is a fixed height
    whatever is in it, so the disc above it cannot move while somebody is
    speaking — which is what a growing caption would have done, and which was
    the correct half of the original decision.
  */
  it('reserves the same height empty as full', async () => {
    await wrap();
    const resting = StyleSheet.flatten(screen.getByTestId('home-mic-caption-box').props.style);

    useVoiceStore.setState({ status: 'listening', partial: LONG });
    await wrap();
    const full = StyleSheet.flatten(screen.getByTestId('home-mic-caption-box').props.style);

    expect(typeof resting.height).toBe('number');
    expect(full.height).toBe(resting.height);
    // And it clips rather than spilling over the receipt below it.
    expect(full.overflow).toBe('hidden');
  });
});
