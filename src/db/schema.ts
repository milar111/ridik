/**
 * Drizzle schema — the type-safe query surface.
 *
 * This mirrors `src/db/migrations.ts`, which owns the DDL. `schema.test.ts`
 * asserts the two agree column-for-column so they cannot silently drift.
 */
import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';

const epoch = (name: string) => integer(name, { mode: 'number' });
const bool = (name: string) => integer(name, { mode: 'boolean' });

/* -------------------------------------------------------------------------- */
/* Curriculum                                                                  */
/* -------------------------------------------------------------------------- */
export const curriculumSchedule = sqliteTable(
  'curriculum_schedule',
  {
    id: text('id').primaryKey(),
    subjectName: text('subject_name').notNull(),
    dayOfWeek: integer('day_of_week').notNull(),
    startTime: text('start_time').notNull(),
    endTime: text('end_time').notNull(),
    location: text('location'),
    weekParity: text('week_parity', { enum: ['every', 'odd', 'even'] }).notNull().default('every'),
    teacher: text('teacher'),
    color: text('color'),
    isActive: bool('is_active').notNull().default(true),
    createdAt: epoch('created_at').notNull().default(0),
    updatedAt: epoch('updated_at').notNull().default(0),
  },
  (t) => [
    index('idx_curriculum_day').on(t.dayOfWeek, t.isActive),
    index('idx_curriculum_subject').on(t.subjectName),
  ],
);

/* -------------------------------------------------------------------------- */
/* Projects / groups / events                                                  */
/* -------------------------------------------------------------------------- */
export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['project', 'event', 'trip', 'area', 'course'] })
      .notNull()
      .default('project'),
    description: text('description'),
    status: text('status', { enum: ['active', 'paused', 'done', 'archived'] })
      .notNull()
      .default('active'),
    startDate: epoch('start_date'),
    targetDate: epoch('target_date'),
    color: text('color'),
    emoji: text('emoji'),
    createdAt: epoch('created_at').notNull(),
    updatedAt: epoch('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_projects_name').on(sql`${t.name} COLLATE NOCASE`),
    index('idx_projects_status').on(t.status, t.updatedAt),
  ],
);

export const projectSections = sqliteTable(
  'project_sections',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    orderIndex: integer('order_index').notNull().default(0),
    createdAt: epoch('created_at').notNull(),
  },
  (t) => [index('idx_project_sections').on(t.projectId, t.orderIndex)],
);

export const projectItems = sqliteTable(
  'project_items',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sectionId: text('section_id').references(() => projectSections.id, { onDelete: 'set null' }),
    kind: text('kind', { enum: ['idea', 'todo', 'note', 'link', 'milestone', 'question'] })
      .notNull()
      .default('idea'),
    content: text('content').notNull(),
    detail: text('detail'),
    isCheckbox: bool('is_checkbox').notNull().default(false),
    isCompleted: bool('is_completed').notNull().default(false),
    completedAt: epoch('completed_at'),
    orderIndex: integer('order_index').notNull().default(0),
    dueDate: epoch('due_date'),
    createdAt: epoch('created_at').notNull(),
    updatedAt: epoch('updated_at').notNull(),
  },
  (t) => [
    index('idx_project_items').on(t.projectId, t.isCompleted, t.orderIndex),
    index('idx_project_items_section').on(t.sectionId, t.orderIndex),
  ],
);

