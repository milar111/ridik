import { render, screen, fireEvent } from '@testing-library/react-native';
import { ThemeProvider } from '../ThemeProvider';
import { Txt } from '../components/Text';
import { Button } from '../components/Button';
import { Checkbox, EmptyState, Segmented } from '../components/Controls';

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
