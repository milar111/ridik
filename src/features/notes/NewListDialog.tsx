import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAddChecklistItems } from '@/hooks';
import { Button, Input, Txt, useToast } from '@/ui/components';
import { useTheme } from '@/ui/ThemeProvider';

import { errorMessage } from './errors';

/**
 * Starting a list.
 *
 * A name alone cannot create one: checklists exist only as rows, so the
 * repository has nothing to write until there is a first item. Asking for both
 * up front is honest about that, and it is also how the user thinks — you start
 * a packing list *because* you just remembered the charger.
 */
export function NewListDialog({
  visible,
  onClose,
  onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated?: (listName: string) => void;
}) {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const addItems = useAddChecklistItems();

  const [name, setName] = useState('');
  const [first, setFirst] = useState('');

  const reset = () => {
    setName('');
    setFirst('');
  };

  const create = () => {
    const listName = name.trim();
    const item = first.trim();
    if (!listName || !item) return;
    addItems.mutate(
      { listName, items: [item] },
      {
        onSuccess: () => {
          reset();
          onClose();
          onCreated?.(listName);
          toast.show({ message: `Started ${listName}`, tone: 'success' });
        },
        onError: (error) =>
          toast.show({
            message: errorMessage(error, 'I could not start that list.'),
            tone: 'danger',
          }),
      },
    );
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
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
              padding: spacing.lg,
              paddingBottom: insets.bottom + spacing.lg,
              gap: spacing.md,
            },
          ]}
        >
          <View style={{ gap: 2 }}>
            <Txt variant="heading">New list</Txt>
            <Txt variant="caption" tone="tertiary">
              Or just say “add milk to my shopping list”.
            </Txt>
          </View>

          <Input
            label="List"
            autoFocus
            value={name}
            onChangeText={setName}
            placeholder="Packing for Vienna"
            returnKeyType="next"
            accessibilityLabel="List name"
          />
          <Input
            label="First item"
            value={first}
            onChangeText={setFirst}
            placeholder="Charger"
            returnKeyType="done"
            onSubmitEditing={create}
            accessibilityLabel="First item"
          />

          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <Button
              label="Create"
              variant="primary"
              loading={addItems.isPending}
              disabled={!name.trim() || !first.trim()}
              onPress={create}
            />
            <Button
              label="Cancel"
              variant="ghost"
              onPress={() => {
                reset();
                onClose();
              }}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  wrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderWidth: StyleSheet.hairlineWidth },
});
