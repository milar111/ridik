/**
 * The chosen ember — the one colour the whole app and both widgets are built
 * from.
 *
 * It is a stored setting like any other, and it is read like no other: through a
 * tiny store rather than through the query cache. `ThemeProvider` is mounted
 * *above* `QueryClientProvider` in `app/_layout.tsx` — it has to be, because the
 * toast host and the boot overlay inside that provider are already themed — so
 * the one component that needs this value is the one component that cannot ask
 * a query for it. The store is also what lets the widget publisher hand the
 * widgets exactly the ember the app is painting with, without either of them
 * having to re-read the row.
 *
 * The row in `app_settings` stays the truth. This is a cache of it that repaints
 * synchronously: a palette that snapped back to orange for 40ms after being set
 * to rust would read as a bug, and the theme sits above every screen so there is
 * no optimistic update to lean on.
 */
import { useEffect, useRef } from 'react';
import { create } from 'zustand';

import { getRepositories } from '@/repositories';
import { DEFAULT_EMBER, EMBER_NAMES, embers, type EmberName, type EmberOption } from '@/ui/theme';

import { useSetting } from './useSettings';

const store = create<{ ember: EmberName }>(() => ({ ember: DEFAULT_EMBER }));

/** Built once: a fresh array every render would rebuild the picker's rows. */
const OPTIONS: EmberOption[] = EMBER_NAMES.map((name) => embers[name]);

/** What the app is currently drawn in. Re-renders on a change, like a query. */
export function useEmberChoice(): EmberName {
  return store((state) => state.ember);
}

/** The same value, for anything that is not a component. */
export function emberChoice(): EmberName {
  return store.getState().ember;
}

/**
 * Repaint in a different ember.
 *
 * Does not persist — `useEmber().set` does both, and tests use this on its own
 * to put the store back where they found it.
 */
export function setEmberChoice(ember: EmberName): void {
  store.setState({ ember });
}

/**
 * Read the stored ember into the store. Called once, by `ThemeProvider`.
 *
 * Total: a database that is not open yet, or a test with no repositories behind
 * it at all, leaves the default in place rather than throwing inside the
 * provider that every screen renders under.
 */
export async function loadEmber(): Promise<EmberName> {
  try {
    const stored = await getRepositories().settings.get('ember');
    setEmberChoice(stored);
    return stored;
  } catch {
    return emberChoice();
  }
}

export type EmberHandle = {
  /** The ember being drawn right now, which is what the picker must tick. */
  value: EmberName;
  /** Every option, in the order Settings offers them. */
  options: EmberOption[];
  /** Repaints immediately and persists in the background. */
  set: (ember: EmberName) => void;
  isSaving: boolean;
};

/** Read and write the setting, for the screen that offers the choice. */
export function useEmber(): EmberHandle {
  const setting = useSetting('ember');
  const value = useEmberChoice();
  const seen = useRef<EmberName | null>(null);

  useEffect(() => {
    // Only once the row has actually been read. While the query is in flight
    // `setting.value` is the *declared default*, and mirroring that would flash
    // the whole app back to orange every time this screen was opened by
    // somebody who had chosen otherwise.
    if (setting.isLoading) return;
    const before = seen.current;
    seen.current = setting.value;
    // And only when the row *changes*. The first value this screen reads is the
    // same one the store was hydrated from, except in the one case where it is
    // not: a read that lands a beat after the user has tapped a colour still
    // carries the old row, and mirroring it would flash the previous palette
    // over the choice they just made. A later change — the settings being reset
    // from the developer screen, say — is real news and does repaint.
    if (before !== null && before !== setting.value) setEmberChoice(setting.value);
  }, [setting.isLoading, setting.value]);

  return {
    value,
    options: OPTIONS,
    isSaving: setting.isSaving,
    set: (ember) => {
      setEmberChoice(ember);
      setting.set(ember);
    },
  };
}
