import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Txt } from '@/ui/components/Text';
import { useTheme } from '@/ui/ThemeProvider';

/**
 * The bottom-sheet shell both task sheets sit in.
 *
 * Chrome only: same grabber, backdrop and keyboard behaviour as the voice dock,
 * so a sheet raised from a task row feels like the same surface the mic raises.
 */
export function Sheet({
  visible,
  onClose,
  title,
  subtitle,
  children,
  scroll = true,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  scroll?: boolean;
}) {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();

  const body = (
    <View style={{ gap: spacing.lg, paddingBottom: spacing.md }}>{children}</View>
  );

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={[styles.backdrop, { backgroundColor: colors.overlay }]}
        onPress={onClose}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.wrap}
        pointerEvents="box-none"
      >
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
              borderTopLeftRadius: radius.xl,
              borderTopRightRadius: radius.xl,
              paddingBottom: insets.bottom + spacing.md,
            },
          ]}
        >
          <View style={styles.grabber} />
          <View style={[styles.head, { paddingBottom: spacing.md }]}>
            <View style={{ flex: 1, gap: 1 }}>
              <Txt variant="heading" numberOfLines={2}>
                {title}
              </Txt>
              {subtitle ? (
                <Txt variant="micro" tone="tertiary">
                  {subtitle}
                </Txt>
              ) : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
              // An 11pt label is a 14pt target; the slop is what makes it 44.
              hitSlop={{ top: 15, bottom: 15, left: 16, right: 16 }}
              style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
            >
              <Txt variant="micro" tone="accent">
                DONE
              </Txt>
            </Pressable>
          </View>

          {scroll ? (
            <ScrollView
              style={{ maxHeight: 520 }}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {body}
            </ScrollView>
          ) : (
            body
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  wrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: { paddingHorizontal: 18, paddingTop: 10, borderWidth: StyleSheet.hairlineWidth },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(128,128,140,0.5)',
    marginBottom: 8,
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
});
