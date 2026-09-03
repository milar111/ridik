/**
 * The detail screen's masthead: identity, state and progress in four lines.
 *
 * The stack renders these routes without a native header, so the back
 * affordance is ours to provide.
 */
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { Project } from '@/db/schema';
import type { ProjectCounts } from '@/repositories/projects';
import { BackControl, Badge, Button, Chip, Txt } from '@/ui/components';
import { colorForTag } from '@/ui/theme';
import { useTheme } from '@/ui/ThemeProvider';

import { ProgressBar } from './Bits';
import { PROJECT_KIND_ICON, PROJECT_KIND_LABEL, STATUS_LABEL } from './constants';
import { deadlineOf } from './format';

const STATUS_TONE = {
  active: 'accent',
  paused: 'warning',
  done: 'success',
  archived: 'neutral',
} as const;

export function ProjectHeader({
  project,
  counts,
  onShare,
  onMenu,
  sharing,
}: {
  project: Project;
  counts: ProjectCounts;
  onShare: () => void;
  onMenu: () => void;
  sharing?: boolean;
}) {
  const { spacing } = useTheme();
  const kindTint = colorForTag(project.kind);
  // `Button` sizes itself from its padding, which leaves an icon-only ghost at
  // ~37pt. These three are the screen's navigation, so they get the full 44.
  const tapTarget = { minWidth: 44, minHeight: 44 } as const;
  const deadline = project.targetDate == null ? null : deadlineOf(project.targetDate);
  const deadlineTone = project.status === 'done' ? 'tertiary' : (deadline?.tone ?? 'tertiary');

  return (
    <View style={{ gap: spacing.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        {/* The app's back control, not a ghost `Button` wearing a chevron: that
            one's own padding put its ink 18pt inside the gutter every other
            screen's chevron sits on. */}
        <BackControl fallback="/projects" />
        <View style={{ flexDirection: 'row', gap: spacing.xs }}>
          <Button
            icon="share-outline"
            variant="ghost"
            onPress={onShare}
            loading={sharing}
            accessibilityLabel="Share as markdown"
            testID="project-share"
            style={tapTarget}
          />
          <Button
            icon="ellipsis-horizontal"
            variant="ghost"
            onPress={onMenu}
            accessibilityLabel="Project menu"
            testID="project-menu"
            style={tapTarget}
          />
        </View>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        {project.emoji ? (
          <Txt style={{ fontSize: 26 }}>{project.emoji}</Txt>
        ) : (
          <Ionicons name={PROJECT_KIND_ICON[project.kind]} size={22} color={kindTint} />
        )}
        <Txt variant="title" style={{ flex: 1 }} numberOfLines={2}>
          {project.name}
        </Txt>
      </View>

      {project.description ? (
        <Txt variant="caption" tone="secondary">
          {project.description}
        </Txt>
      ) : null}

      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.xs }}>
        <Chip label={PROJECT_KIND_LABEL[project.kind]} color={kindTint} size="sm" />
        <Badge label={STATUS_LABEL[project.status]} tone={STATUS_TONE[project.status]} />
        {deadline ? (
          <Txt variant="micro" tone={deadlineTone} style={{ marginLeft: 2 }}>
            {deadline.label}
          </Txt>
        ) : null}
      </View>

      {counts.total > 0 ? (
        <View style={{ gap: 5 }}>
          <ProgressBar done={counts.done} total={counts.total} height={5} />
          <Txt variant="micro" tone="tertiary">
            {counts.done} of {counts.total} done
            {counts.openTodos > 0 ? ` · ${counts.openTodos} still open` : ''}
          </Txt>
        </View>
      ) : null}
    </View>
  );
}
