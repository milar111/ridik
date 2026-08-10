import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
}) {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();

  const header =
    title || right ? (
      <View style={[styles.header, { paddingHorizontal: padded ? spacing.lg : 0 }]}>
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
            <Txt variant="micro" tone="tertiary" style={{ letterSpacing: 0.8 }}>
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
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 20,
  },
});
