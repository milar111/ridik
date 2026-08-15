/**
 * The single place the app resolves repositories.
 *
 * Repositories are constructed against an injected database handle so tests can
 * build a complete, isolated set over an in-memory SQLite file — exactly what
 * the executor tests do.
 */
import type { RidikDatabase } from '@/db/migrator';
import { createLogger } from '@/core/logger';

import { createActivityRepository } from './activity';
import { createCalendarEventsRepository } from './calendarEvents';
import { createChecklistsRepository } from './checklists';
import { createCrmRepository } from './crm';
import { createCurriculumRepository } from './curriculum';
import { createFocusSessionsRepository } from './focusSessions';
import { createGeofencesRepository } from './geofences';
import { createHabitsRepository } from './habits';
import { createLedgerRepository } from './ledger';
import { createNotesRepository } from './notes';
import { createPlacesRepository } from './places';
import { createProjectsRepository } from './projects';
import { createSettingsRepository } from './settings';
import { createSyncQueueRepository } from './syncQueue';
import { createTasksRepository } from './tasks';
import { createUsageRepository } from './usage';

export type Repositories = {
  activity: ReturnType<typeof createActivityRepository>;
  calendar: ReturnType<typeof createCalendarEventsRepository>;
  checklists: ReturnType<typeof createChecklistsRepository>;
  crm: ReturnType<typeof createCrmRepository>;
  curriculum: ReturnType<typeof createCurriculumRepository>;
  focus: ReturnType<typeof createFocusSessionsRepository>;
  geofences: ReturnType<typeof createGeofencesRepository>;
  habits: ReturnType<typeof createHabitsRepository>;
  ledger: ReturnType<typeof createLedgerRepository>;
  notes: ReturnType<typeof createNotesRepository>;
  places: ReturnType<typeof createPlacesRepository>;
  projects: ReturnType<typeof createProjectsRepository>;
  settings: ReturnType<typeof createSettingsRepository>;
  syncQueue: ReturnType<typeof createSyncQueueRepository>;
  tasks: ReturnType<typeof createTasksRepository>;
  /** Has each part of the app ever been used — see `usage.ts`. */
  usage: ReturnType<typeof createUsageRepository>;
  db: RidikDatabase;
};

export function createRepositories(db: RidikDatabase): Repositories {
  return {
    activity: createActivityRepository(db),
    calendar: createCalendarEventsRepository(db),
    checklists: createChecklistsRepository(db),
    crm: createCrmRepository(db),
    curriculum: createCurriculumRepository(db),
    focus: createFocusSessionsRepository(db),
    geofences: createGeofencesRepository(db),
    habits: createHabitsRepository(db),
    ledger: createLedgerRepository(db),
    notes: createNotesRepository(db),
    places: createPlacesRepository(db),
    projects: createProjectsRepository(db),
    settings: createSettingsRepository(db, { logger: createLogger('settings') }),
    syncQueue: createSyncQueueRepository(db),
    tasks: createTasksRepository(db),
    usage: createUsageRepository(db),
    db,
  };
}

let cached: Repositories | null = null;

/**
 * App-wide singleton bound to the on-device database.
 *
 * `@/db` is required lazily so this module stays loadable under plain Node —
 * tests and dev scripts build their own `Repositories` over a file or in-memory
 * database and must never drag in the expo-sqlite native module.
 */
export function getRepositories(): Repositories {
  if (!cached) {
    const { getDb } = require('@/db') as typeof import('@/db');
    cached = createRepositories(getDb());
  }
  return cached;
}

/** Test hook — drops the singleton so the next call rebuilds it. */
export function resetRepositories(): void {
  cached = null;
}

export * from './activity';
export * from './calendarEvents';
export * from './checklists';
export * from './crm';
export * from './curriculum';
export * from './focusSessions';
export * from './geofences';
export * from './habits';
export * from './ledger';
export * from './notes';
export * from './places';
export * from './projects';
export * from './settings';
export * from './syncQueue';
export * from './tasks';
