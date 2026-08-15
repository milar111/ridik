import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { ThemeProvider } from '../ThemeProvider';
import { Txt } from '../components/Text';
import { Button } from '../components/Button';
import { Checkbox, EmptyState, Segmented } from '../components/Controls';
import { Toggle } from '../components/Toggle';
import { Spinner } from '../components/Spinner';
import { useConfirm, type ConfirmRequest } from '../components/Confirm';
import { elevate, withAlpha } from '../shadow';
import { makeTheme, typography } from '../theme';

// RNTL 14 renders asynchronously; every render/rerender/unmount must be awaited.
function wrap(ui: React.ReactElement, scheme: 'light' | 'dark' = 'dark') {
  return render(<ThemeProvider forceScheme={scheme}>{ui}</ThemeProvider>);
}

describe('ui primitives', () => {
  it('renders text in both schemes', async () => {
    const dark = await wrap(<Txt>Hello</Txt>, 'dark');
    expect(dark.getByText('Hello')).toBeTruthy();
    await dark.unmount();

    const light = await wrap(<Txt>Hello</Txt>, 'light');
    expect(light.getByText('Hello')).toBeTruthy();
  });

  it('fires a button press and blocks it while disabled', async () => {
    const onPress = jest.fn();
    const { rerender } = await wrap(<Button label="Go" onPress={onPress} testID="go" />);
    await fireEvent.press(screen.getByTestId('go'));
    expect(onPress).toHaveBeenCalledTimes(1);

    await rerender(
      <ThemeProvider forceScheme="dark">
        <Button label="Go" onPress={onPress} disabled testID="go" />
      </ThemeProvider>,
    );
    await fireEvent.press(screen.getByTestId('go'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('exposes checkbox state to accessibility and toggles', async () => {
    const onToggle = jest.fn();
    await wrap(<Checkbox checked={false} onToggle={onToggle} label="Pack slippers" testID="cb" />);
    const box = screen.getByTestId('cb');
    expect(box.props.accessibilityState).toMatchObject({ checked: false });
    await fireEvent.press(box);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('renders a segmented control and reports the chosen value', async () => {
    const onChange = jest.fn();
    await wrap(
      <Segmented
        value="week"
        onChange={onChange}
        options={[
          { value: 'day', label: 'Day' },
          { value: 'week', label: 'Week' },
        ]}
      />,
    );
    await fireEvent.press(screen.getByText('Day'));
    expect(onChange).toHaveBeenCalledWith('day');
  });

  it('shows an empty state with its coaching hint', async () => {
    await wrap(<EmptyState title="No lists yet" hint="Try: add M3 screws to my hardware list" />);
    expect(screen.getByText('No lists yet')).toBeTruthy();
    expect(screen.getByText('Try: add M3 screws to my hardware list')).toBeTruthy();
  });
});

/**
 * The three primitives that exist because React Native's own render as a
 * different control on each platform. What is worth asserting about them is not
 * how they look — a colour token cannot regress into a Material widget — but
 * that they still say the right thing to a screen reader, which is the part a
 * hand-drawn replacement is most likely to drop.
 */
describe('toggle', () => {
  it('announces itself as a switch and reports its state', async () => {
    const onValueChange = jest.fn();
    const { rerender } = await wrap(
      <Toggle value={false} onValueChange={onValueChange} accessibilityLabel="Speak replies" testID="sw" />,
    );

    const control = screen.getByTestId('sw');
    expect(control.props.accessibilityRole).toBe('switch');
    expect(control.props.accessibilityState).toMatchObject({ checked: false, disabled: false });

    await fireEvent.press(control);
    expect(onValueChange).toHaveBeenCalledWith(true);

    await rerender(
      <ThemeProvider forceScheme="dark">
        <Toggle value onValueChange={onValueChange} accessibilityLabel="Speak replies" testID="sw" />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('sw').props.accessibilityState).toMatchObject({ checked: true });
  });

  it('is reachable by its label and inert while disabled', async () => {
    const onValueChange = jest.fn();
    await wrap(
      <Toggle value={false} onValueChange={onValueChange} accessibilityLabel="Speak replies" disabled testID="sw" />,
    );

    expect(screen.getByLabelText('Speak replies')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('sw'));
    expect(onValueChange).not.toHaveBeenCalled();
  });

  /* Every colour comes from the theme, so the same switch is the same switch on
     both platforms — there is no `trackColor`/`thumbColor` pair to get wrong. */
  it('takes its lit colour from the accent of the scheme it is rendered in', async () => {
    const groove = (testID: string) => JSON.stringify(screen.getByTestId(testID).props.style ?? {});

    const light = await wrap(<Toggle value onValueChange={jest.fn()} testID="sw" />, 'light');
    expect(groove('sw')).toContain(makeTheme('light').colors.surfaceSunken);
    await light.unmount();

    await wrap(<Toggle value onValueChange={jest.fn()} testID="sw" />, 'dark');
    expect(groove('sw')).toContain(makeTheme('dark').colors.surfaceSunken);
  });
});

describe('spinner', () => {
  it('reports itself as a busy, indeterminate progress bar', async () => {
    await wrap(<Spinner accessibilityLabel="Saving" testID="spin" />);
    const spinner = screen.getByTestId('spin');
    expect(spinner.props.accessibilityRole).toBe('progressbar');
    expect(spinner.props.accessibilityState).toMatchObject({ busy: true });
    expect(spinner.props.accessibilityLabel).toBe('Saving');
    // Indeterminate: a "now" would be a number the screen reader repeats as a
    // fact, and there is none.
    expect(spinner.props.accessibilityValue).toBeUndefined();
  });

  it('stands in for the label while a button is working', async () => {
    await wrap(<Button label="Save" loading onPress={jest.fn()} testID="save" />);
    expect(screen.getByTestId('save').props.accessibilityState).toMatchObject({ busy: true });
    expect(screen.queryByText('Save')).toBeNull();
  });
});

describe('confirm', () => {
  function Host({ request }: { request: Omit<ConfirmRequest, 'onConfirm'> & { onConfirm: () => void } }) {
    const confirm = useConfirm();
    const [asked, setAsked] = useState(false);
    return (
      <>
        <Button
          label="Ask"
          testID="ask"
          onPress={() => {
            setAsked(true);
            confirm.ask(request);
          }}
        />
        {asked ? null : null}
        {confirm.dialog}
      </>
    );
  }

  it('asks in the app rather than through the OS, and only acts on yes', async () => {
    const onConfirm = jest.fn();
    await wrap(<Host request={{ title: 'Delete this entry?', message: 'Rewrote the firmware', onConfirm }} />);

    expect(screen.queryByText('Delete this entry?')).toBeNull();

    await fireEvent.press(screen.getByTestId('ask'));
    expect(screen.getByText('Delete this entry?')).toBeTruthy();
    expect(screen.getByText('Rewrote the firmware')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('Cancel'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByText('Delete this entry?')).toBeNull();

    await fireEvent.press(screen.getByTestId('ask'));
    await fireEvent.press(screen.getByLabelText('Delete'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Delete this entry?')).toBeNull();
  });

  it('lets the caller name both answers', async () => {
    await wrap(
      <Host
        request={{
          title: 'Stop this session?',
          cancelLabel: 'Keep going',
          confirmLabel: 'Stop',
          onConfirm: jest.fn(),
        }}
      />,
    );
    await fireEvent.press(screen.getByTestId('ask'));

    expect(screen.getByLabelText('Keep going')).toBeTruthy();
    expect(screen.getByLabelText('Stop')).toBeTruthy();
    expect(screen.queryByLabelText('Cancel')).toBeNull();
  });
});

describe('cross-platform drawing rules', () => {
  /* `elevation` is Android's only shadow and it is black, straight down and
     un-blurred to order. One `boxShadow` is read by both renderers. */
  it('casts one shadow both platforms can draw, and no platform-only pair', async () => {
    const style = elevate('card');
    expect(style.boxShadow).toEqual([
      { offsetX: 0, offsetY: 8, blurRadius: 18, spreadDistance: 0, color: 'rgba(90, 31, 0, 0.1)' },
    ]);
    expect(style).not.toHaveProperty('elevation');
    expect(style).not.toHaveProperty('shadowOpacity');
  });

  it('tints a shadow by whatever casts it, multiplying an alpha it already has', () => {
    expect(withAlpha('#FF5A36', 0.4)).toBe('rgba(255, 90, 54, 0.4)');
    expect(withAlpha('#FFF', 1)).toBe('rgba(255, 255, 255, 1)');
    expect(withAlpha('rgba(46, 21, 8, 0.5)', 0.5)).toBe('rgba(46, 21, 8, 0.25)');
  });

  /* iOS ignores `fontWeight` beside a named family and Android fakes it by
     smearing the glyphs, so the scale names a file for every variant and never
     a weight. */
  it('names a bundled face for every type variant and never a fontWeight', () => {
    for (const [name, style] of Object.entries(typography)) {
      expect(`${name}: ${style.fontFamily}`).toMatch(/(Bricolage|Martian)_/);
      expect(style).not.toHaveProperty('fontWeight');
    }
  });
});
