import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { epochToLocal } from '@/core/time';
import {
  AgendaList,
  BriefingCard,
  Commitments,
  DueToday,
  FocusCard,
  HabitStrip,
  LoggedToday,
  InlineError,
  SectionBoundary,
  StaleNotice,
  TodayHeaderActions,
  TodaySkeleton,
  buildAgenda,
  isAgendaEmpty,
  useNow,
} from '@/features/today';
import { invalidateKeys, qk, useToday } from '@/hooks';
import { EmptyState, Refresh, Screen, Section } from '@/ui/components';

/**
 * "What does my day look like?" — answered in one screen and one query.
 *
 * Every section is fed from the same `useToday` snapshot, which is why the
 * whole screen either has data or does not, instead of assembling itself in
 * front of the user out of a dozen independent loading states. Sections with
 * nothing in them are not rendered at all; a day with nothing in *any* of them
 * gets one empty state that teaches the user what to say.
 */
export default function TodayScreen() {
  const client = useQueryClient();
  const today = useToday();
  const at = useNow();
  const [refreshing, setRefreshing] = useState(false);

  const snapshot = today.data;

  const agenda = useMemo(
    () =>
      snapshot
        ? buildAgenda({
            events: snapshot.events,
            classes: snapshot.classes,
            window: { start: snapshot.dayStart, end: snapshot.dayEnd },
            now: at,
          })
        : null,
    [snapshot, at],
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      // The briefing reads the same seven repositories, so a pull that left it
      // alone would refresh the day underneath a stale summary of it.
      await invalidateKeys(client, [qk.today.all, qk.briefing.all, qk.sync.all]);
    } finally {
      setRefreshing(false);
    }
  }, [client]);

  const dayIsEmpty =
    snapshot != null &&
    agenda != null &&
    isAgendaEmpty(agenda) &&
    // A running timer is a day with something on it, whatever the lists say.
    snapshot.focus == null &&
    snapshot.dueTasks.length === 0 &&
    snapshot.overdueTasks.length === 0 &&
    snapshot.commitments.length === 0 &&
    snapshot.habits.length === 0 &&
    // Something logged is something done; "Nothing on today" would be a lie.
    snapshot.activity.length === 0;

  return (
    <Screen
      back
      title="Today"
      subtitle={longDate(snapshot?.at ?? at, snapshot?.zone)}
      right={<TodayHeaderActions sync={snapshot?.sync} />}
      refreshControl={
        <Refresh refreshing={refreshing} onRefresh={() => void onRefresh()} />
      }
    >
      <SectionBoundary label="briefing">
        <BriefingCard />
      </SectionBoundary>

      {/* Cold start only. Every later load renders over the cached snapshot. */}
      {!snapshot && today.isPending ? <TodaySkeleton /> : null}

      {!snapshot && today.isError ? (
        <InlineError
          message="Your day could not be loaded."
          onRetry={() => void today.refetch()}
          testID="today-error"
        />
      ) : null}

      {/*
        A failed refetch over a cached snapshot used to be completely invisible:
        the screen kept drawing the last good day, with no way to tell that it
        had stopped updating. That is the one failure a screen like this must
        not have — a stale day is indistinguishable from a current one, so the
        user goes on trusting it. Said above the sections it describes, and
        quietly: the day is still probably right, it is just not fresh.
      */}
      {snapshot && today.isError ? (
        <StaleNotice
          at={snapshot.at}
          zone={snapshot.zone}
          onRetry={() => void today.refetch()}
          testID="today-stale"
        />
      ) : null}

      {snapshot && agenda ? (
        <>
          {/*
            No `snapshot.focus` gate: the card reads the runtime directly, and
            gating it on this query would hide a session started somewhere else
            until Today happened to refetch — while the card is what keeps that
            query honest in the first place.
          */}
          <SectionBoundary label="focus">
            <FocusCard />
          </SectionBoundary>

          {!isAgendaEmpty(agenda) ? (
            <Section title="Agenda">
              <SectionBoundary label="agenda">
                <AgendaList agenda={agenda} now={at} zone={snapshot.zone} />
              </SectionBoundary>
            </Section>
          ) : null}

          {snapshot.overdueTasks.length + snapshot.dueTasks.length > 0 ? (
            <Section title="Due today">
              <SectionBoundary label="due today">
                <DueToday
                  overdue={snapshot.overdueTasks}
                  due={snapshot.dueTasks}
                  now={at}
                  zone={snapshot.zone}
                />
              </SectionBoundary>
            </Section>
          ) : null}

          {snapshot.commitments.length > 0 ? (
            <Section title="Commitments">
              <SectionBoundary label="commitments">
                <Commitments rows={snapshot.commitments} now={at} zone={snapshot.zone} />
              </SectionBoundary>
            </Section>
          ) : null}

          {snapshot.habits.length > 0 ? (
            <Section title="Habits" compact>
              <SectionBoundary label="habits">
                <HabitStrip habits={snapshot.habits} at={snapshot.at} zone={snapshot.zone} />
              </SectionBoundary>
            </Section>
          ) : null}

          {snapshot.activity.length > 0 ? (
            <Section title="Logged today">
              <SectionBoundary label="logged today">
                <LoggedToday entries={snapshot.activity} zone={snapshot.zone} />
              </SectionBoundary>
            </Section>
          ) : null}

          {dayIsEmpty ? (
            <EmptyState
              icon="sunny-outline"
              title="Nothing on today"
              hint={'Try: "remind me to call the dentist at 3pm" or "add gym to my habits"'}
            />
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

/** "Tuesday 11 August" — the date the header carries under the word Today. */
function longDate(epoch: number, zone?: string): string {
  return epochToLocal(epoch, zone).toFormat('cccc d LLLL');
}