/* -------------------------------------------------------------------------- */
/* Notes                                                                       */
/* -------------------------------------------------------------------------- */
export const notes = sqliteTable(
  'notes',
  {
    id: text('id').primaryKey(),
    titleSummary: text('title_summary').notNull(),
    categoryTag: text('category_tag').notNull(),
    createdAt: epoch('created_at').notNull(),
    updatedAt: epoch('updated_at').notNull(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    isPinned: bool('is_pinned').notNull().default(false),
    isArchived: bool('is_archived').notNull().default(false),
  },
  (t) => [
    index('idx_notes_category').on(sql`${t.categoryTag} COLLATE NOCASE`),
    index('idx_notes_project').on(t.projectId),
    uniqueIndex('idx_notes_title_tag').on(
      sql`${t.titleSummary} COLLATE NOCASE`,
      sql`${t.categoryTag} COLLATE NOCASE`,
    ),
  ],
);

export const noteBullets = sqliteTable(
  'note_bullets',
  {
    id: text('id').primaryKey(),
    noteId: text('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    orderIndex: integer('order_index').notNull(),
    bulletKind: text('bullet_kind', { enum: ['text', 'todo'] }).notNull().default('text'),
    isCompleted: bool('is_completed').notNull().default(false),
    createdAt: epoch('created_at').notNull().default(0),
  },
  (t) => [index('idx_note_bullets').on(t.noteId, t.orderIndex)],
);

/* -------------------------------------------------------------------------- */
/* Habits & activity                                                           */
/* -------------------------------------------------------------------------- */
export const habits = sqliteTable('habits', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  currentStreak: integer('current_streak').default(0),
  lastCompletedDate: text('last_completed_date'),
  longestStreak: integer('longest_streak').notNull().default(0),
  targetPerWeek: integer('target_per_week'),
  unit: text('unit', { enum: ['session', 'minutes', 'count'] }).notNull().default('session'),
  color: text('color'),
  isArchived: bool('is_archived').notNull().default(false),
  createdAt: epoch('created_at').notNull().default(0),
});

export const activityFeed = sqliteTable(
  'activity_feed',
  {
    id: text('id').primaryKey(),
    habitId: text('habit_id').references(() => habits.id, { onDelete: 'set null' }),
    description: text('description').notNull(),
    durationMinutes: integer('duration_minutes'),
    loggedAt: epoch('logged_at').notNull(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    localDate: text('local_date').notNull().default(''),
    source: text('source').notNull().default('voice'),
  },
  (t) => [
    index('idx_activity_logged').on(t.loggedAt),
    index('idx_activity_habit').on(t.habitId, t.loggedAt),
    index('idx_activity_date').on(t.localDate),
  ],
);

/* -------------------------------------------------------------------------- */
/* Ledger                                                                      */
/* -------------------------------------------------------------------------- */
export const transactions = sqliteTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    amount: real('amount').notNull(),
    currency: text('currency').notNull(),
    category: text('category').notNull(),
    entityName: text('entity_name'),
    description: text('description'),
    createdAt: epoch('created_at').notNull(),
    direction: text('direction', { enum: ['expense', 'income'] }).notNull().default('expense'),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    localDate: text('local_date').notNull().default(''),
  },
  (t) => [
    index('idx_tx_created').on(t.createdAt),
    index('idx_tx_category').on(sql`${t.category} COLLATE NOCASE`, t.createdAt),
    index('idx_tx_entity').on(sql`${t.entityName} COLLATE NOCASE`),
  ],
);

