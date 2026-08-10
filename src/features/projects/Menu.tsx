/**
 * The action sheet the long-press menus use.
 *
 * `ActionSheetIOS` is iOS-only and `Alert` cannot carry icons or a selected
 * state, so the one menu shape this feature needs is drawn here — themed, and
 * identical on both platforms.
 */
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Txt } from '@/ui/components';
import { useTheme } from '@/ui/ThemeProvider';

import type { IconName } from './constants';

export type MenuOption = {
  label: string;
  icon?: IconName;
  tone?: 'default' | 'danger' | 'accent';
  disabled?: boolean;
  selected?: boolean;
  onPress: () => void;
};

export function MenuSheet({
  visible,
  title,
  subtitle,
  options,
  onClose,
}: {
  visible: boolean;
  title?: string;
  subtitle?: string;
  options: MenuOption[];
  onClose: () => void;
}) {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close menu"
        style={[styles.backdrop, { backgroundColor: colors.overlay }]}
        onPress={onClose}
      />
      <View style={styles.wrap} pointerEvents="box-none">
        <View
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
                <Txt variant="caption" tone="tertiary" numberOfLines={1}>
                  {subtitle}
                </Txt>
              ) : null}
            </View>
          ) : null}

          <ScrollView style={{ maxHeight: 380 }} keyboardShouldPersistTaps="handled">
            {options.map((option, index) => {
              const tint =
                option.tone === 'danger'
                  ? colors.danger
                  : option.tone === 'accent'
                    ? colors.accent
                    : colors.text;
              return (
                <Pressable
                  key={`${option.label}-${index}`}
                  accessibilityRole="button"
                  accessibilityLabel={option.label}
                  accessibilityState={{ disabled: !!option.disabled, selected: !!option.selected }}
                  disabled={option.disabled}
                  onPress={() => {
                    // Closing first lets an option open the next menu: both
                    // updates land in one batch and the option's wins.
                    onClose();
                    option.onPress();
                  }}
                  style={({ pressed }) => [
                    styles.option,
                    {
                      paddingHorizontal: spacing.lg,
                      opacity: option.disabled ? 0.35 : pressed ? 0.6 : 1,
                      backgroundColor: pressed ? colors.surfaceRaised : 'transparent',
                    },
                  ]}
                >
                  {option.icon ? <Ionicons name={option.icon} size={19} color={tint} /> : null}
                  <Txt variant="body" style={{ color: tint, flex: 1 }} numberOfLines={1}>
                    {option.label}
                  </Txt>
                  {option.selected ? (
                    <Ionicons name="checkmark" size={17} color={colors.accent} />
                  ) : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  wrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: { paddingTop: 10, borderWidth: StyleSheet.hairlineWidth },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: 10,
    opacity: 0.7,
  },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
});
