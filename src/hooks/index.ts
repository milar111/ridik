/**
 * The data layer every screen imports.
 *
 * One entry point on purpose: a screen should never reach past this into
 * `@/repositories`, because a direct repository call bypasses the cache and the
 * invalidation graph, and the screen next to it then shows stale rows.
 */
export {
  qk,
  cancelKeys,
  invalidateKeys,
  restoreQueries,
  snapshotQueries,
  type KeyLike,
  type QueryKeys,
  type QuerySnapshot,
} from './keys';

export * from './useToday';
export * from './useTasks';
export * from './useNotes';
export * from './useChecklists';
export * from './useProjects';
export * from './useCalendar';
export * from './useLedger';
export * from './useHabits';
export * from './useCrm';
export * from './useCurriculum';
export * from './usePlaces';
export * from './useSettings';
export * from './useFocus';
