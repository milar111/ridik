/**
 * The way back to a lost sentence, drawn.
 *
 * The store keeps the transcript; this is the only thing that offers it back,
 * and it is drawn on home as well as in the sheet — so a card that renders
 * nothing, or a button that clears the slot without handing the text anywhere,
 * would lose the words just as thoroughly as the bug it was written for.
 */
import { render, screen, fireEvent } from '@testing-library/react-native';

import { ThemeProvider } from '@/ui/ThemeProvider';

import { useVoiceStore } from '../store';
import { UnsentTranscript } from '../Unsent';

function wrap() {
  return render(
    <ThemeProvider forceScheme="dark">
      <UnsentTranscript />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  useVoiceStore.getState().reset();
  useVoiceStore.getState().discardRecovered();
});

describe('the unsent card', () => {
  it('draws nothing at all when nothing has been lost', async () => {
    await wrap();
    expect(screen.queryByTestId('unsent-transcript')).toBeNull();
  });

  it('shows the words that did not go through', async () => {
    useVoiceStore.getState().keepDraft('ring the landlord about the boiler');
    await wrap();

    expect(screen.getByTestId('unsent-transcript')).toBeTruthy();
    expect(screen.getByText('ring the landlord about the boiler')).toBeTruthy();
  });

  /* "Put it back" has to *hand the text over*, not merely stop showing it.
     `draftSeed` is what the dock picks up into its text box. */
  it('puts the text in the composer and opens the sheet', async () => {
    useVoiceStore.getState().keepDraft('add oat milk to the shopping list');
    await wrap();

    await fireEvent.press(screen.getByRole('button', { name: 'Put it back' }));

    expect(useVoiceStore.getState().draftSeed).toBe('add oat milk to the shopping list');
    expect(useVoiceStore.getState().expanded).toBe(true);
  });

  it('throws it away only when asked to', async () => {
    useVoiceStore.getState().keepDraft('something not worth keeping');
    await wrap();

    await fireEvent.press(screen.getByRole('button', { name: 'Discard' }));

    expect(useVoiceStore.getState().recovered).toBeNull();
    expect(useVoiceStore.getState().draftSeed).toBeNull();
  });
});
