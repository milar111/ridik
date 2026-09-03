/**
 * The dock's half of checking before sending.
 *
 * The store decides *whether* to stop; this is what the person actually sees
 * when it does. The whole surface is one the app already had — the text box
 * that comes up when dictation failed — and the risk this file exists for is
 * that a sentence which was heard perfectly arrives wearing the copy written
 * for one that was not.
 */
import { fireEvent, render, screen } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useVoiceStore } from '@/features/voice/store';

import { ThemeProvider } from '../ThemeProvider';

jest.mock('expo-router', () => ({
  usePathname: () => '/notes',
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

jest.mock('@/features/voice/useQuickActions', () => ({ useQuickActionRouting: () => {} }));

import { VoiceDock } from '@/features/voice/VoiceDock';

const HEARD = 'remind me to email the doctor the day before';

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
          <VoiceDock />
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  useVoiceStore.getState().reset();
  useVoiceStore.getState().discardRecovered();
});

describe('the dock, holding a sentence for review', () => {
  it('shows what was heard, in the box, ready to edit', async () => {
    useVoiceStore.setState({
      expanded: true,
      draftSeed: { text: HEARD, reason: 'review' },
    });
    await wrap();

    expect(screen.getByTestId('voice-text-input').props.value).toBe(HEARD);
    expect(screen.getByText(/nothing sent yet/i)).toBeTruthy();
  });

  /*
    The defect this is really guarding. Every label on this surface was written
    for somebody typing *because talking did not work*, and showing them over a
    sentence the app heard correctly reports a success as a failure. "Speak
    instead" is the same: the microphone is what filled this box.
  */
  it('does not use the wording written for a failed dictation', async () => {
    useVoiceStore.setState({
      expanded: true,
      draftSeed: { text: HEARD, reason: 'review' },
    });
    await wrap();

    expect(screen.queryByText('Speak instead')).toBeNull();
    expect(screen.getByText('Say it again')).toBeTruthy();
    expect(screen.getByLabelText(new RegExp(`heard, ready to edit: ${HEARD}`, 'i'))).toBeTruthy();
  });

  /** A recovered transcript is a different event and keeps its own words. */
  it('keeps the failure wording when the text really is a rescue', async () => {
    useVoiceStore.setState({
      expanded: true,
      draftSeed: { text: HEARD, reason: 'recovered' },
    });
    await wrap();

    expect(screen.getByText('Speak instead')).toBeTruthy();
    expect(screen.queryByText(/nothing sent yet/i)).toBeNull();
  });

  /*
    The third answer, and the only one that costs nothing. Without it the way
    out of a wrong transcript is to clear the box by hand or dismiss the sheet
    — and dismissing files the words as unsent, which puts a card on home about
    a sentence the user had already decided against.
  */
  it('offers a way to throw it away that does not file it as lost', async () => {
    useVoiceStore.setState({
      expanded: true,
      draftSeed: { text: HEARD, reason: 'review' },
    });
    await wrap();

    await fireEvent.press(screen.getByText('Discard'));

    expect(useVoiceStore.getState().recovered).toBeNull();
    expect(useVoiceStore.getState().expanded).toBe(false);
  });
});
