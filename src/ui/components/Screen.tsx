import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../ThemeProvider';
import { useFontsReady } from '../fonts';
import { AnimatedPressable, usePressScale } from '../motionHooks';
import { Txt } from './Text';
import { MIC_CLEARANCE } from '../layout';

export { MIC_CLEARANCE } from '../layout';

export function Screen({
  children,
  scroll = true,
  title,
  subtitle,
  right,
  padded = true,
  refreshControl,
  contentStyle,
  bottomClearance = MIC_CLEARANCE,
  back = false,
  close = false,
}: {
  children: ReactNode;
  scroll?: boolean;
  title?: string;
  subtitle?: string;
  right?: ReactNode;
  padded?: boolean;
  refreshControl?: React.ComponentProps<typeof ScrollView>['refreshControl'];
  contentStyle?: ViewStyle;
  bottomClearance?: number;
  /**
   * Draw a way out. On for every screen the menu pushes; off for the ones that
   * are their own root — home, and anything that closes rather than goes back.
   */
  back?: boolean;
  /**
   * Draw a Close instead, for a sheet.
   *
   * A sheet is dismissible by dragging it away, and that is not enough on its
   * own: the gesture is invisible, it is the first thing to fail for anyone
   * with a motor impairment, and on Android people reach for the system Back
   * before they think to swipe. The menu shipped for one commit with the
   * gesture as its only exit and there was simply no way off it.
   */
  close?: boolean;
}) {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const fontsReady = useFontsReady();
  // Both are called every render whether or not the button is drawn — a hook
  // behind a `back ?` would change the hook order the moment a screen sets it.
  // A bare glyph takes more travel than the 0.96 default: there is no fill to
  // watch, so the whole cue is how far the icon itself moves.
  const backPress = usePressScale({ scale: 0.9 });
  const closePress = usePressScale({ scale: 0.9 });

  const header =
    title || right ? (
      <View style={[styles.header, { paddingHorizontal: padded ? spacing.lg : 0 }]}>
        {back ? (
          <AnimatedPressable
            testID="screen-back"
            accessibilityRole="button"
            accessibilityLabel="Go back"
            hitSlop={10}
            // Asked when pressed, not while rendering. A notification or a deep
            // link can land here with an empty stack, and home is where every
            // route leads anyway.
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
            {...backPress.handlers}
            style={[styles.back, backPress.style]}
          >
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </AnimatedPressable>
        ) : null}
        <View style={styles.headerText}>
          {title ? <Txt variant="display">{title}</Txt> : null}
          {subtitle ? (
            <Txt variant="caption" tone="secondary">
              {subtitle}
            </Txt>
          ) : null}
        </View>
        {right}
        {close ? (
          <AnimatedPressable
            testID="screen-close"
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={10}
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
            {...closePress.handlers}
            style={[styles.close, closePress.style]}
          >
            <Ionicons name="close" size={22} color={colors.text} />
          </AnimatedPressable>
        ) : null}
      </View>
    ) : null;

  const body = (
    <View
      style={[
        { paddingHorizontal: padded ? spacing.lg : 0, gap: spacing.md },
        contentStyle,
      ]}
    >
      {children}
    </View>
  );

  // Nothing is measured until the faces are loadable; see `useFontsReady`.
  // This is invisible — the startup overlay is still covering the screen.
  if (!fontsReady) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + bottomClearance }}
          keyboardShouldPersistTaps="handled"
          // The keyboard used to cover whatever you were typing on every screen
          // in the app. Android's window is `adjustResize`, so it shrinks and
          // this scrolls; iOS does not resize, and needs to be told to inset.
          automaticallyAdjustKeyboardInsets
          // Drag the keyboard away instead of hunting for a Done button.
          keyboardDismissMode="interactive"
          refreshControl={refreshControl}
          showsVerticalScrollIndicator={false}
        >
          {header}
          {body}
        </ScrollView>
      ) : (
        <View style={{ flex: 1, paddingBottom: insets.bottom }}>
          {header}
          <View style={{ flex: 1 }}>{body}</View>
        </View>
      )}
    </View>
  );
}

export function Section({
  title,
  right,
  children,
  compact,
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  compact?: boolean;
}) {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: compact ? spacing.xs : spacing.sm }}>
      {title || right ? (
        <View style={styles.sectionHead}>
          {title ? (
            <Txt variant="eyebrow" tone="tertiary" style={styles.sectionTitle}>
              {title.toUpperCase()}
            </Txt>
          ) : (
            <View />
          )}
          {right}
        </View>
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingTop: 8,
    paddingBottom: 16,
    gap: 12,
  },
  headerText: { flex: 1, gap: 2 },
  // Takes the row rather than sizing to its own text. Android measures a Text
  // in a flex row short — with tracking on it, short by a whole character — and
  // then clips it: "YOUR DATA" rendered as "YOUR DAT".
  sectionTitle: { flex: 1 },
  // Nudged left so the chevron's own bearing lines the title up with the body
  // text below it, rather than indenting the whole header by an icon's width.
  back: { marginLeft: -8, marginBottom: 4 },
  close: { padding: 6, marginBottom: 2 },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 20,
  },
});