/* -------------------------------------------------------------------------- */
/* Checklists                                                                  */
/* -------------------------------------------------------------------------- */
export const checklists = sqliteTable(
  'checklists',
  {
    id: text('id').primaryKey(),
    listName: text('list_name').notNull(),
    itemText: text('item_text').notNull(),
    isCompleted: bool('is_completed').default(false),
    createdAt: epoch('created_at').notNull(),
    quantity: text('quantity'),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    orderIndex: integer('order_index').notNull().default(0),
    completedAt: epoch('completed_at'),
  },
  (t) => [
    index('idx_checklists_list').on(
      sql`${t.listName} COLLATE NOCASE`,
      t.isCompleted,
      t.orderIndex,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* Places & geofences                                                          */
/* -------------------------------------------------------------------------- */
export const savedPlaces = sqliteTable(
  'saved_places',
  {
    id: text('id').primaryKey(),
    label: text('label').notNull(),
    latitude: real('latitude').notNull(),
    longitude: real('longitude').notNull(),
    radiusMeters: integer('radius_meters').notNull().default(150),
    address: text('address'),
    createdAt: epoch('created_at').notNull(),
  },
  (t) => [uniqueIndex('idx_places_label').on(sql`${t.label} COLLATE NOCASE`)],
);

export const geofenceTriggers = sqliteTable(
  'geofence_triggers',
  {
    id: text('id').primaryKey(),
    label: text('label').notNull(),
    latitude: real('latitude').notNull(),
    longitude: real('longitude').notNull(),
    radiusMeters: integer('radius_meters').notNull(),
    triggerType: text('trigger_type', { enum: ['ENTER', 'EXIT'] }).notNull(),
    actionDescription: text('action_description').notNull(),
    isActive: bool('is_active').default(true),
    placeId: text('place_id').references(() => savedPlaces.id, { onDelete: 'set null' }),
    taskId: text('task_id'),
    oneShot: bool('one_shot').notNull().default(true),
    cooldownSeconds: integer('cooldown_seconds').notNull().default(900),
    lastTriggeredAt: epoch('last_triggered_at'),
    expiresAt: epoch('expires_at'),
    registered: bool('registered').notNull().default(false),
    createdAt: epoch('created_at').notNull().default(0),
  },
  (t) => [index('idx_geofence_active').on(t.isActive, t.createdAt)],
);

/* -------------------------------------------------------------------------- */
/* Micro-CRM                                                                   */
/* -------------------------------------------------------------------------- */
export const crmEntities = sqliteTable('crm_entities', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  relationshipContext: text('relationship_context'),
  aliases: text('aliases'),
  createdAt: epoch('created_at').notNull().default(0),
  updatedAt: epoch('updated_at').notNull().default(0),
});

export const crmCommitments = sqliteTable(
  'crm_commitments',
  {
    id: text('id').primaryKey(),
    entityId: text('entity_id')
      .notNull()
      .references(() => crmEntities.id, { onDelete: 'cascade' }),
    commitmentText: text('commitment_text').notNull(),
    dueDate: epoch('due_date'),
    isCompleted: bool('is_completed').default(false),
    createdAt: epoch('created_at').notNull(),
    direction: text('direction', { enum: ['i_owe', 'they_owe'] }).notNull().default('i_owe'),
    taskId: text('task_id'),
    completedAt: epoch('completed_at'),
  },
  (t) => [
    index('idx_commitments_entity').on(t.entityId, t.isCompleted),
    index('idx_commitments_due').on(t.isCompleted, t.dueDate),
  ],
);

export const crmInteractions = sqliteTable(
  'crm_interactions',
  {
    id: text('id').primaryKey(),
    entityId: text('entity_id')
      .notNull()
      .references(() => crmEntities.id, { onDelete: 'cascade' }),
    summary: text('summary').notNull(),
    occurredAt: epoch('occurred_at').notNull(),
    createdAt: epoch('created_at').notNull(),
  },
  (t) => [index('idx_interactions_entity').on(t.entityId, t.occurredAt)],
);

/* -------------------------------------------------------------------------- */
/* Tasks & DAG                                                                 */
/* -------------------------------------------------------------------------- */
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    dueDate: epoch('due_date'),
    isCompleted: bool('is_completed').default(false),
    isLocked: bool('is_locked').default(false),
    createdAt: epoch('created_at').notNull(),
    notes: text('notes'),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    priority: integer('priority').notNull().default(2),
    estimatedMinutes: integer('estimated_minutes'),
    completedAt: epoch('completed_at'),
    unlockedAt: epoch('unlocked_at'),
    calendarEventId: text('calendar_event_id'),
    source: text('source').notNull().default('voice'),
    updatedAt: epoch('updated_at').notNull().default(0),
  },
  (t) => [
    index('idx_tasks_active').on(t.isCompleted, t.isLocked, t.dueDate),
    index('idx_tasks_project').on(t.projectId, t.isCompleted),
  ],
);

export const taskDependencies = sqliteTable(
  'task_dependencies',
  {
    parentTaskId: text('parent_task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    childTaskId: text('child_task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.parentTaskId, t.childTaskId] }),
    index('idx_deps_child').on(t.childTaskId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Calendar mirror & sync queue                                                */
/* -------------------------------------------------------------------------- */
export const calendarEvents = sqliteTable(
  'calendar_events',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    description: text('description'),
    location: text('location'),
    startsAt: epoch('starts_at').notNull(),
    endsAt: epoch('ends_at').notNull(),
    allDay: bool('all_day').notNull().default(false),
    timezone: text('timezone').notNull().default('UTC'),
    kind: text('kind', {
      enum: ['event', 'buffer', 'exam', 'class', 'reminder', 'focus'],
    })
      .notNull()
      .default('event'),
    bufferForId: text('buffer_for_id'),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    taskId: text('task_id'),
    googleEventId: text('google_event_id'),
    googleCalendarId: text('google_calendar_id'),
    nativeEventId: text('native_event_id'),
    syncStatus: text('sync_status', { enum: ['pending', 'synced', 'failed', 'local_only'] })
      .notNull()
      .default('pending'),
    syncError: text('sync_error'),
    deletedAt: epoch('deleted_at'),
    createdAt: epoch('created_at').notNull(),
    updatedAt: epoch('updated_at').notNull(),
  },
  (t) => [
    index('idx_events_range').on(t.startsAt, t.endsAt),
    index('idx_events_sync').on(t.syncStatus),
  ],
);

