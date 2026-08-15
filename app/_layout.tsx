import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import * as SystemUI from 'expo-system-ui';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useColorScheme } from 'react-native';

import { VoiceDock } from '@/features/voice/VoiceDock';
import { useWidgetPublisher } from '@/hooks/useWidgetPublisher';
import { useAppFonts } from '@/ui/fonts';
import { ThemeProvider } from '@/ui/ThemeProvider';
import { Spinner, ToastProvider } from '@/ui/components';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { Txt } from '@/ui/components/Text';
import { makeTheme } from '@/ui/theme';
import { bootstrap, type BootstrapResult } from '@/startup/bootstrap';
// Must be imported for its side effects, before bootstrap() runs.
import '@/startup/register';

void SplashScreen.preventAutoHideAsync().catch(() => {});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Everything is local SQLite: refetching is cheap, staleness is the enemy.
      staleTime: 0,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
    mutations: { retry: 0 },
  },
});

export default function RootLayout() {
  const scheme = useColorScheme() === 'light' ? 'light' : 'dark';
  const [boot, setBoot] = useState<BootstrapResult | null>(null);
  const fontsReady = useAppFonts();

  useEffect(() => {
    let cancelled = false;
    void bootstrap().then((result) => {
      if (cancelled) return;
      setBoot(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Held until the faces are usable as well as the database. The type scale
  // sets tracking and line height for these specific faces, so painting in the
  // system font first would reflow every label the moment the real one lands.
  useEffect(() => {
    if (boot && fontsReady) void SplashScreen.hideAsync().catch(() => {});
  }, [boot, fontsReady]);

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(makeTheme(scheme).colors.bg).catch(() => {});
  }, [scheme]);

  const theme = makeTheme(scheme);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            <ToastProvider>
              <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
              <ErrorBoundary label="app">
                {/* The navigator must mount on the very first render: expo-router
                    resolves the initial URL against whatever tree exists then, and
                    gating it behind an async boot leaves the app on "Unmatched Route".
                    Startup state is an overlay instead. */}
                <Stack
                  screenOptions={{
                    headerShown: false,
                    contentStyle: { backgroundColor: theme.colors.bg },
                    animation: 'slide_from_right',
                  }}
                >
                  <Stack.Screen name="index" />
                  <Stack.Screen name="menu" options={{ presentation: 'modal' }} />
                  <Stack.Screen name="briefing" options={{ presentation: 'modal' }} />
                </Stack>
                {/* Mounted above every route so a thought can be captured from
                    wherever you are. It draws its own floating mic everywhere
                    except home, where the screen already is one. */}
                <VoiceDock />
                {/* Only once the database is open: the widget feed reads the
                    same aggregate query as Today, and running it against a
                    half-migrated database would publish a face built from
                    nothing. */}
                {boot?.ok ? <WidgetPublisher /> : null}
                {!boot || !fontsReady ? (
                  <View
                    style={[styles.overlay, styles.centred, { backgroundColor: theme.colors.bg }]}
                  >
                    <Spinner size="large" color={theme.colors.accent} accessibilityLabel="Starting Ridik" />
                  </View>
                ) : !boot.ok ? (
                  <View style={[styles.overlay, { backgroundColor: theme.colors.bg }]}>
                    <StartupFailure result={boot} />
                  </View>
                ) : null}
              </ErrorBoundary>
            </ToastProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center' },
  // The spinner is a fixed square, where `ActivityIndicator` stretched and
  // centred itself. Only the boot overlay wants this; the failure screen's
  // paragraphs still fill the width.
  centred: { alignItems: 'center' },
});

/**
 * Renders nothing; exists so the widget feed sits inside the query client.
 * A hook cannot be called from `RootLayout` itself — the provider it needs is
 * in that component's own tree.
 */
function WidgetPublisher() {
  useWidgetPublisher();
  return null;
}

function StartupFailure({ result }: { result: BootstrapResult }) {
  const theme = makeTheme('dark');
  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 10, backgroundColor: theme.colors.bg }}>
      <Txt variant="title">Ridik could not start</Txt>
      {result.failures.map((f) => (
        <Txt key={f.name} variant="mono" tone="danger">
          {f.name}: {f.error}
        </Txt>
      ))}
      <Txt variant="caption" tone="secondary">
        Your data is still on this device. Reinstalling will clear it — report this first.
      </Txt>
    </View>
  );
}
