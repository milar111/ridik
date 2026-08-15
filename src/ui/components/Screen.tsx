import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../ThemeProvider';
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
   * are their own root — home, and anything presented as a modal, which is
   * dismissed by dragging or by Back.
   */
  back?: boolean;
}) {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const header =
    title || right ? (
      <View style={[styles.header, { paddingHorizontal: padded ? spacing.lg : 0 }]}>
        {back ? (
          <Pressable
            testID="screen-back"
            accessibilityRole="button"
            accessibilityLabel="Go back"
            hitSlop={10}
            // Asked when pressed, not while rendering. A notification or a deep
            // link can land here with an empty stack, and home is where every
            // route leads anyway.
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
            style={({ pressed }) => [styles.back, { opacity: pressed ? 0.5 : 1 }]}
          >
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </Pressable>
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
            <Txt variant="eyebrow" tone="tertiary">
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
  // Nudged left so the chevron's own bearing lines the title up with the body
  // text below it, rather than indenting the whole header by an icon's width.
  back: { marginLeft: -8, marginBottom: 4 },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 20,
  },
});
