/**
 * Every React Query key in the app, in one typed factory.
 *
 * A mutation has to invalidate exactly what it changed. Spelling those keys out
 * at each call site guarantees they drift: a screen reads `['tasks', filter]`
 * while the mutation invalidates `['tasks']` with a different shape, and the
 * list silently stops refreshing. So keys are only ever produced here, and the
 * few cache operations that take keys live alongside them.
 *
 * Every key starts with the same root segment and nests domain -> view, so a
 * domain-wide `invalidateQueries({ queryKey: qk.tasks.all })` prefix-matches
 * every list, detail and derived view inside it.
 */
import type { QueryClient, QueryKey } from '@tanstack/react-query';

import type { LocalDate } from '@/core/time';
// The module, not the barrel: '@/features/briefing' reaches the voice stack,
// and a key factory must stay free of runtime imports.
import type { BriefingScope } from '@/features/briefing/collect';
import type { LedgerQuerySpec } from '@/repositories/ledger';
import type { ListNotesOptions } from '@/repositories/notes';
import type { ProjectStatus } from '@/repositories/projects';
import type { SettingKey } from '@/repositories/settings';
import type { SyncStatus } from '@/repositories/syncQueue';
import type { ListActiveOptions, ListTasksFilter } from '@/repositories/tasks';

const ROOT = 'ridik';

