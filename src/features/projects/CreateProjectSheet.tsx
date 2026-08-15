/**
 * The typed path to a new container.
 *
 * Voice is the fast path ("start a project for the Japan trip"), so this stays
 * deliberately small: a name, a kind, an optional emoji and a coarse target
 * date. Anything finer than "in a month" is a sentence, not a form.
 */
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { now } from '@/core/clock';
import { epochToLocal, localToEpoch } from '@/core/time';
import type { CreateProjectInput, ProjectKind } from '@/repositories/projects';
import { Button, Chip, Input, Section, Txt } from '@/ui/components';
import { colorForTag } from '@/ui/theme';
import { useTheme } from '@/ui/ThemeProvider';

import { EMOJI_CHOICES, PROJECT_KINDS, PROJECT_KIND_LABEL } from './constants';

type TargetChoice = { key: string; label: string; days: number | null };

const TARGETS: readonly TargetChoice[] = [
  { key: 'none', label: 'No date', days: null },
  { key: 'today', label: 'Today', days: 0 },
  { key: 'tomorrow', label: 'Tomorrow', days: 1 },
  { key: 'week', label: 'In a week', days: 7 },
  { key: 'month', label: 'In a month', days: 30 },
];

/** Noon, because some zones skip midnight itself on a switchover day. */
function targetEpoch(days: number | null): number | null {
  if (days === null) return null;
  const date = epochToLocal(now()).plus({ days }).toISODate();
  return date === null ? null : localToEpoch(`${date}T12:00`);
}

export function CreateProjectSheet({
  visible,
  busy,
  onClose,
  onCreate,
}: {
  visible: boolean;
  busy?: boolean;
  onClose: () => void;
  onCreate: (input: CreateProjectInput) => void;
}) {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();

  const [name, setName] = useState('');
  const [kind, setKind] = useState<ProjectKind>('project');
  const [emoji, setEmoji] = useState<string | null>(null);
  const [target, setTarget] = useState<string>('none');

  // A sheet that reopens holding the last attempt's text reads as a bug.
  useEffect(() => {
    if (!visible) return;
    setName('');
    setKind('project');
    setEmoji(null);
    setTarget('none');
  }, [visible]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const choice = TARGETS.find((option) => option.key === target);
    onCreate({
      name: trimmed,
      kind,
      emoji,
      targetDate: targetEpoch(choice?.days ?? null),
    });
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        style={[styles.backdrop, { backgroundColor: colors.overlay }]}
        onPress={onClose}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.wrap}
      >
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
              borderTopLeftRadius: radius.xl,
              borderTopRightRadius: radius.xl,
              paddingBottom: insets.bottom + spacing.lg,
            },
          ]}
        >
          <View style={[styles.grabber, { backgroundColor: colors.borderStrong }]} />
          <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 460 }}>
            <View style={{ gap: spacing.lg, paddingBottom: spacing.sm }}>
              <Txt variant="heading">New project</Txt>

              <Input
                label="Name"
                value={name}
                onChangeText={setName}
                placeholder="Japan trip"
                autoFocus
                returnKeyType="done"
                onSubmitEditing={submit}
                testID="project-name"
              />

              <Section title="Kind" compact>
                <View style={styles.chips}>
                  {PROJECT_KINDS.map((option) => (
                    <Chip
                      key={option}
                      label={PROJECT_KIND_LABEL[option]}
                      color={colorForTag(option)}
                      selected={option === kind}
                      onPress={() => setKind(option)}
                    />
                  ))}
                </View>
              </Section>

              <Section title="Emoji" compact>
                <View style={styles.chips}>
                  {EMOJI_CHOICES.map((choice) => {
                    const selected = choice === emoji;
                    return (
                      <Pressable
                        key={choice}
                        accessibilityRole="button"
                        accessibilityLabel={`Emoji ${choice}`}
                        accessibilityState={{ selected }}
                        onPress={() => setEmoji(selected ? null : choice)}
                        style={{
                          width: 44,
                          height: 44,
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderRadius: radius.sm,
                          borderWidth: StyleSheet.hairlineWidth,
                          borderColor: selected ? colors.accent : colors.border,
                          backgroundColor: selected ? colors.accentMuted : 'transparent',
                        }}
                      >
                        <Txt style={{ fontSize: 19 }}>{choice}</Txt>
                      </Pressable>
                    );
                  })}
                </View>
              </Section>

              <Section title="Target date" compact>
                <View style={styles.chips}>
                  {TARGETS.map((option) => (
                    <Chip
                      key={option.key}
                      label={option.label}
                      selected={option.key === target}
                      onPress={() => setTarget(option.key)}
                    />
                  ))}
                </View>
              </Section>
            </View>
          </ScrollView>

          <View style={{ flexDirection: 'row', gap: spacing.sm, paddingTop: spacing.sm }}>
            <Button
              label="Create"
              variant="primary"
              icon="add"
              onPress={submit}
              disabled={!name.trim()}
              loading={busy}
              testID="project-create"
            />
            <Button label="Cancel" variant="ghost" onPress={onClose} />
          </View>
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
    marginBottom: 12,
    opacity: 0.7,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
