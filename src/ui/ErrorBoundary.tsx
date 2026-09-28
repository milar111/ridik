import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { createLogger } from '@/core/logger';
import { useTheme } from './ThemeProvider';
import { Txt } from './components/Text';
import { Button } from './components/Button';

const log = createLogger('error-boundary');

type Props = {
  children: ReactNode;
  /** Shown instead of the default screen; receives a reset callback. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Names the region so a crash in one tab does not read as a whole-app crash. */
  label?: string;
};

type State = { error: Error | null };

/**
 * Renders a recoverable screen instead of a white void.
 *
 * Wrapped around each tab as well as the root: a bad row in one list must not
 * take down the voice button, which is the app's only universal escape hatch.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error(`${this.props.label ?? 'app'} crashed`, {
      message: error.message,
      stack: info.componentStack,
    });
  }

  private reset = () => this.setState({ error: null });

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return <CrashPanel error={error} label={this.props.label} onReset={this.reset} />;
  }
}

/**
 * The crash screen, as a function component so it can read the *real* theme.
 *
 * This used to be drawn inline by `render()` above, which cannot call a hook —
 * so it reached for `makeTheme('dark')` and painted its background from that.
 * The text did not follow: `Txt` reads `useTheme()`, which is the provider's
 * scheme, and `ThemeProvider` sits above every `ErrorBoundary` in the tree. On
 * a light-theme phone that produced dark ink on a near-black panel — an error
 * screen nobody can read, which is the one screen that has to be readable,
 * across all 41 places this boundary is mounted.
 *
 * A fixed scheme was never needed anyway: the provider is an ancestor, so a
 * child of the fallback has the same access any other component does.
 */
function CrashPanel({
  error,
  label,
  onReset,
}: {
  error: Error;
  label?: string;
  onReset: () => void;
}) {
  const { colors, radius } = useTheme();
  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <Txt variant="title">Something broke</Txt>
      <Txt variant="caption" tone="secondary">
        {label ? `In: ${label}` : 'Your data is safe on this device.'}
      </Txt>
      <ScrollView
        // Was a hard-coded 4% white wash, which is invisible on linen and was
        // the same mistake one layer down.
        style={[styles.trace, { backgroundColor: colors.surfaceSunken, borderRadius: radius.md }]}
        contentContainerStyle={{ padding: 12 }}
      >
        <Txt variant="mono" tone="tertiary">
          {error.message}
        </Txt>
      </ScrollView>
      <Button label="Try again" variant="primary" onPress={onReset} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center', gap: 12, padding: 24 },
  trace: { maxHeight: 220 },
});