export const qk = {
  all: [ROOT] as const,

  /** The Today screen is one aggregated query, keyed on the local day it shows. */
  today: {
    all: [ROOT, 'today'] as const,
    snapshot: (date: LocalDate, zone: string) => [ROOT, 'today', 'snapshot', date, zone] as const,
  },

  tasks: {
    all: [ROOT, 'tasks'] as const,
    list: (filter: ListTasksFilter = {}) => [ROOT, 'tasks', 'list', filter] as const,
    active: (options: ListActiveOptions = {}) => [ROOT, 'tasks', 'active', options] as const,
    detail: (id: string) => [ROOT, 'tasks', 'detail', id] as const,
    blockers: (id: string) => [ROOT, 'tasks', 'blockers', id] as const,
    dependents: (id: string) => [ROOT, 'tasks', 'dependents', id] as const,
    graph: () => [ROOT, 'tasks', 'graph'] as const,
  },

  notes: {
    all: [ROOT, 'notes'] as const,
    list: (options: ListNotesOptions = {}) => [ROOT, 'notes', 'list', options] as const,
    detail: (id: string) => [ROOT, 'notes', 'detail', id] as const,
    tags: (includeArchived = false) => [ROOT, 'notes', 'tags', includeArchived] as const,
    search: (query: string, limit: number, includeArchived: boolean) =>
      [ROOT, 'notes', 'search', query, limit, includeArchived] as const,
  },

  checklists: {
    all: [ROOT, 'checklists'] as const,
    names: () => [ROOT, 'checklists', 'names'] as const,
    items: (listName: string, includeCompleted = true) =>
      [ROOT, 'checklists', 'items', listName, includeCompleted] as const,
    detail: (id: string) => [ROOT, 'checklists', 'detail', id] as const,
  },

  projects: {
    all: [ROOT, 'projects'] as const,
    list: (status?: ProjectStatus) => [ROOT, 'projects', 'list', status ?? null] as const,
    /** The list screen's rows: every project plus the counts its progress bar needs. */
    summaries: (status?: ProjectStatus) => [ROOT, 'projects', 'summaries', status ?? null] as const,
    detail: (id: string) => [ROOT, 'projects', 'detail', id] as const,
    overview: (id: string) => [ROOT, 'projects', 'overview', id] as const,
    items: (id: string) => [ROOT, 'projects', 'items', id] as const,
    sections: (id: string) => [ROOT, 'projects', 'sections', id] as const,
  },

  calendar: {
    all: [ROOT, 'calendar'] as const,
    range: (from: number, to: number, includeDeleted = false) =>
      [ROOT, 'calendar', 'range', from, to, includeDeleted] as const,
    day: (date: LocalDate, zone: string) => [ROOT, 'calendar', 'day', date, zone] as const,
    detail: (id: string) => [ROOT, 'calendar', 'detail', id] as const,
    conflicts: (startsAt: number, endsAt: number, excludeId: string | null) =>
      [ROOT, 'calendar', 'conflicts', startsAt, endsAt, excludeId] as const,
    buffers: (id: string) => [ROOT, 'calendar', 'buffers', id] as const,
    pending: (limit: number) => [ROOT, 'calendar', 'pending', limit] as const,
  },

  /** The offline outbox — its counts are the sync badge on Today. */
  sync: {
    all: [ROOT, 'sync'] as const,
    counts: () => [ROOT, 'sync', 'counts'] as const,
    byStatus: (status: SyncStatus, limit: number) =>
      [ROOT, 'sync', 'byStatus', status, limit] as const,
    forEntity: (entityId: string) => [ROOT, 'sync', 'forEntity', entityId] as const,
  },

  ledger: {
    all: [ROOT, 'ledger'] as const,
    query: (spec: LedgerQuerySpec = {}) => [ROOT, 'ledger', 'query', spec] as const,
    recent: (limit: number) => [ROOT, 'ledger', 'recent', limit] as const,
    forEntity: (name: string, limit: number) =>
      [ROOT, 'ledger', 'forEntity', name, limit] as const,
    categories: () => [ROOT, 'ledger', 'categories'] as const,
    monthly: (months: number, zone: string | null) =>
      [ROOT, 'ledger', 'monthly', months, zone] as const,
  },

  habits: {
    all: [ROOT, 'habits'] as const,
    list: (includeArchived = false) => [ROOT, 'habits', 'list', includeArchived] as const,
    detail: (id: string) => [ROOT, 'habits', 'detail', id] as const,
    history: (id: string, from: LocalDate | null, to: LocalDate | null) =>
      [ROOT, 'habits', 'history', id, from, to] as const,
    /**
     * Every habit's history in one entry, for the widget rails.
     *
     * Filed under `habits` on purpose: logging a habit invalidates
     * `qk.habits.all`, and a rail that did not sit under that prefix would keep
     * drawing yesterday's board until the app was restarted.
     */
    historyAll: (ids: readonly string[], from: LocalDate, to: LocalDate) =>
      [ROOT, 'habits', 'history-all', [...ids].sort().join(','), from, to] as const,
  },

  /** What the home-screen widgets need and no screen does. */
  widgets: {
    all: [ROOT, 'widgets'] as const,
    usage: () => [ROOT, 'widgets', 'usage'] as const,
  },

  /** Logging a habit writes here too, which is why the two invalidate together. */
  activity: {
    all: [ROOT, 'activity'] as const,
    recent: (limit: number) => [ROOT, 'activity', 'recent', limit] as const,
    day: (date: LocalDate) => [ROOT, 'activity', 'day', date] as const,
    between: (from: number, to: number) => [ROOT, 'activity', 'between', from, to] as const,
    summary: (from: LocalDate, to: LocalDate) =>
      [ROOT, 'activity', 'summary', from, to] as const,
  },

  crm: {
    all: [ROOT, 'crm'] as const,
    entities: () => [ROOT, 'crm', 'entities'] as const,
    profile: (id: string) => [ROOT, 'crm', 'profile', id] as const,
    openCommitments: (dueBefore: number | null) =>
      [ROOT, 'crm', 'commitments', 'open', dueBefore] as const,
    commitmentsFor: (entityId: string) => [ROOT, 'crm', 'commitments', 'for', entityId] as const,
  },

  curriculum: {
    all: [ROOT, 'curriculum'] as const,
    entries: (activeOnly: boolean) => [ROOT, 'curriculum', 'entries', activeOnly] as const,
    day: (dayOfWeek: number, activeOnly: boolean) =>
      [ROOT, 'curriculum', 'day', dayOfWeek, activeOnly] as const,
    subjects: () => [ROOT, 'curriculum', 'subjects'] as const,
    upcoming: (from: number | null, days: number, zone: string) =>
      [ROOT, 'curriculum', 'upcoming', from, days, zone] as const,
    next: (subject: string, zone: string) => [ROOT, 'curriculum', 'next', subject, zone] as const,
    homeworkDue: (subject: string, hoursBefore: number | null, zone: string) =>
      [ROOT, 'curriculum', 'homeworkDue', subject, hoursBefore, zone] as const,
  },

  places: {
    all: [ROOT, 'places'] as const,
    list: () => [ROOT, 'places', 'list'] as const,
    detail: (id: string) => [ROOT, 'places', 'detail', id] as const,
  },

  /** Location reminders hang off saved places, so they share a screen and a file. */
  geofences: {
    all: [ROOT, 'geofences'] as const,
    list: () => [ROOT, 'geofences', 'list'] as const,
    active: () => [ROOT, 'geofences', 'active'] as const,
    detail: (id: string) => [ROOT, 'geofences', 'detail', id] as const,
  },

  assistant: {
    all: [ROOT, 'assistant'] as const,
    mode: () => [ROOT, 'assistant', 'mode'] as const,
  },

  /** The assistant's own spend meter; invalidated after every metered turn. */
  usage: {
    all: [ROOT, 'usage'] as const,
    snapshot: (daily: number, monthly: number) =>
      [ROOT, 'usage', 'snapshot', daily, monthly] as const,
  },

  settings: {
    all: [ROOT, 'settings'] as const,
    values: () => [ROOT, 'settings', 'values'] as const,
    detail: (key: SettingKey) => [ROOT, 'settings', 'detail', key] as const,
    raw: (key: SettingKey) => [ROOT, 'settings', 'raw', key] as const,
  },

  /**
   * Device and service state, not app data: OS permissions, the calendar
   * connection, background availability, the database's own size. It is cached
   * like everything else so Settings can render instantly and refresh behind
   * the user, but nothing here is invalidated by a repository write — only by
   * the prompt or the sync that actually changed it.
   */
  billing: {
    all: [ROOT, 'billing'] as const,
    entitlement: () => [ROOT, 'billing', 'entitlement'] as const,
    plans: () => [ROOT, 'billing', 'plans'] as const,
    marketing: () => [ROOT, 'billing', 'marketing'] as const,
  },
  system: {
    all: [ROOT, 'system'] as const,
    secret: (slot: string) => [ROOT, 'system', 'secret', slot] as const,
    permissions: () => [ROOT, 'system', 'permissions'] as const,
    calendar: () => [ROOT, 'system', 'calendar'] as const,
    background: () => [ROOT, 'system', 'background'] as const,
    geofence: () => [ROOT, 'system', 'geofence'] as const,
    database: () => [ROOT, 'system', 'database'] as const,
  },

  focus: {
    all: [ROOT, 'focus'] as const,
    active: () => [ROOT, 'focus', 'active'] as const,
    detail: (id: string) => [ROOT, 'focus', 'detail', id] as const,
    recent: (limit: number) => [ROOT, 'focus', 'recent', limit] as const,
    minutes: (from: number, to: number) => [ROOT, 'focus', 'minutes', from, to] as const,
  },

  /** One composed briefing per scope; every domain it reads invalidates it. */
  briefing: {
    all: [ROOT, 'briefing'] as const,
    scope: (scope: BriefingScope) => [ROOT, 'briefing', 'scope', scope] as const,
  },
} as const;

