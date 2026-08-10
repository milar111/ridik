/**
 * The typed twin of "for my Japan trip, remind me to pack slippers".
 *
 * Always visible and never modal: the keyboard stays up between items
 * (`submitBehavior="submit"`) and the kind and section stick, because people
 * add five packing items in a row, not one.
 */
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import type { ProjectItemKind } from '@/repositories/projects';
import { Button, Card, Chip, Input } from '@/ui/components';
import { useTheme } from '@/ui/ThemeProvider';

import { ITEM_KINDS, ITEM_KIND_ICON, ITEM_KIND_LABEL } from './constants';

export type AddItemDraft = {
  content: string;
  kind: ProjectItemKind;
  isCheckbox: boolean;
  sectionTitle: string | null;
};

export function AddItemBar({
  sections,
  busy,
  onAdd,
}: {
  /** Existing section titles; `addItems` resolves them by name. */
  sections: string[];
  busy?: boolean;
  onAdd: (draft: AddItemDraft) => void;
}) {
  const { spacing } = useTheme();
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<ProjectItemKind>('todo');
  const [sectionTitle, setSectionTitle] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [newSection, setNewSection] = useState('');
  const [focused, setFocused] = useState(false);

  const submit = () => {
    const trimmed = content.trim();
    if (!trimmed) return;
    setContent('');
    onAdd({ content: trimmed, kind, isCheckbox: kind === 'todo', sectionTitle });
  };

  // A new section needs no mutation of its own: `addItems` creates any section
  // title it does not recognise, so an empty section can never be left behind.
  const nameSection = () => {
    const trimmed = newSection.trim();
    setNaming(false);
    setNewSection('');
    if (trimmed) setSectionTitle(trimmed);
  };

  // A chosen section silently changes where the next item lands, so the row
  // stays on screen for as long as one is selected.
  const composing = focused || content.trim().length > 0 || naming || sectionTitle !== null;
  const options = sectionTitle && !sections.includes(sectionTitle)
    ? [...sections, sectionTitle]
    : sections;

  return (
    <Card>
      <View style={{ gap: spacing.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm }}>
          <Input
            containerStyle={{ flex: 1 }}
            value={content}
            onChangeText={setContent}
            placeholder="Add to this project…"
            returnKeyType="done"
            submitBehavior="submit"
            onSubmitEditing={submit}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            testID="project-add-input"
          />
          <Button
            icon="arrow-up"
            variant="primary"
            onPress={submit}
            disabled={!content.trim()}
            loading={busy}
            accessibilityLabel="Add to this project"
            testID="project-add-submit"
          />
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ gap: 6, paddingRight: spacing.md }}
        >
          {ITEM_KINDS.map((option) => (
            <Chip
              key={option}
              label={ITEM_KIND_LABEL[option]}
              icon={ITEM_KIND_ICON[option]}
              size="sm"
              selected={option === kind}
              onPress={() => setKind(option)}
            />
          ))}
        </ScrollView>

        {composing && naming ? (
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm }}>
            <Input
              containerStyle={{ flex: 1 }}
              value={newSection}
              onChangeText={setNewSection}
              placeholder="New section, e.g. Packing"
              autoFocus
              returnKeyType="done"
              submitBehavior="submit"
              onSubmitEditing={nameSection}
              testID="project-section-input"
            />
            <Button
              icon="checkmark"
              onPress={nameSection}
              disabled={!newSection.trim()}
              accessibilityLabel="Use this section"
            />
            <Button
              icon="close"
              variant="ghost"
              onPress={() => {
                setNaming(false);
                setNewSection('');
              }}
              accessibilityLabel="Cancel the new section"
            />
          </View>
        ) : composing ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ gap: 6, paddingRight: spacing.md }}
          >
            <Chip
              label="No section"
              size="sm"
              selected={sectionTitle === null}
              onPress={() => setSectionTitle(null)}
            />
            {options.map((title) => (
              <Chip
                key={title}
                label={title}
                size="sm"
                selected={sectionTitle === title}
                onPress={() => setSectionTitle(title)}
              />
            ))}
            <Chip label="New section" icon="add" size="sm" onPress={() => setNaming(true)} />
          </ScrollView>
        ) : null}
      </View>
    </Card>
  );
}
