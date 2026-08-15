import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import * as SystemUI from 'expo-system-ui';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Platform, useColorScheme } from 'react-native';

import { VoiceDock } from '@/features/voice/VoiceDock';
import { useEmberChoice } from '@/hooks/useEmber';
import { useWidgetPublisher } from '@/hooks/useWidgetPublisher';
import { FontsReadyProvider, useAppFonts } from '@/ui/fonts';
import { ThemeProvider } from '@/ui/ThemeProvider';
import { Spinner, ToastProvider } from '@/ui/components';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { Txt } from '@/ui/components/Text';
import { makeTheme, radius } from '@/ui/theme';
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

/**
 * How a sheet is presented. The same result on both, by two different routes.
 *
 * iOS gets `modal`, which is UIKit's own sheet: it sits over the page, the page
 * stays visible and scaled behind it, and it can be pulled down. That is the
 * behaviour to match, not to replace — an earlier attempt flattened iOS to a
 * plain card to look like Android and made it strictly worse.
 *
 * Android gets `formSheet`, which react-native-screens implements natively and
 * which is the only presentation that gives Android the same thing: a rounded
 * card over a dimmed page, draggable away. Plain `modal` there is a full-screen
 * push with no gesture and no sense of a layer.
 *
 * They are not interchangeable. `formSheet` on iOS renders the screen with no
 * height at all — the sheet appears, correctly shaped, and completely empty.
 */
const SHEET: React.ComponentProps<typeof Stack.Screen>['options'] = Platform.select({
  ios: { presentation: 'modal', gestureEnabled: true },
  default: {
    presentation: 'formSheet',
    // One detent: enough of home shows through to read as a layer, and there is
    // no half-open state to get stuck in.
    sheetAllowedDetents: [0.92],
    sheetCornerRadius: radius.xl,
    sheetGrabberVisible: true,
    sheetElevation: 24,
    gestureEnabled: true,
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

  // The chosen ember, not the default. This overlay is drawn *above*
  // `ThemeProvider`, so it does not inherit — and it is the first thing anyone
  // sees on a cold start, which made it the one surface that ignored the
  // setting while every other one honoured it.
  const ember = useEmberChoice();

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(makeTheme(scheme, ember).colors.bg).catch(() => {});
  }, [scheme, ember]);

  const theme = makeTheme(scheme, ember);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <FontsReadyProvider ready={fontsReady}>
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
                  {/* A sheet on both, which is the iOS behaviour: it slides up,
                      the screen behind stays visible, and you can drag it away.
                      Android's default for a modal was a plain full-screen push
                      with no gesture, so it is told explicitly to slide from the
                      bottom and to accept a vertical dismiss.
                      The gesture is never the only way out — both these screens
                      draw their own Close, because a sheet whose only exit is a
                      swipe is a sheet some people cannot leave. */}
                  <Stack.Screen name="menu" options={SHEET} />
                  <Stack.Screen name="briefing" options={SHEET} />
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
          </FontsReadyProvider>
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
