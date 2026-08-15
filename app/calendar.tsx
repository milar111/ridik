import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { now } from '@/core/clock';
import { currentZone, localDateOf, type LocalDate } from '@/core/time';
import {
  AgendaList,
  EventSheet,
  MonthJumpSheet,
  SyncBanner,
  WeekStrip,
  epochOfDate,
  formatMonthLabel,
  monthOfWeek,
  startOfWeek,
  type EventSheetTarget,
  type WeekStart,
} from '@/features/calendar';
import { useCurriculumEntries, useSettings } from '@/hooks';
import { Button, Divider, Screen, Txt } from '@/ui/components';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { useTheme } from '@/ui/ThemeProvider';

/**
 * One schedule: a week strip that pages by week, and the selected day beneath
 * it. The strip and the agenda hold separate state on purpose — swiping is a
 * look-ahead, and it must not silently move the day you are working on.
 */
export default function CalendarScreen() {
  const { colors, spacing } = useTheme();
  const router = useRouter();

  const zone = useMemo(() => currentZone(), []);
  const settings = useSettings();
  const weekStartsOn: WeekStart = settings.data?.weekStartsOn ?? 1;
  const googleConnected = Boolean(settings.data?.googleAccountEmail);

  const [selected, setSelected] = useState<LocalDate>(() => localDateOf(now(), zone));
  const [visibleWeek, setVisibleWeek] = useState(() => startOfWeek(now(), zone, weekStartsOn));
  const [monthOpen, setMonthOpen] = useState(false);
  const [target, setTarget] = useState<EventSheetTarget | null>(null);
  // Bumped to re-aim the strip even when the selected day itself has not moved.
  const [revealNonce, setRevealNonce] = useState(0);

  const curriculum = useCurriculumEntries(true);

  // The stored week start arrives after the first paint; re-align the strip to
  // it rather than leaving the header a day out until the next swipe.
  useEffect(() => {
    setVisibleWeek((current) => startOfWeek(current, zone, weekStartsOn));
  }, [weekStartsOn, zone]);

  const reveal = useCallback(
    (date: LocalDate) => {
      setSelected(date);
      setVisibleWeek(startOfWeek(epochOfDate(date, zone), zone, weekStartsOn));
      setRevealNonce((n) => n + 1);
    },
    [weekStartsOn, zone],
  );

  const goToday = useCallback(() => reveal(localDateOf(now(), zone)), [reveal, zone]);

  return (
    <Screen back scroll={false} padded={false} contentStyle={{ flex: 1, gap: 0 }}>
      <View style={[styles.header, { paddingHorizontal: spacing.lg }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${formatMonthLabel(monthOfWeek(visibleWeek, zone), zone)}. Jump to another month`}
          onPress={() => setMonthOpen(true)}
          hitSlop={8}
          style={({ pressed }) => [styles.monthButton, { opacity: pressed ? 0.6 : 1 }]}
        >
          <Txt variant="title">{formatMonthLabel(monthOfWeek(visibleWeek, zone), zone)}</Txt>
          <Ionicons name="chevron-down" size={16} color={colors.textSecondary} />
        </Pressable>
        <Button label="Today" icon="today-outline" size="sm" onPress={goToday} testID="today-button" />
      </View>

      {settings.isSuccess && !googleConnected ? (
        <View style={{ paddingBottom: spacing.sm }}>
          <SyncBanner onPress={() => router.push('/settings')} />
        </View>
      ) : null}

      <WeekStrip
        selected={selected}
        onSelect={setSelected}
        onWeekChange={setVisibleWeek}
        zone={zone}
        weekStartsOn={weekStartsOn}
        classes={curriculum.data ?? []}
        revealNonce={revealNonce}
      />
      <Divider />

      <ErrorBoundary label="calendar agenda">
        <AgendaList date={selected} zone={zone} onOpen={setTarget} />
      </ErrorBoundary>

      <MonthJumpSheet
        visible={monthOpen}
        anchor={visibleWeek}
        selected={selected}
        zone={zone}
        weekStartsOn={weekStartsOn}
        onPick={(date) => {
          setMonthOpen(false);
          reveal(date);
        }}
        onClose={() => setMonthOpen(false)}
      />

      <EventSheet
        target={target}
        zone={zone}
        googleConnected={googleConnected}
        onClose={() => setTarget(null)}
        onMoved={reveal}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 6,
    paddingBottom: 10,
    gap: 12,
  },
  monthButton: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 },
});
