import { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';

import { now } from '@/core/clock';
import { localDateOf } from '@/core/time';
import { useSetting } from '@/hooks';

/**
 * Puts the briefing in front of you once, the first time you open the app on a
 * given day.
 *
 * This replaced a notification scheduled for an hour you picked. The trade is
 * deliberate and worth stating: a morning notification reaches you whether or
 * not you open Ridik, and this does not. What it buys is one fewer setting, and
 * a briefing that is generated at the moment you read it rather than whenever
 * it happened to be queued — so it is never a summary of a day that has since
 * changed.
 *
 * Keyed on the local date rather than a timestamp: "already seen today" has to
 * survive a restart, a timezone change and crossing midnight mid-session.
 */
export function useDailyBriefing(enabled: boolean): void {
  const router = useRouter();
  const lastShown = useSetting('lastBriefingShown');
  // Within one launch this is the guard that matters. The setting write is
  // asynchronous, so two renders can both read the old value and both navigate.
  const presented = useRef(false);

  // `enabled` is the caller's "the day has loaded". Two reasons to wait for it:
  // the navigator is not ready on the very first render — expo-router drops a
  // push made then, with no error — and a briefing opened over a database that
  // has not finished migrating would summarise nothing.
  const ready = enabled && !lastShown.isLoading;
  const today = localDateOf(now());
  const due = ready && lastShown.value !== today;

  useEffect(() => {
    if (!due || presented.current) return;
    presented.current = true;
    // Navigate first, record second. The other order marks the day as seen even
    // when the push does not land, and the briefing is then silently skipped
    // until tomorrow — which is exactly how this went wrong the first time.
    // Showing it twice is a far cheaper failure than never showing it.
    router.push('/briefing');
    lastShown.set(today);
  }, [due, today, lastShown, router]);
}
