/**
 * The typed settings store.
 *
 * Reads are total by construction: the repository decodes a missing, corrupt or
 * outdated row to that key's declared default, and `useSetting` falls back to
 * the same default while the query is still in flight — so a screen never has
 * to render an "unknown" state for a toggle.
 *
 * Writes are optimistic. A switch that snaps back for 40ms before settling
 * reads as a bug, so the cache moves first and only rolls back on a real
 * failure (a value the key's schema rejects).
 */
import { useMemo } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { createUsageMeter, type UsageSnapshot } from '@/llm/usage';
import { isValidZone, setClockFormat, setZoneOverride } from '@/core/time';
import { getRepositories } from '@/repositories';
import {
  defaultSettings,
  type SettingKey,
  type SettingsValues,
} from '@/repositories/settings';

import {
  cancelKeys,
  invalidateKeys,
  qk,
  restoreQueries,
  snapshotQueries,
  type QuerySnapshot,
} from './keys';

type OptimisticContext = { previous: QuerySnapshot };

/* ------------------------------------------------------------------- reads */

export function useSettings(): UseQueryResult<SettingsValues> {
  return useQuery({
    queryKey: qk.settings.values(),
    queryFn: () => getRepositories().settings.getAll(),
  });
}

/** One key, read on its own. Prefer `useSetting` unless you only need the value. */
export function useSettingValue<K extends SettingKey>(key: K): UseQueryResult<SettingsValues[K]> {
  return useQuery({
    queryKey: qk.settings.detail(key),
    queryFn: () => getRepositories().settings.get(key),
  });
}

/** The raw stored JSON, for the diagnostics screen. */
export function useRawSetting(key: SettingKey): UseQueryResult<string | null> {
  return useQuery({
    queryKey: qk.settings.raw(key),
    queryFn: () => getRepositories().settings.getRaw(key),
  });
}

/* ------------------------------------------------------------------ writes */

/**
 * The one setting that is also *module state*.
 *
 * `src/core/time.ts` holds the active zone in a module variable, and the
 * `timezone` bootstrap step runs once, memoised. Applying the zone only there
 * would leave every "today" boundary, day heading and dictated date on the old
 * zone until the process restarted.
 *
 * Applied here rather than in an effect somewhere, because a write is the only
 * moment the answer changes and an effect would have to guess when to look.
 */
function applyZone(patch: Partial<SettingsValues>): void {
  if (!('timezone' in patch)) return;
  const zone = patch.timezone;
  // An invalid zone is refused rather than applied: Luxon would silently answer
  // in UTC, and every date in the app would be wrong with nothing to point at.
  setZoneOverride(typeof zone === 'string' && zone.trim() && isValidZone(zone) ? zone : null);
}

/** `clockFormat` is the second setting that is module state, for the same reason. */
function applyClock(patch: Partial<SettingsValues>): void {
  if (!('clockFormat' in patch) || !patch.clockFormat) return;
  setClockFormat(patch.clockFormat);
}

export function useSetSettings(): UseMutationResult<
  SettingsValues,
  Error,
  Partial<SettingsValues>,
  OptimisticContext
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<SettingsValues>) => {
      const values = await getRepositories().settings.setMany(patch);
      applyZone(patch);
      applyClock(patch);
      return values;
    },
    onMutate: async (patch) => {
      await cancelKeys(client, [qk.settings.all]);
      const previous = snapshotQueries(client, [qk.settings.all]);
      client.setQueryData<SettingsValues>(qk.settings.values(), (current) =>
        current ? { ...current, ...patch } : current,
      );
      return { previous };
    },
    onError: (_error, _patch, context) => restoreQueries(client, context?.previous),
    onSuccess: (values) => client.setQueryData<SettingsValues>(qk.settings.values(), values),
    onSettled: (_values, _error, patch) =>
      // A zone change invalidates everything, not just the settings.
      //
      // Every cached day heading, "today" boundary and `dayRange` key was
      // computed against the old zone, so leaving them would show yesterday's
      // agenda under today's date. It re-renders every screen, which is visible
      // — and correct: the alternative is a screenful of dates that are quietly
      // wrong until something else happens to refetch them.
      invalidateKeys(client, [
        'timezone' in patch || 'clockFormat' in patch ? qk.all : qk.settings.all,
      ]),
  });
}

export function useResetSetting(): UseMutationResult<
  SettingsValues[SettingKey],
  Error,
  SettingKey
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (key: SettingKey) => {
      const value = await getRepositories().settings.reset(key);
      // Resetting the zone means "use the device's", which is what a null
      // override restores.
      if (key === 'timezone') setZoneOverride(null);
      if (key === 'clockFormat') setClockFormat('auto');
      return value;
    },
    onSettled: () => invalidateKeys(client, [qk.settings.all]),
  });
}

export function useResetAllSettings(): UseMutationResult<SettingsValues, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const values = await getRepositories().settings.resetAll();
      setZoneOverride(null);
      setClockFormat('auto');
      return values;
    },
    onSettled: () => invalidateKeys(client, [qk.settings.all]),
  });
}

/* ------------------------------------------------------------ one setting */

export type SettingHandle<K extends SettingKey> = {
  /** The stored value, or this key's declared default until the read lands. */
  value: SettingsValues[K];
  /** False once a value (stored or default) is available to render. */
  isLoading: boolean;
  error: Error | null;
  /** Fire-and-forget; the cache already shows the new value. */
  set: (value: SettingsValues[K]) => void;
  setAsync: (value: SettingsValues[K]) => Promise<SettingsValues[K]>;
  isSaving: boolean;
};

/**
 * Read and write a single setting.
 *
 * The generic keeps the key and the value correlated: `useSetting('ttsRate')`
 * only accepts a number, and `useSetting('briefingEnabled')` only a boolean.
 */
export function useSetting<K extends SettingKey>(key: K): SettingHandle<K> {
  const client = useQueryClient();
  const query = useSettings();
  const fallback = useMemo(() => defaultSettings()[key], [key]);

  const mutation = useMutation<SettingsValues[K], Error, SettingsValues[K], OptimisticContext>({
    mutationFn: (value) => getRepositories().settings.set(key, value),
    onMutate: async (value) => {
      await cancelKeys(client, [qk.settings.all]);
      const previous = snapshotQueries(client, [qk.settings.all]);
      client.setQueryData<SettingsValues>(qk.settings.values(), (current) =>
        current ? ({ ...current, [key]: value } as SettingsValues) : current,
      );
      client.setQueryData<SettingsValues[K]>(qk.settings.detail(key), () => value);
      return { previous };
    },
    onError: (_error, _value, context) => restoreQueries(client, context?.previous),
    onSettled: () => invalidateKeys(client, [qk.settings.all]),
  });

  return {
    value: query.data ? query.data[key] : fallback,
    isLoading: query.isLoading,
    error: query.error,
    set: (value) => mutation.mutate(value),
    setAsync: (value) => mutation.mutateAsync(value),
    isSaving: mutation.isPending,
  };
}

/**
 * What the assistant has spent, against the caps currently configured.
 *
 * Polled rather than pushed: a turn can be metered from the voice pipeline,
 * which has no access to the query client, and a stale-by-thirty-seconds
 * counter on a settings screen costs nothing.
 */
export function useAssistantUsage(
  dailyCap: number,
  monthlyCap: number,
): UseQueryResult<UsageSnapshot> {
  return useQuery({
    queryKey: qk.usage.snapshot(dailyCap, monthlyCap),
    queryFn: () =>
      createUsageMeter(getRepositories().db).snapshot({ daily: dailyCap, monthly: monthlyCap }),
    refetchInterval: 30_000,
  });
}
