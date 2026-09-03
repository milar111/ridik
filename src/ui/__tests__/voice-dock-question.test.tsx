/**
 * Answering a question without a keyboard.
 *
 * Every confirmation this app raises is a yes/no — the actions are parked and
 * `classifyConfirmation` replays or drops them without calling the model, so
 * the whole exchange is free. It was nonetheless answered by typing the word
 * "yes" into a text box, on the screen of an app whose premise is not having
 * to type. These tests hold the buttons, and hold the one case that genuinely
 * still needs words.
 */
import { fireEvent, render, screen } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { registerVoicePipeline, useVoiceStore, type VoicePipeline } from '@/features/voice/store';

import { ThemeProvider } from '../ThemeProvider';

jest.mock('expo-router', () => ({
  usePathname: () => '/notes',
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

jest.mock('@/features/voice/useQuickActions', () => ({ useQuickActionRouting: () => {} }));

import { VoiceDock } from '@/features/voice/VoiceDock';

const QUESTION = 'Book it Thursday at 14:00?';

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

function pipeline() {
  const process = jest.fn(async (transcript: string) => ({ transcript, items: [] }));
  const impl: VoicePipeline = {
    listen: async () => {},
    stopListening: async () => {},
    process,
    speak: async () => {},
    stopSpeaking: async () => {},
  };
  registerVoicePipeline(impl);
  return process;
}

beforeEach(() => {
  useVoiceStore.getState().reset();
  useVoiceStore.getState().discardRecovered();
});

describe('a yes/no question', () => {
  it('is answered by tapping, not by typing the word', async () => {
    const process = pipeline();
    useVoiceStore.setState({
      expanded: true,
      pendingClarification: { question: QUESTION, pending: 'P1', answers: 'yesno' },
    });
    await wrap();

    await fireEvent.press(screen.getByLabelText(`Yes — ${QUESTION}`));

    expect(process).toHaveBeenCalledWith('yes', { pending: 'P1' });
  });

  /*
    The keyboard must not come up on its own here. It used to — a pending
    question forced `typing` true unconditionally — so a question with two
    buttons under it also had a focused text field and a keyboard covering
    half the sheet.
  */
  it('does not open the keyboard to ask it', async () => {
    pipeline();
    useVoiceStore.setState({
      expanded: true,
      pendingClarification: { question: QUESTION, pending: 'P1', answers: 'yesno' },
    });
    await wrap();

    expect(screen.queryByTestId('voice-text-input')).toBeNull();
  });

  /*
    No is not the end of the turn. The useful answer to "Book it Thursday at
    14:00?" is almost never "no" — it is "no, Friday" — so the box opens with
    the question still on screen, and its placeholder is what teaches how short
    the answer should be.
  */
  it('opens a short answer box on No, keeping the question visible', async () => {
    pipeline();
    useVoiceStore.setState({
      expanded: true,
      pendingClarification: { question: QUESTION, pending: 'P1', answers: 'yesno' },
    });
    await wrap();

    await fireEvent.press(screen.getByLabelText(`No — ${QUESTION}`));

    expect(screen.getByTestId('voice-text-input')).toBeTruthy();
    expect(screen.getByPlaceholderText(/e\.g\. Friday at 3/)).toBeTruthy();
    expect(screen.getByText(QUESTION)).toBeTruthy();
    // The buttons go: a question already answered must not still offer Yes.
    expect(screen.queryByLabelText(`Yes — ${QUESTION}`)).toBeNull();
  });

  /*
    The one question that cannot be a yes/no — the model needing a value it
    could not default. Buttons there would offer an answer that means nothing.
  */
  it('falls back to the box for an open question', async () => {
    pipeline();
    useVoiceStore.setState({
      expanded: true,
      pendingClarification: { question: 'Which Ivo?', pending: 'P2', answers: 'open' },
    });
    await wrap();

    expect(screen.queryByLabelText('Yes — Which Ivo?')).toBeNull();
    expect(screen.getByTestId('voice-text-input')).toBeTruthy();
  });
});
