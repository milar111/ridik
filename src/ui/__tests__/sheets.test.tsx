/**
 * The two moving surfaces a `Modal` can hold, and the one rule that is easy to
 * break between them.
 *
 * A sheet has an edge to come from, so it rises; a dialog does not, so it
 * grows. Both are shared values driven from an effect rather than
 * `entering`/`exiting`, because a `Modal` is a separate native window — that
 * reasoning lives in `SheetCard`, and this file only asserts the result.
 *
 * The rule worth a test is `offset`. The voice sheet can be dragged away by its
 * handle, and the drag has to be *added* to the entrance: a second transform
 * would mean the pull and the rise each animate a translateY and the last one
 * written wins, which reads as the sheet snapping back under the finger.
 *
 * Runs under the `ui` project, so Reanimated is the shared mock: animations
 * resolve to their end value, which is why every assertion reads a re-rendered
 * tree — the effect lands the value after the render that scheduled it.
 */
import { StyleSheet, Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { useSharedValue } from 'react-native-reanimated';

import { DialogCard } from '../components/DialogCard';
import { SheetCard } from '../components/SheetCard';

const motionOf = (label: string) => {
  const view = screen.getByText(label).parent!;
  return StyleSheet.flatten(view.props.style) as {
    opacity?: number;
    transform?: { scale?: number; translateY?: number }[];
  };
};

function Sheet({ dragged = 0 }: { dragged?: number }) {
  const offset = useSharedValue(dragged);
  return (
    <SheetCard offset={offset}>
      <Text>sheet</Text>
    </SheetCard>
  );
}

describe('sheet and dialog entrances', () => {
  it('rises to its resting place and stops there', async () => {
    const { rerender } = await render(
      <SheetCard>
        <Text>sheet</Text>
      </SheetCard>,
    );

    // The frame the sheet is mounted in: below its place and invisible, so the
    // first thing seen is the arrival rather than a jump.
    expect(motionOf('sheet').opacity).toBe(0);
    expect(motionOf('sheet').transform?.[0]?.translateY).toBeGreaterThan(0);

    await rerender(
      <SheetCard>
        <Text>sheet</Text>
      </SheetCard>,
    );
    expect(motionOf('sheet').opacity).toBe(1);
    expect(motionOf('sheet').transform?.[0]?.translateY).toBe(0);
  });

  it('adds a drag to the entrance rather than replacing it', async () => {
    const { rerender } = await render(<Sheet dragged={40} />);
    await rerender(<Sheet dragged={40} />);

    // Settled, and still 40pt down: the pull the user is holding survives the
    // rise finishing under it.
    expect(motionOf('sheet').transform?.[0]?.translateY).toBe(40);
  });

  it('grows a centred dialog instead of sliding it', async () => {
    const { rerender } = await render(
      <DialogCard>
        <Text>dialog</Text>
      </DialogCard>,
    );

    // No direction to come from, so nothing translates — at any point.
    expect(motionOf('dialog').transform?.[0]?.scale).toBeLessThan(1);
    expect(motionOf('dialog').transform?.[0]?.translateY).toBeUndefined();

    await rerender(
      <DialogCard>
        <Text>dialog</Text>
      </DialogCard>,
    );
    expect(motionOf('dialog').opacity).toBe(1);
    expect(motionOf('dialog').transform?.[0]?.scale).toBe(1);
  });

  it('puts a caller prop on the card that draws the dialog', async () => {
    await render(
      <DialogCard testID="card" accessibilityViewIsModal accessibilityLiveRegion="assertive">
        <Text>dialog</Text>
      </DialogCard>,
    );

    // The screen-reader trap has to land on the element with the card's own
    // styles, which is why `DialogCard` spreads rather than wraps.
    const card = screen.getByTestId('card');
    expect(card.props.accessibilityViewIsModal).toBe(true);
    expect(card.props.accessibilityLiveRegion).toBe('assertive');
  });
});
