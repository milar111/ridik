import { useEffect } from 'react';

import { useNow } from '@/features/today/useNow';
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

  useEffect(() => {
    if (!snapshot) return;
    void publishWidgetSnapshot(buildWidgetSnapshot({ snapshot, now: at }));
  }, [snapshot, at]);
}
