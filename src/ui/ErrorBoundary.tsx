import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { createLogger } from '@/core/logger';
import { makeTheme } from './theme';
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

    const theme = makeTheme('dark');
    return (
      <View style={[styles.root, { backgroundColor: theme.colors.bg }]}>
        <Txt variant="title">Something broke</Txt>
        <Txt variant="caption" tone="secondary">
          {this.props.label ? `In: ${this.props.label}` : 'Your data is safe on this device.'}
        </Txt>
        <ScrollView style={styles.trace} contentContainerStyle={{ padding: 12 }}>
          <Txt variant="mono" tone="tertiary">
            {error.message}
          </Txt>
        </ScrollView>
        <Button label="Try again" variant="primary" onPress={this.reset} />
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center', gap: 12, padding: 24 },
  trace: { maxHeight: 220, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.04)' },
});
