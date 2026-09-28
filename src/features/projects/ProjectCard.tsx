/**
 * One row of the projects list: what it is, how far along it is, when it is due.
 *
 * Three lines and no more — the list is meant to be scanned, and the detail
 * screen is one tap away.
 */
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { ProjectSummary } from '@/hooks';
import { Card, Chip, Txt } from '@/ui/components';
import { useTheme } from '@/ui/ThemeProvider';
import { AnimatedPressable, usePressScale } from '@/ui/motionHooks';

import { ProgressBar } from './Bits';
import { PROJECT_KIND_ICON, PROJECT_KIND_LABEL } from './constants';
import { deadlineOf } from './format';

export function ProjectCard({
  summary,
  onPress,
  onLongPress,
}: {
  summary: ProjectSummary;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const { colors, spacing } = useTheme();
  const { project, counts } = summary;
  // Matches `Card`'s own press: this row *is* a card, it just wraps one rather
  // than passing `onPress` in, because the long-press has to reach both.
  const press = usePressScale({ scale: 0.98 });

  const statusTint =
    project.status === 'active'
      ? colors.accent
      : project.status === 'done'
        ? colors.success
        : project.status === 'paused'
          ? colors.warning
          : colors.border;

  // The kind already arrives as its own glyph, so a hue on top of it was a
  // second answer to a question the icon had finished answering.
  const kindTint = colors.textSecondary;
  const deadline = project.targetDate == null ? null : deadlineOf(project.targetDate);
  // A finished project's overdue date is history, not a warning.
  const deadlineTone = project.status === 'done' ? 'tertiary' : (deadline?.tone ?? 'tertiary');

  const meta = [
    counts.total === 0 ? 'Empty' : `${counts.done}/${counts.total} done`,
    counts.openTodos > 0 ? `${counts.openTodos} open` : null,
  ].filter((part): part is string => part !== null);

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={`${project.name}, ${PROJECT_KIND_LABEL[project.kind]}, ${meta.join(', ')}`}
      accessibilityHint="Opens the project"
      onPress={onPress}
      onLongPress={onLongPress}
      {...press.handlers}
      style={press.style}
    >
      <Card padded={false} accent={statusTint}>
        <View style={{ padding: spacing.md, gap: 7 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            {project.emoji ? (
              <Txt variant="heading" style={{ fontSize: 18 }}>
                {project.emoji}
              </Txt>
            ) : (
              <Ionicons name={PROJECT_KIND_ICON[project.kind]} size={17} color={kindTint} />
            )}
            <Txt variant="bodyStrong" numberOfLines={1} style={{ flex: 1 }}>
              {project.name}
            </Txt>
            <Chip label={PROJECT_KIND_LABEL[project.kind]} color={kindTint} size="sm" />
            <Ionicons name="chevron-forward" size={15} color={colors.textTertiary} />
          </View>

          {counts.total > 0 ? <ProgressBar done={counts.done} total={counts.total} /> : null}

          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: spacing.sm,
            }}
          >
            <Txt variant="micro" tone="tertiary" numberOfLines={1}>
              {meta.join(' · ')}
            </Txt>
            {deadline ? (
              <Txt variant="micro" tone={deadlineTone} numberOfLines={1} style={{ flexShrink: 1 }}>
                {deadline.label}
              </Txt>
            ) : null}
          </View>
        </View>
      </Card>
    </AnimatedPressable>
  );
}
