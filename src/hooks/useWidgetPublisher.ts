import { useEffect, useMemo } from 'react';

import { useNow } from '@/features/today/useNow';
import { parsePhases } from '@/repositories/focusSessions';
import { buildWidgetSnapshot } from '@/services/widgets/snapshot';
import { publishWidgetSnapshot } from '@/services/widgets/publish';
import { useChecklistItems, useChecklistNames } from './useChecklists';
import { useEmberChoice } from './useEmber';
import { useActiveFocusSession } from './useFocus';
import { useToday } from './useToday';
import { useWidgetSources } from './useWidgetSources';

/**
 * Keeps the home-screen widgets fed, from wherever the user happens to be.
 *
 * Mounted once at the root rather than on a screen: a widget that only refreshed
 * while you had Ridik open, on the screen that happens to hold the same query,
 * would be stalest exactly when it is most useful — on the home screen of a
 * phone whose owner has not opened the app today.
 *
 * The minute clock is what advances "next" past a meeting that has finished
 * without anyone touching the app. It costs nothing when nothing changed:
 * `publishWidgetSnapshot` compares against the last payload and declines to
 * spend one of the OS's rationed reloads on an identical face.
 */
export function useWidgetPublisher(): void {
  const today = useToday();
  const at = useNow();
  const snapshot = today.data;
  // The store rather than the setting, so the tiles are drawn in the ember the
  // app is drawn in at that moment — the two are read from one place and cannot
  // disagree while a write is settling.
  const ember = useEmberChoice();

  // The list widget shows one list, and the one worth showing is the one with
  // something left on it. `listNames` is already ordered by the repository, so
  // this is the first with open items rather than a second sort.
  const names = useChecklistNames();
  const focus = (names.data ?? []).find((list) => list.open > 0) ?? names.data?.[0];
  const items = useChecklistItems(focus?.name, { includeCompleted: true, enabled: Boolean(focus) });

  const list = useMemo(
    () =>
      focus && items.data
        ? {
            name: focus.name,
            rows: items.data.map((item) => ({ text: item.itemText, done: Boolean(item.isCompleted) })),
          }
        : null,
    [focus, items.data],
  );

  // Stable across renders so the history query key does not churn: the ids come
  // from `snapshot.habits`, which is a fresh array on every refetch.
  const habitIds = useMemo(
    () => (snapshot?.habits ?? []).map((entry) => entry.habit.id),
    [snapshot?.habits],
  );

  /**
   * The running focus session, for the Focus face.
   *
   * `null` is the ordinary case and the face draws for it. What must not happen
   * is publishing `null` *while the query is still in flight*: the tile would
   * say "No session." over one that is running, and if the app is closed in that
   * beat that is what stays on the home screen. So it joins the settled gate
   * below, exactly as the checklist does and for the same reason.
   */
  const session = useActiveFocusSession();

  const sources = useWidgetSources({
    date: snapshot?.date,
    zone: snapshot?.zone,
    habitIds,
  });

  /**
   * Hold the first publish until every source has answered.
   *
   * Today's snapshot resolves a beat before the others, and publishing in that
   * gap writes a payload with `list: null` and an empty month — which the
   * widgets draw, correctly for what they were handed, as "No lists yet" over a
   * list that exists and a blank August that has events in it. If the app is
   * closed before the next publish, that is what stays on the home screen.
   *
   * Settled, not successful: a query that *fails* must not hold the other
   * widgets hostage. A disabled query stays pending forever in TanStack v5,
   * which is why `focus` is checked before `items` at all.
   */
  const listSettled = !names.isPending && (!focus || !items.isPending);
  const ready = listSettled && !session.isPending && sources.settled;

  useEffect(() => {
    if (!snapshot || !ready) return;
    void publishWidgetSnapshot(
      buildWidgetSnapshot({
        snapshot,
        now: at,
        list,
        monthEvents: sources.monthEvents,
        habitHistory: sources.habitHistory,
        counts: sources.counts,
        ember,
        // The row, not a derived state: `buildFocus` needs the phase list and
        // when the current one started, and does its own arithmetic against the
        // publish clock so the payload and the tile agree about the same moment.
        focus: session.data
          ? {
              label: session.data.label,
              phases: parsePhases(session.data.phases),
              phaseIndex: session.data.phaseIndex,
              phaseStartedAt: session.data.phaseStartedAt,
              pausedAt: session.data.pausedAt,
              status: session.data.status === 'paused' ? 'paused' : 'running',
            }
          : null,
      }),
    );
  }, [
    snapshot,
    at,
    list,
    ready,
    sources.monthEvents,
    sources.habitHistory,
    sources.counts,
    ember,
    // Pausing a session changes nothing about the day and everything about the
    // Focus tile: without this the strip would keep its shape and the countdown
    // would keep running until the next minute tick republished by accident.
    session.data,
  ]);
}
