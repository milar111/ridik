import { useEffect, useMemo } from 'react';

import { useNow } from '@/features/today/useNow';
import { buildWidgetSnapshot } from '@/services/widgets/snapshot';
import { publishWidgetSnapshot } from '@/services/widgets/publish';
import { useChecklistItems, useChecklistNames } from './useChecklists';
import { useEmberChoice } from './useEmber';
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
  const ready = listSettled && sources.settled;

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
      }),
    );
  }, [snapshot, at, list, ready, sources.monthEvents, sources.habitHistory, sources.counts, ember]);
}