export const syncQueue = sqliteTable(
  'sync_queue',
  {
    id: text('id').primaryKey(),
    operation: text('operation').notNull(),
    entityTable: text('entity_table').notNull(),
    entityId: text('entity_id').notNull(),
    payload: text('payload').notNull(),
    status: text('status', { enum: ['pending', 'in_flight', 'failed', 'done'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: epoch('next_attempt_at').notNull().default(0),
    lastError: text('last_error'),
    createdAt: epoch('created_at').notNull(),
    updatedAt: epoch('updated_at').notNull(),
  },
  (t) => [index('idx_syncq_ready').on(t.status, t.nextAttemptAt)],
);

/* -------------------------------------------------------------------------- */
/* Focus sessions                                                              */
/* -------------------------------------------------------------------------- */
export const focusSessions = sqliteTable(
  'focus_sessions',
  {
    id: text('id').primaryKey(),
    label: text('label').notNull(),
    subject: text('subject'),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    phases: text('phases').notNull(),
    phaseIndex: integer('phase_index').notNull().default(0),
    phaseStartedAt: epoch('phase_started_at').notNull(),
    pausedAt: epoch('paused_at'),
    accumulatedPauseMs: epoch('accumulated_pause_ms').notNull().default(0),
    status: text('status', { enum: ['running', 'paused', 'completed', 'cancelled'] })
      .notNull()
      .default('running'),
    startedAt: epoch('started_at').notNull(),
    endedAt: epoch('ended_at'),
    liveActivityId: text('live_activity_id'),
    createdAt: epoch('created_at').notNull(),
    updatedAt: epoch('updated_at').notNull(),
  },
  (t) => [index('idx_focus_status').on(t.status, t.startedAt)],
);

/* -------------------------------------------------------------------------- */
/* Settings & LLM audit trail                                                  */
/* -------------------------------------------------------------------------- */
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: epoch('updated_at').notNull(),
});

export const llmInteractions = sqliteTable(
  'llm_interactions',
  {
    id: text('id').primaryKey(),
    transcript: text('transcript').notNull(),
    confidence: real('confidence'),
    rawResponse: text('raw_response'),
    actions: text('actions'),
    feedback: text('feedback'),
    status: text('status', { enum: ['ok', 'clarify', 'error'] }).notNull().default('ok'),
    error: text('error'),
    latencyMs: integer('latency_ms'),
    model: text('model'),
    createdAt: epoch('created_at').notNull(),
  },
  (t) => [index('idx_llm_created').on(t.createdAt)],
);

export const schema = {
  curriculumSchedule,
  projects,
  projectSections,
  projectItems,
  notes,
  noteBullets,
  habits,
  activityFeed,
  transactions,
  checklists,
  savedPlaces,
  geofenceTriggers,
  crmEntities,
  crmCommitments,
  crmInteractions,
  tasks,
  taskDependencies,
  calendarEvents,
  syncQueue,
  focusSessions,
  appSettings,
  llmInteractions,
};

export type Schema = typeof schema;

/* Row types ---------------------------------------------------------------- */
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type ProjectSection = typeof projectSections.$inferSelect;
export type ProjectItem = typeof projectItems.$inferSelect;
export type NewProjectItem = typeof projectItems.$inferInsert;
export type Note = typeof notes.$inferSelect;
export type NoteBullet = typeof noteBullets.$inferSelect;
export type Habit = typeof habits.$inferSelect;
export type ActivityEntry = typeof activityFeed.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type ChecklistItem = typeof checklists.$inferSelect;
export type SavedPlace = typeof savedPlaces.$inferSelect;
export type GeofenceTrigger = typeof geofenceTriggers.$inferSelect;
export type CrmEntity = typeof crmEntities.$inferSelect;
export type CrmCommitment = typeof crmCommitments.$inferSelect;
export type CrmInteraction = typeof crmInteractions.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskDependency = typeof taskDependencies.$inferSelect;
export type CalendarEvent = typeof calendarEvents.$inferSelect;
export type NewCalendarEvent = typeof calendarEvents.$inferInsert;
export type SyncQueueEntry = typeof syncQueue.$inferSelect;
export type FocusSession = typeof focusSessions.$inferSelect;
export type CurriculumEntry = typeof curriculumSchedule.$inferSelect;
export type LlmInteraction = typeof llmInteractions.$inferSelect;
