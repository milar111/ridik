/**
 * The dock's half of not losing what was said.
 *
 * Two wirings, both invisible from the store's own tests: the sentence a
 * recogniser that recorded *nothing* produces, and a recovered transcript
 * arriving in the text box the user can edit and send. The offer to restore is
 * drawn on home by a different component entirely, so the text travels through
 * the store — and a dock that never picked it up would leave a "Put it back"
 * button that appeared to do nothing at all.
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
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

describe('the dock, after a turn that lost something', () => {
  /* Not "I didn't quite catch that". The user has just spoken a paragraph into
     a microphone that recorded none of it, and softening that is how they find
     out days later by re-reading a note that was never written. */
  it('says plainly when the recogniser recorded nothing at all', async () => {
    useVoiceStore.setState({
      expanded: true,
      status: 'error',
      error: 'I did not catch that.',
      needsRetry: true,
      heardNothing: true,
    });
    await wrap();

    expect(screen.getByText(/Nothing was recorded/)).toBeTruthy();
    expect(screen.queryByText(/didn't catch that clearly/)).toBeNull();
  });

  it('keeps the softer wording for a turn that merely came out muddy', async () => {
    useVoiceStore.setState({
      expanded: true,
      status: 'error',
      error: 'I did not catch that.',
      needsRetry: true,
      heardNothing: false,
    });
    await wrap();

    expect(screen.getByText(/didn't catch that clearly/)).toBeTruthy();
  });

  it('offers the kept transcript back', async () => {
    useVoiceStore.setState({ expanded: true, status: 'error', error: 'offline' });
    useVoiceStore.getState().keepDraft('remind me to renew the parking permit');
    await wrap();

    expect(screen.getByTestId('unsent-transcript')).toBeTruthy();
  });

  /* The hand-off itself: `recoverTranscript()` can be called from home, where
     this text box does not exist. */
  it('picks a recovered transcript up into the text box, once', async () => {
    useVoiceStore.getState().keepDraft('log forty on groceries');
    await wrap();

    await act(async () => {
      useVoiceStore.getState().recoverTranscript();
    });

    expect(screen.getByTestId('voice-text-input').props.value).toBe('log forty on groceries');
    // Consumed, so a later re-render cannot re-seed the box over something the
    // user has since typed.
    expect(useVoiceStore.getState().draftSeed).toBeNull();
  });

  /**
   * The edit, through the backdrop — the easiest accidental tap on the screen
   * and the documented safe exit off the sheet.
   *
   * `dismiss()` used to call `keepDraft(draft)` and then `close()`, and
   * `close()` recomputes the slot from the store's own `transcript`, which for
   * a failed turn is still the sentence *before* the edit. So the older words
   * won and the correction was destroyed by the one feature whose entire
   * purpose is not losing typed words. Exercised through the dock rather than
   * the store, because the bug lived entirely in the two-call wiring.
   */
  it('keeps the edit, not the sentence it was edited from', async () => {
    useVoiceStore.setState({
      expanded: true,
      status: 'error',
      error: 'offline',
      transcript: 'add milk to the shopping list',
    });
    useVoiceStore.getState().keepDraft('add milk to the shopping list');
    await wrap();

    await act(async () => {
      useVoiceStore.getState().recoverTranscript();
    });
    await fireEvent.changeText(
      screen.getByTestId('voice-text-input'),
      'add milk and eggs to the shopping list on Friday',
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Dismiss' }));

    expect(useVoiceStore.getState().recovered?.text).toBe(
      'add milk and eggs to the shopping list on Friday',
    );
  });

  /**
   * Send, while the last turn is still in flight.
   *
   * `submitText` refuses a second turn, and the box stays mounted through one
   * whenever a clarification is pending — so "answer, model is slow, retype,
   * press Send" cleared the field and dropped the sentence with no error and
   * nothing kept. The button says so now instead of looking live.
   */
  it('will not swallow a sentence into a turn that is already running', async () => {
    useVoiceStore.setState({
      expanded: true,
      status: 'thinking',
      typing: true,
    });
    await wrap();

    await fireEvent.changeText(
      screen.getByTestId('voice-text-input'),
      'ring the landlord about the boiler',
    );
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send.props.accessibilityState?.disabled).toBe(true);

    await fireEvent.press(send);

    expect(screen.getByTestId('voice-text-input').props.value).toBe(
      'ring the landlord about the boiler',
    );
  });
});
