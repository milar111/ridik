import { useEffect, useMemo } from 'react';

import { useNow } from '@/features/today/useNow';
import { useChecklistItems, useChecklistNames } from './useChecklists';
import { buildWidgetSnapshot } from '@/services/widgets/snapshot';
import { publishWidgetSnapshot } from '@/services/widgets/publish';
import { useToday } from './useToday';

/**
 * Keeps the home-screen widget fed, from wherever the user happens to be.
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

  /**
   * Hold the first publish until the list queries have answered.
   *
   * Today's snapshot resolves a beat before the checklists do, and publishing
   * in that gap writes a payload with `list: null` — which the list widget
   * draws, correctly for what it was handed, as "No lists yet". If the app is
   * closed before the next publish that sentence is what stays on the home
   * screen, and it is a lie about a list that exists.
   *
   * Settled, not successful: a checklist query that *fails* must not hold the
   * other four widgets hostage. A disabled query stays pending forever in
   * TanStack v5, which is why `focus` is checked before `items` at all.
   */
  const listSettled = !names.isPending && (!focus || !items.isPending);

  useEffect(() => {
    if (!snapshot || !listSettled) return;
    void publishWidgetSnapshot(buildWidgetSnapshot({ snapshot, now: at, list }));
  }, [snapshot, at, list, listSettled]);
}
