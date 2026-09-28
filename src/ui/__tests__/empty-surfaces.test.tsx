/**
 * A painted surface with nothing in it must not draw itself.
 *
 * The defect this holds the line on was photographed on the Habits screen: a
 * rounded, bordered, surface-coloured rectangle 24pt tall sitting between two
 * real cards, with nothing inside it. `Card` paints its own ground, its own
 * border, its own radius and `spacing.md` of padding on all four sides, so a
 * card whose children all resolved to nothing is not a shorter card — it is a
 * bordered void in a list where the reader is looking for a row.
 *
 * It is unfindable by reading. About thirty-five `<Card>`s in this app hold a
 * single `{rows.map(…)}` or `{cond ? … : null}` and rely on the *caller* having
 * guarded the empty case; it typechecks either way, it renders either way, and
 * a test with fixture data never reaches the state where every branch is false.
 * So the rule lives on the surface rather than in thirty-five call sites, and
 * these are the shapes it has to cover.
 */
import { render } from '@testing-library/react-native';
import { View } from 'react-native';

import { ThemeProvider } from '../ThemeProvider';
import { Card } from '../components/Card';
import { Section } from '../components/Screen';
import { Txt } from '../components/Text';

function wrap(ui: React.ReactElement) {
  return render(<ThemeProvider forceScheme="dark">{ui}</ThemeProvider>);
}

const EMPTY: readonly string[] = [];

describe('a surface with no content does not paint itself', () => {
  it('drops a card whose only child is a map over an empty list', async () => {
    const { toJSON } = await wrap(
      <Card testID="card">{EMPTY.map((row) => <Txt key={row}>{row}</Txt>)}</Card>,
    );
    expect(toJSON()).toBeNull();
  });

  it('drops a card whose every conditional child fell through', async () => {
    const { toJSON } = await wrap(
      <Card testID="card">
        {false ? <Txt>a</Txt> : null}
        {null}
        {undefined}
      </Card>,
    );
    expect(toJSON()).toBeNull();
  });

  it('drops a card whose map produced only nulls', async () => {
    // `AllDayBand` in the agenda has exactly this shape: it maps the items it
    // was handed and returns null for the kinds it does not draw.
    const items = [{ type: 'class' }, { type: 'class' }] as const;
    const { toJSON } = await wrap(
      <Card testID="card">
        {items.map((item, i) => (item.type !== 'class' ? <Txt key={i}>{item.type}</Txt> : null))}
      </Card>,
    );
    expect(toJSON()).toBeNull();
  });

  it('still paints a card with one real child', async () => {
    const { getByTestId } = await wrap(
      <Card testID="card">
        {null}
        <Txt>Real</Txt>
      </Card>,
    );
    expect(getByTestId('card')).toBeTruthy();
  });

  it('paints a card holding an empty View, which is a layout the caller meant', async () => {
    // The rule is "no children", not "no ink": a spacer or a measured box is a
    // child, and second-guessing that would be a different bug.
    const { getByTestId } = await wrap(
      <Card testID="card">
        <View style={{ height: 8 }} />
      </Card>,
    );
    expect(getByTestId('card')).toBeTruthy();
  });

  it('drops a section rather than heading a void', async () => {
    const { toJSON } = await wrap(
      <Section title="Transactions" right={<Txt>latest 0 of 0</Txt>}>
        {EMPTY.map((row) => (
          <Txt key={row}>{row}</Txt>
        ))}
      </Section>,
    );
    expect(toJSON()).toBeNull();
  });

  it('still draws a section with content', async () => {
    const { getByText } = await wrap(
      <Section title="Transactions">
        <Txt>One row</Txt>
      </Section>,
    );
    expect(getByText('TRANSACTIONS')).toBeTruthy();
    expect(getByText('One row')).toBeTruthy();
  });
});
