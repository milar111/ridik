import { StyleSheet, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { formatDayHeading } from '@/core/time';
import type { CommitmentWithEntity } from '@/repositories/crm';
import { useTheme } from '@/ui/ThemeProvider';
import { AnimatedPressable, usePressScale } from '@/ui/motionHooks';
import { Badge, Divider, Txt } from '@/ui/components';
import { REFLOW_MS } from '@/ui/motion';
import { useStaggeredEntry } from '@/ui/motionHooks';

/**
 * What you promised someone, and what someone promised you — the subset that
 * has run out of time. The row goes to the person rather than to the promise:
 * "did I get back to Ivo?" is answered by their page, and the two directions
 * are told apart by the arrow rather than by a word, because the row is one
 * line either way.
 */
export function Commitments({
  rows,
  now,
  zone,
}: {
  rows: readonly CommitmentWithEntity[];
  now: number;
  /** The snapshot's zone, so every row on the screen dates from the same one. */
  zone: string;
}) {
  const arrive = useStaggeredEntry({ from: 'below' });

  return (
    <View>
      {rows.map((row, index) => (
        <Animated.View
          key={row.commitment.id}
          entering={arrive(index)}
          // Settling a promise takes its row out of the middle of the list.
          layout={LinearTransition.duration(REFLOW_MS)}
        >
          {index > 0 ? <Divider inset={28} /> : null}
          <Row row={row} now={now} zone={zone} />
        </Animated.View>
      ))}
    </View>
  );
}

function Row({ row, now, zone }: { row: CommitmentWithEntity; now: number; zone: string }) {
  const router = useRouter();
  const { colors } = useTheme();
  const { commitment, entity } = row;

  const iOwe = commitment.direction === 'i_owe';
  const overdue = commitment.dueDate != null && commitment.dueDate < now;
  const tint = overdue ? colors.danger : iOwe ? colors.warning : colors.textTertiary;
  // Full-width row: shallow travel. `minHeight: 44` is on the layout box, which
  // a transform does not move, so the target stays the size it was.
  const press = usePressScale({ scale: 0.98 });

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={
        iOwe
          ? `You owe ${entity.name}: ${commitment.commitmentText}`
          : `${entity.name} owes you: ${commitment.commitmentText}`
      }
      accessibilityHint={`Opens ${entity.name}`}
      onPress={() => router.push(`/person/${entity.id}`)}
      {...press.handlers}
      style={[styles.row, press.style]}
    >
      <Ionicons
        name={iOwe ? 'arrow-up-circle-outline' : 'arrow-down-circle-outline'}
        size={18}
        color={tint}
      />
      <View style={styles.body}>
        <Txt variant="body" numberOfLines={1}>
          {commitment.commitmentText}
        </Txt>
        <Txt variant="micro" tone="tertiary" numberOfLines={1}>
          {iOwe ? `You owe ${entity.name}` : `${entity.name} owes you`}
          {commitment.dueDate != null ? ` · ${formatDayHeading(commitment.dueDate, zone, now)}` : ''}
        </Txt>
      </View>
      {overdue ? <Badge label="Overdue" tone="danger" /> : null}
      <Ionicons name="chevron-forward" size={14} color={colors.textTertiary} />
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingVertical: 5 },
  body: { flex: 1, gap: 1 },
});
