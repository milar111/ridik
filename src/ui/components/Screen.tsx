import { Children, type ReactNode } from 'react';
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

/**
 * The way back, on its own.
 *
 * `Screen` draws one in its header; a screen that builds its own header row
 * instead — `app/calendar.tsx` puts the month picker where the title would be —
 * puts this in it rather than growing a second chevron of its own. One press
 * scale, one hit slop, one label, one answer to an empty stack.
 */
export function BackControl({
  label = 'Go back',
  /**
   * Where a press lands when there is nothing to pop. Home for almost
   * everything — the menu is a junction you pass through, so sending someone
   * back to it leaves them one tap from where every route leads anyway — but a
   * detail screen names its own list instead.
   */
  fallback = '/',
}: {
  label?: string;
  fallback?: Parameters<ReturnType<typeof useRouter>['replace']>[0];
} = {}) {
  const { colors } = useTheme();
  const router = useRouter();
  const press = usePressScale({ scale: 0.9 });
  return (
    <AnimatedPressable
      testID="screen-back"
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={10}
      // Asked when pressed, not while rendering. A notification or a deep link
      // can land here with an empty stack.
      onPress={() => (router.canGoBack() ? router.back() : router.replace(fallback))}
      {...press.handlers}
      style={[styles.control, styles.back, press.style]}
    >
      <Ionicons name="chevron-back" size={26} color={colors.text} />
    </AnimatedPressable>
  );
}

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
   * before they think to swipe. Without a Close, the gesture would be the only
   * exit.
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
  const closePress = usePressScale({ scale: 0.9 });

  // A `back` or a `close` is the only way off a pushed screen that is visible
  // to somebody who does not know the gesture, so the row is drawn whether or
  // not the screen also has a title. It used to hang off `title || right`, and
  // `app/calendar.tsx` — which draws its own month row instead of a title —
  // passed `back` and got nothing at all for it, on both platforms.
  const controls = back || right || close;
  const header =
    title || controls ? (
      <View style={{ paddingHorizontal: padded ? spacing.lg : 0, paddingTop: 8 }}>
        {controls ? (
          <View style={[styles.controls, title || subtitle ? null : styles.controlsOnly]}>
            {back ? <BackControl /> : null}
            <View style={styles.spring} />
            {right ? <View style={styles.control}>{right}</View> : null}
            {close ? (
              <AnimatedPressable
                testID="screen-close"
                accessibilityRole="button"
                accessibilityLabel="Close"
                hitSlop={10}
                onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
                {...closePress.handlers}
                style={[styles.control, styles.close, closePress.style]}
              >
                <Ionicons name="close" size={22} color={colors.text} />
              </AnimatedPressable>
            ) : null}
          </View>
        ) : null}
        {title || subtitle ? (
          <View style={styles.headerText}>
            {title ? <Txt variant="display">{title}</Txt> : null}
            {subtitle ? (
              <Txt variant="caption" tone="secondary">
                {subtitle}
              </Txt>
            ) : null}
          </View>
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

  // The same rule as `Card`, one level out: a heading is a label for what is
  // under it, so a section whose children all fell through draws the word
  // TRANSACTIONS over a gap and nothing else. `right` is always a modifier of
  // the children — a count, a "latest 6 of 40" — so it goes with them.
  if (Children.toArray(children).length === 0) return null;

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
  /**
   * The controls get their own row, above the title, and that is the whole
   * reason this is two Views rather than one.
   *
   * Beside the title they cost the title its left edge. A 26pt chevron plus the
   * row's gap pushed every heading in the app to **47pt** while the body under
   * it — every card, every section label, every list row — sat at the 16pt
   * gutter, so `Notes`, `Tasks` and `Today` were indented past their own
   * content by half an inch and `Menu`, which has no chevron, was not. Two left
   * edges on one screen and a third one between screens. `back: -8` was an
   * attempt at exactly this and could never have reached: the glyph is wider
   * than the gutter it was being pulled into.
   *
   * On its own row the chevron's ink lands *on* the gutter (that is what the
   * -8 is worth), the title starts where the body starts, and `back` and the
   * `right` icons are two 40pt boxes on one centre line rather than two
   * different heights bottom-aligned against a two-line title block.
   */
  controls: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 40 },
  /** Pushes `right` and `close` away from `back`, and holds the row open when
   *  `back` is the only control on it. */
  spring: { flex: 1 },
  headerText: { gap: 2, paddingTop: 2, paddingBottom: 16 },
  /** Controls with no title under them still need air before the body. */
  controlsOnly: { paddingBottom: 12 },
  /**
   * Every control in the header row is this tall, and centres its own content.
   *
   * The row used to be `flex-end`, which bottom-aligns whatever it is given —
   * fine when the things being aligned are the same height, and these never
   * were. A 26pt back chevron beside a `right` slot whose icons carry their own
   * touch padding put the two on different optical centres: measured on Today,
   * the chevron sat **4.4dp below** the sparkle and the overflow next to it, in
   * the same row. That is the sort of thing that reads as "off" long before
   * anyone can say what moved.
   *
   * A fixed box is what makes every control agree, and it is why the row can be
   * centred rather than hand-nudged: it retired a `marginBottom: 4` on the
   * chevron, a correction aimed at one screen's icons that silently became
   * wrong for the next screen's.
   */
  control: { height: 40, justifyContent: 'center' },
  // Takes the row rather than sizing to its own text. Android measures a Text
  // in a flex row short — with tracking on it, short by a whole character — and
  // then clips it: "YOUR DATA" rendered as "YOUR DAT".
  sectionTitle: { flex: 1 },
  // A chevron carries its own left bearing, so its box starts 8pt before its
  // ink. Pulling the box out by that puts the ink on the gutter, level with
  // every left edge on the screen.
  back: { marginLeft: -8 },
  // No horizontal padding: every control in this row measures to the same
  // gutter, and 6pt of it on one of them put the Close a glyph's width inside
  // where the `right` icons on every other screen sit. `hitSlop` is what makes
  // the target big, not padding that moves the ink.
  close: {},
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 20,
  },
});
