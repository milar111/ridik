import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SheetCard, Txt } from '@/ui/components';
import { useTheme } from '@/ui/ThemeProvider';
import { AnimatedPressable, usePressScale } from '@/ui/motionHooks';

export type SheetAction = {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  tone?: 'default' | 'accent' | 'danger';
  /** Second line, used to spell out what a destructive action will do. */
  detail?: string;
};

/**
 * The long-press menu for a row, and the overflow menu for a screen.
 *
 * A bottom sheet rather than the platform action sheet: this app is used
 * one-handed while walking, so every option has to sit inside thumb reach and
 * be at least 44pt tall, which `ActionSheetIOS` does not guarantee on a tablet.
 */
export function ActionSheet({
  visible,
  title,
  subtitle,
  actions,
  onClose,
}: {
  visible: boolean;
  title?: string;
  subtitle?: string;
  actions: SheetAction[];
  onClose: () => void;
}) {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();

  const toneColor = {
    default: colors.text,
    accent: colors.accent,
    danger: colors.danger,
  } as const;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss menu"
        style={[styles.backdrop, { backgroundColor: colors.overlay }]}
        onPress={onClose}
      />
      <View style={styles.wrap} pointerEvents="box-none">
        <SheetCard
          style={[
            styles.sheet,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
              borderTopLeftRadius: radius.xl,
              borderTopRightRadius: radius.xl,
              paddingBottom: insets.bottom + spacing.sm,
            },
          ]}
        >
          <View style={[styles.grabber, { backgroundColor: colors.borderStrong }]} />

          {title ? (
            <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: 1 }}>
              <Txt variant="bodyStrong" numberOfLines={1}>
                {title}
              </Txt>
              {subtitle ? (
                <Txt variant="micro" tone="tertiary" numberOfLines={1}>
                  {subtitle}
                </Txt>
              ) : null}
            </View>
          ) : null}

          {actions.map((action) => (
            <Row
              key={action.label}
              action={action}
              color={toneColor[action.tone ?? 'default']}
              onPress={() => {
                onClose();
                action.onPress();
              }}
            />
          ))}
        </SheetCard>
      </View>
    </Modal>
  );
}

/**
 * One action, extracted because each needs its own animation state and a hook
 * cannot be called from inside a `map`.
 *
 * Inside a `Modal`, which is why the press is a shared value driven from an
 * effect (what `usePressScale` is) rather than anything layout-animated.
 */
function Row({
  action,
  color,
  onPress,
}: {
  action: SheetAction;
  color: string;
  onPress: () => void;
}) {
  const { spacing } = useTheme();
  const press = usePressScale({ scale: 0.98 });
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={action.label}
      onPress={onPress}
      {...press.handlers}
      style={[styles.row, { paddingHorizontal: spacing.lg }, press.style]}
    >
      <Ionicons name={action.icon} size={19} color={color} />
      <View style={{ flex: 1, gap: 1 }}>
        <Txt variant="body" style={{ color }}>
          {action.label}
        </Txt>
        {action.detail ? (
          <Txt variant="micro" tone="tertiary">
            {action.detail}
          </Txt>
        ) : null}
      </View>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  wrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: { paddingTop: 8, borderWidth: StyleSheet.hairlineWidth },
  grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
});
