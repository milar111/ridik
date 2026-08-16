/**
 * The action sheet the long-press menus use.
 *
 * `ActionSheetIOS` is iOS-only and `Alert` cannot carry icons or a selected
 * state, so the one menu shape this feature needs is drawn here — themed, and
 * identical on both platforms.
 */
import { Fragment } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Divider, SheetCard, Txt } from '@/ui/components';
import { useTheme } from '@/ui/ThemeProvider';

import type { IconName } from './constants';

export type MenuOption = {
  label: string;
  icon?: IconName;
  tone?: 'default' | 'danger' | 'accent';
  selected?: boolean;
  /** Draws a rule above the row, so a destructive option is not one more choice. */
  separated?: boolean;
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
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close menu"
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
                <Fragment key={`${option.label}-${index}`}>
                  {option.separated ? (
                    // Named after what it sets apart: the rule carries no text,
                    // so a test has no other way to say which option is below it.
                    <View style={{ marginVertical: spacing.xs }} testID={`rule-above-${option.label}`}>
                      <Divider />
                    </View>
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={option.label}
                    accessibilityState={{ selected: !!option.selected }}
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
                        opacity: pressed ? 0.6 : 1,
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
                </Fragment>
              );
            })}
          </ScrollView>
        </SheetCard>
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