export type QueryKeys = typeof qk;

/** Anything `qk` produces, plus the `.all` prefixes. */
export type KeyLike = readonly unknown[];

/** What `onMutate` hands to `onError` so a failed optimistic write can be undone. */
export type QuerySnapshot = ReadonlyArray<readonly [QueryKey, unknown]>;

/**
 * Stops in-flight refetches for these prefixes.
 *
 * The first half of an optimistic update: a response that was already on the
 * wire when the user tapped would otherwise land *after* the optimistic write
 * and stamp the stale value back over it.
 */
export async function cancelKeys(client: QueryClient, keys: readonly KeyLike[]): Promise<void> {
  await Promise.all(keys.map((queryKey) => client.cancelQueries({ queryKey })));
}

/** Captures every cached query under these prefixes, exactly as it is now. */
export function snapshotQueries(client: QueryClient, keys: readonly KeyLike[]): QuerySnapshot {
  return keys.flatMap((queryKey) => client.getQueriesData({ queryKey }));
}

/** Puts a snapshot back. Safe to call with `undefined` — an `onError` context may be missing. */
export function restoreQueries(client: QueryClient, snapshot: QuerySnapshot | undefined): void {
  if (!snapshot) return;
  for (const [queryKey, data] of snapshot) {
    // Wrapped in a thunk: a raw value that happened to be a function would be
    // taken for an updater.
    client.setQueryData<unknown>(queryKey, () => data);
  }
}

export async function invalidateKeys(client: QueryClient, keys: readonly KeyLike[]): Promise<void> {
  await Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey })));
}
