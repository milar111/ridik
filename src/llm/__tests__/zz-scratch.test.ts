import { freezeClock } from '@/core/clock';
import { localToEpoch, setZoneOverride } from '@/core/time';
import type { RidikDatabase } from '@/db/migrator';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import { createLlmClient } from '@/llm/client';
import { createOrchestrator } from '@/llm/orchestrator';
import { createMockProvider } from '@/llm/provider';
import type { Repositories } from '@/repositories';
import { createActivityRepository } from '@/repositories/activity';
import { createCalendarEventsRepository } from '@/repositories/calendarEvents';
import { createChecklistsRepository } from '@/repositories/checklists';
import { createCrmRepository } from '@/repositories/crm';
import { createCurriculumRepository } from '@/repositories/curriculum';
import { createFocusSessionsRepository } from '@/repositories/focusSessions';
import { createGeofencesRepository } from '@/repositories/geofences';
import { createHabitsRepository } from '@/repositories/habits';
import { createLedgerRepository } from '@/repositories/ledger';
import { createLlmInteractionsRepository } from '@/repositories/llmInteractions';
import { createNotesRepository } from '@/repositories/notes';
import { createPlacesRepository } from '@/repositories/places';
import { createProjectsRepository } from '@/repositories/projects';
import { createSettingsRepository } from '@/repositories/settings';
import { createSyncQueueRepository } from '@/repositories/syncQueue';
import { createTasksRepository } from '@/repositories/tasks';
import { createUsageRepository } from '@/repositories/usage';

const ZONE = 'Europe/Sofia';
const NOW = localToEpoch('2026-03-09T08:00', ZONE);

function buildRepositories(db: RidikDatabase): Repositories {
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
    llmInteractions: createLlmInteractionsRepository(db),
    notes: createNotesRepository(db),
    places: createPlacesRepository(db),
    projects: createProjectsRepository(db),
    settings: createSettingsRepository(db),
    syncQueue: createSyncQueueRepository(db),
    tasks: createTasksRepository(db),
    usage: createUsageRepository(db),
    db,
  };
}

const REPLY = JSON.stringify({
  conversational_feedback: 'Sure.',
  actions: [
    {
      tool_name: 'curriculum_add',
      parameters: {
        entries: [
          { subject_name: 'Physics', day_of_week: 1, start_time: '08:00', end_time: '09:00' },
        ],
        replace_existing: true,
      },
    },
  ],
});

describe('scratch e2e', () => {
  let t: TestDatabase;
  let repos: Repositories;
  let restoreClock: () => void;

  beforeEach(() => {
    setZoneOverride(ZONE);
    restoreClock = freezeClock(NOW);
    t = createTestDatabase();
    repos = buildRepositories(t.db);
  });

  afterEach(() => {
    restoreClock();
    setZoneOverride(null);
    t.close();
  });

  it('replaces the whole timetable behind a blank question', async () => {
    await repos.curriculum.replaceAll([
      { subject_name: 'Maths', day_of_week: 1, start_time: '09:00', end_time: '10:00' },
      { subject_name: 'Chemistry', day_of_week: 2, start_time: '09:00', end_time: '10:00' },
      { subject_name: 'History', day_of_week: 3, start_time: '09:00', end_time: '10:00' },
    ] as never);
    // eslint-disable-next-line no-console
    console.log('before:', (await repos.curriculum.listEntries()).length);

    const provider = createMockProvider({ responses: [REPLY] });
    const client = createLlmClient({ provider, sleep: async () => {} });
    const orchestrator = createOrchestrator({ repos, client, zone: ZONE, confirmMode: 'irreversible' });

    const first = await orchestrator.interpretAndExecute({
      transcript: 'physics monday at eight',
      confidence: 0.97,
    });
    // eslint-disable-next-line no-console
    console.log('FIRST feedback:', first.feedback);
    // eslint-disable-next-line no-console
    console.log('FIRST clarification:', JSON.stringify(first.clarification));
    // eslint-disable-next-line no-console
    console.log('after first:', (await repos.curriculum.listEntries()).length);

    const second = await orchestrator.interpretAndExecute({
      transcript: 'yes',
      confidence: 0.97,
      ...(first.clarification?.pending ? { pending: first.clarification.pending } : {}),
    });
    // eslint-disable-next-line no-console
    console.log('SECOND feedback:', second.feedback);
    const rows = await repos.curriculum.listEntries();
    // eslint-disable-next-line no-console
    console.log('after yes:', rows.length, rows.map((r) => r.subjectName));
  });
});
