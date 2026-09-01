/**
 * Hand-written, versioned SQL migrations.
 *
 * We deliberately own the DDL rather than delegating to `drizzle-kit push`:
 * a shipped mobile app must migrate *existing user data* deterministically and
 * offline, and it must do so identically under expo-sqlite (device) and
 * node:sqlite (tests). `PRAGMA user_version` is the version cursor.
 *
 * Rules:
 *  - Never edit a migration that has shipped. Append a new one.
 *  - Every timestamp column is UTC epoch **milliseconds** (INTEGER).
 *  - Every `id` is an application-generated ULID-ish TEXT (see `src/db/ids.ts`).
 */

export type Migration = {
  /** Monotonic, 1-based. Matches the value written to PRAGMA user_version. */
  version: number;
  name: string;
  /** Executed as a single script inside one transaction. */
  sql: string;
};

const m001_initial = /* sql */ `
--------------------------------------------------------------------------------
-- CURRICULUM & RECURRING PROGRAM
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS curriculum_schedule (
  id            TEXT PRIMARY KEY,
  subject_name  TEXT NOT NULL,
  day_of_week   INTEGER NOT NULL,             -- 0 (Sun) .. 6 (Sat)
  start_time    TEXT NOT NULL,                -- "08:00" local wall-clock
  end_time      TEXT NOT NULL,                -- "09:30" local wall-clock
  location      TEXT,
  -- extensions
  week_parity   TEXT NOT NULL DEFAULT 'every' CHECK (week_parity IN ('every','odd','even')),
  teacher       TEXT,
  color         TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL DEFAULT 0,
  CHECK (day_of_week BETWEEN 0 AND 6)
);
CREATE INDEX IF NOT EXISTS idx_curriculum_day ON curriculum_schedule(day_of_week, is_active);
CREATE INDEX IF NOT EXISTS idx_curriculum_subject ON curriculum_schedule(subject_name);

--------------------------------------------------------------------------------
-- PROJECTS / GROUPS / EVENTS  (containers you can dump ideas into)
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'project'
                CHECK (kind IN ('project','event','trip','area','course')),
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','paused','done','archived')),
  start_date    INTEGER,
  target_date   INTEGER,
  color         TEXT,
  emoji         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name ON projects(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status, updated_at DESC);

-- Free-form sections inside a project ("Packing", "Ideas", "Budget", ...)
CREATE TABLE IF NOT EXISTS project_sections (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  title         TEXT NOT NULL,
  order_index   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_project_sections ON project_sections(project_id, order_index);

-- The "just say it and it lands in the project" table.
CREATE TABLE IF NOT EXISTS project_items (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  section_id    TEXT,
  kind          TEXT NOT NULL DEFAULT 'idea'
                CHECK (kind IN ('idea','todo','note','link','milestone','question')),
  content       TEXT NOT NULL,
  detail        TEXT,
  is_checkbox   INTEGER NOT NULL DEFAULT 0,
  is_completed  INTEGER NOT NULL DEFAULT 0,
  completed_at  INTEGER,
  order_index   INTEGER NOT NULL DEFAULT 0,
  due_date      INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (section_id) REFERENCES project_sections(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_project_items ON project_items(project_id, is_completed, order_index);
CREATE INDEX IF NOT EXISTS idx_project_items_section ON project_items(section_id, order_index);

--------------------------------------------------------------------------------
-- STRUCTURED NOTES
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notes (
  id            TEXT PRIMARY KEY,
  title_summary TEXT NOT NULL,
  category_tag  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  -- extensions
  project_id    TEXT,
  is_pinned     INTEGER NOT NULL DEFAULT 0,
  is_archived   INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_category ON notes(category_tag COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_title_tag
  ON notes(title_summary COLLATE NOCASE, category_tag COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS note_bullets (
  id            TEXT PRIMARY KEY,
  note_id       TEXT NOT NULL,
  content       TEXT NOT NULL,
  order_index   INTEGER NOT NULL,
  -- extensions
  bullet_kind   TEXT NOT NULL DEFAULT 'text' CHECK (bullet_kind IN ('text','todo')),
  is_completed  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_note_bullets ON note_bullets(note_id, order_index);

--------------------------------------------------------------------------------
-- HABITS & ACTIVITY FEED
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS habits (
  id                   TEXT PRIMARY KEY,
  name                 TEXT UNIQUE NOT NULL,
  current_streak       INTEGER DEFAULT 0,
  last_completed_date  TEXT,                  -- "YYYY-MM-DD" in the user's local tz
  -- extensions
  longest_streak       INTEGER NOT NULL DEFAULT 0,
  target_per_week      INTEGER,
  unit                 TEXT NOT NULL DEFAULT 'session' CHECK (unit IN ('session','minutes','count')),
  color                TEXT,
  is_archived          INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS activity_feed (
  id               TEXT PRIMARY KEY,
  habit_id         TEXT,
  description      TEXT NOT NULL,
  duration_minutes INTEGER,
  logged_at        INTEGER NOT NULL,
  -- extensions
  project_id       TEXT,
  local_date       TEXT NOT NULL DEFAULT '',  -- "YYYY-MM-DD", for cheap day grouping
  source           TEXT NOT NULL DEFAULT 'voice',
  FOREIGN KEY (habit_id) REFERENCES habits(id) ON DELETE SET NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_logged ON activity_feed(logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_habit ON activity_feed(habit_id, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_date ON activity_feed(local_date);

--------------------------------------------------------------------------------
-- MICRO-FINANCIAL LEDGER
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id           TEXT PRIMARY KEY,
  amount       REAL NOT NULL,
  currency     TEXT NOT NULL,                 -- ISO-4217, normalised upper-case
  category     TEXT NOT NULL,
  entity_name  TEXT,
  description  TEXT,
  created_at   INTEGER NOT NULL,
  -- extensions
  direction    TEXT NOT NULL DEFAULT 'expense' CHECK (direction IN ('expense','income')),
  project_id   TEXT,
  local_date   TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category COLLATE NOCASE, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_entity ON transactions(entity_name COLLATE NOCASE);

--------------------------------------------------------------------------------
-- CHECKLISTS (transient / micro-inventory)
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS checklists (
  id            TEXT PRIMARY KEY,
  list_name     TEXT NOT NULL,
  item_text     TEXT NOT NULL,
  is_completed  INTEGER DEFAULT 0,
  created_at    INTEGER NOT NULL,
  -- extensions
  quantity      TEXT,
  project_id    TEXT,
  order_index   INTEGER NOT NULL DEFAULT 0,
  completed_at  INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_checklists_list
  ON checklists(list_name COLLATE NOCASE, is_completed, order_index);

--------------------------------------------------------------------------------
-- SAVED PLACES + GEOFENCING TRIGGERS
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saved_places (
  id             TEXT PRIMARY KEY,
  label          TEXT NOT NULL,
  latitude       REAL NOT NULL,
  longitude      REAL NOT NULL,
  radius_meters  INTEGER NOT NULL DEFAULT 150,
  address        TEXT,
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_places_label ON saved_places(label COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS geofence_triggers (
  id                  TEXT PRIMARY KEY,
  label               TEXT NOT NULL,
  latitude            REAL NOT NULL,
  longitude           REAL NOT NULL,
  radius_meters       INTEGER NOT NULL,
  trigger_type        TEXT NOT NULL CHECK (trigger_type IN ('ENTER','EXIT')),
  action_description  TEXT NOT NULL,
  is_active           INTEGER DEFAULT 1,
  -- extensions
  place_id            TEXT,
  task_id             TEXT,
  one_shot            INTEGER NOT NULL DEFAULT 1,
  cooldown_seconds    INTEGER NOT NULL DEFAULT 900,
  last_triggered_at   INTEGER,
  expires_at          INTEGER,
  registered          INTEGER NOT NULL DEFAULT 0,  -- currently handed to the OS
  created_at          INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (place_id) REFERENCES saved_places(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_geofence_active ON geofence_triggers(is_active, created_at DESC);

--------------------------------------------------------------------------------
-- MICRO-CRM
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_entities (
  id                    TEXT PRIMARY KEY,
  name                  TEXT UNIQUE NOT NULL,
  relationship_context  TEXT,
  -- extensions
  aliases               TEXT,                  -- JSON array of alternative spellings
  created_at            INTEGER NOT NULL DEFAULT 0,
  updated_at            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS crm_commitments (
  id               TEXT PRIMARY KEY,
  entity_id        TEXT NOT NULL,
  commitment_text  TEXT NOT NULL,
  due_date         INTEGER,
  is_completed     INTEGER DEFAULT 0,
  created_at       INTEGER NOT NULL,
  -- extensions
  direction        TEXT NOT NULL DEFAULT 'i_owe' CHECK (direction IN ('i_owe','they_owe')),
  task_id          TEXT,
  completed_at     INTEGER,
  FOREIGN KEY (entity_id) REFERENCES crm_entities(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_commitments_entity ON crm_commitments(entity_id, is_completed);
CREATE INDEX IF NOT EXISTS idx_commitments_due ON crm_commitments(is_completed, due_date);

CREATE TABLE IF NOT EXISTS crm_interactions (
  id           TEXT PRIMARY KEY,
  entity_id    TEXT NOT NULL,
  summary      TEXT NOT NULL,
  occurred_at  INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (entity_id) REFERENCES crm_entities(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_interactions_entity ON crm_interactions(entity_id, occurred_at DESC);

--------------------------------------------------------------------------------
-- DEPENDENCY-CHAIN TASKS
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  due_date           INTEGER,
  is_completed       INTEGER DEFAULT 0,
  is_locked          INTEGER DEFAULT 0,
  created_at         INTEGER NOT NULL,
  -- extensions
  notes              TEXT,
  project_id         TEXT,
  priority           INTEGER NOT NULL DEFAULT 2,   -- 1 high .. 3 low
  estimated_minutes  INTEGER,
  completed_at       INTEGER,
  unlocked_at        INTEGER,
  calendar_event_id  TEXT,
  source             TEXT NOT NULL DEFAULT 'voice',
  updated_at         INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(is_completed, is_locked, due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, is_completed);

CREATE TABLE IF NOT EXISTS task_dependencies (
  parent_task_id  TEXT NOT NULL,               -- prerequisite
  child_task_id   TEXT NOT NULL,               -- blocked task
  PRIMARY KEY (parent_task_id, child_task_id),
  FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (child_task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_deps_child ON task_dependencies(child_task_id);

--------------------------------------------------------------------------------
-- CALENDAR MIRROR + OFFLINE SYNC
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar_events (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  description        TEXT,
  location           TEXT,
  starts_at          INTEGER NOT NULL,          -- UTC epoch ms
  ends_at            INTEGER NOT NULL,
  all_day            INTEGER NOT NULL DEFAULT 0,
  timezone           TEXT NOT NULL DEFAULT 'UTC',
  kind               TEXT NOT NULL DEFAULT 'event'
                     CHECK (kind IN ('event','buffer','exam','class','reminder','focus')),
  buffer_for_id      TEXT,                      -- set on auto-created travel/prep blocks
  project_id         TEXT,
  task_id            TEXT,
  google_event_id    TEXT,
  google_calendar_id TEXT,
  native_event_id    TEXT,
  sync_status        TEXT NOT NULL DEFAULT 'pending'
                     CHECK (sync_status IN ('pending','synced','failed','local_only')),
  sync_error         TEXT,
  deleted_at         INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  FOREIGN KEY (buffer_for_id) REFERENCES calendar_events(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_events_range ON calendar_events(starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_events_sync ON calendar_events(sync_status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_google
  ON calendar_events(google_event_id) WHERE google_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sync_queue (
  id              TEXT PRIMARY KEY,
  operation       TEXT NOT NULL,               -- e.g. 'calendar.create'
  entity_table    TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  payload         TEXT NOT NULL,               -- JSON
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','in_flight','failed','done')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_syncq_ready ON sync_queue(status, next_attempt_at);

--------------------------------------------------------------------------------
-- FOCUS SESSIONS (live timers)
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS focus_sessions (
  id                  TEXT PRIMARY KEY,
  label               TEXT NOT NULL,
  subject             TEXT,
  project_id          TEXT,
  phases              TEXT NOT NULL,           -- JSON: [{kind:'focus'|'break',minutes:n}]
  phase_index         INTEGER NOT NULL DEFAULT 0,
  phase_started_at    INTEGER NOT NULL,
  paused_at           INTEGER,
  accumulated_pause_ms INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running','paused','completed','cancelled')),
  started_at          INTEGER NOT NULL,
  ended_at            INTEGER,
  live_activity_id    TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_focus_status ON focus_sessions(status, started_at DESC);

--------------------------------------------------------------------------------
-- SETTINGS + LLM AUDIT TRAIL
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,                   -- JSON-encoded
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_interactions (
  id             TEXT PRIMARY KEY,
  transcript     TEXT NOT NULL,
  confidence     REAL,
  raw_response   TEXT,
  actions        TEXT,                         -- JSON array of executed actions
  feedback       TEXT,
  status         TEXT NOT NULL DEFAULT 'ok'
                 CHECK (status IN ('ok','clarify','error')),
  error          TEXT,
  latency_ms     INTEGER,
  model          TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_created ON llm_interactions(created_at DESC);
`;

/**
 * Full-text search over notes. Kept in its own migration because FTS5 is a
 * compile-time option: if the runtime lacks it we skip this migration and the
 * repositories fall back to LIKE scanning (see `notes` repository).
 */
const m002_notes_fts = /* sql */ `
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  note_id UNINDEXED,
  title,
  tag,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

/**
 * A running tally of what the assistant has cost, kept per local day.
 *
 * Separate from `llm_interactions` because that table is an audit trail that
 * can be pruned, while this is the meter the spend cap reads. Counting rows in
 * an audit log is not a billing control.
 */
const m003_llm_usage = /* sql */ `
CREATE TABLE IF NOT EXISTS llm_usage (
  local_date     TEXT PRIMARY KEY,          -- "YYYY-MM-DD" in the user's zone
  requests       INTEGER NOT NULL DEFAULT 0,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  -- Micro-units of the provider's currency: integers avoid float drift over
  -- thousands of tiny additions.
  cost_micros    INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL
);
`;

/**
 * Cached input tokens, so prompt caching can be judged rather than assumed.
 *
 * A provider that serves part of the prompt from a cache charges roughly a
 * tenth for those tokens and reports them as a *subset* of the input count —
 * which means without this column a cache hit is completely invisible: the same
 * request count, the same input tokens, and a cost estimate that quietly bills
 * every cached token at full price. Separate column rather than a smaller
 * `input_tokens`, because the two numbers answer different questions ("how big
 * is a turn" and "how much of it was free").
 */
const m004_llm_usage_cached = /* sql */ `
ALTER TABLE llm_usage ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;
`;

/**
 * Billable provider calls, kept apart from the requests the user made.
 *
 * `requests` is one per utterance and always was — it is the unit the spend
 * sliders are labelled in and the unit a plan is sold in ("300 requests a
 * month"). One utterance can cost the provider more than one call, though: a
 * transport retry, or a reply the schema rejected and the model was asked to
 * repair, each of which is a full request carrying everything before it. Adding
 * those to `requests` made a turn that failed twice eat three of the user's
 * three hundred, which is charging somebody for the app's own retries.
 *
 * So the two numbers get two columns. Money is already honest without this one
 * — tokens and cost are summed across every call — but "this turn billed three
 * times" is otherwise invisible, and it is the thing worth noticing.
 */
const m005_llm_usage_calls = /* sql */ `
ALTER TABLE llm_usage ADD COLUMN calls INTEGER NOT NULL DEFAULT 0;
`;

/**
 * What the user does with the app, counted — and only counted.
 *
 * The app measured its own latency for months and threw the measurement away;
 * this is the same mistake one level up. Nothing here is content: `name` comes
 * from a closed union in `services/analytics/events.ts`, `props` is that
 * event's own schema and has no free-text field anywhere in it, and
 * `local_date` is deliberately the finest time this table records — a
 * millisecond timestamp on a behavioural row is a session reconstruction
 * waiting to happen.
 *
 * `created_at` exists so the ring buffer can prune in insertion order and is
 * **never uploaded**; `uploaded_at` stays NULL for ever unless the user turns
 * layer 2 on. The partial index is what makes "the unsent ones" cheap without
 * paying for an index over a table that is mostly sent.
 */
const m006_app_events = /* sql */ `
CREATE TABLE IF NOT EXISTS app_events (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  props       TEXT NOT NULL,
  local_date  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  uploaded_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_app_events_date ON app_events(local_date);
CREATE INDEX IF NOT EXISTS idx_app_events_unsent ON app_events(uploaded_at) WHERE uploaded_at IS NULL;
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial_schema', sql: m001_initial },
  { version: 2, name: 'notes_fts5', sql: m002_notes_fts },
  { version: 3, name: 'llm_usage', sql: m003_llm_usage },
  { version: 4, name: 'llm_usage_cached_tokens', sql: m004_llm_usage_cached },
  { version: 5, name: 'llm_usage_calls', sql: m005_llm_usage_calls },
  { version: 6, name: 'app_events', sql: m006_app_events },
];

/** Migrations that must be skipped (not failed) when FTS5 is unavailable. */
export const FTS_MIGRATION_VERSIONS = new Set<number>([2]);

export const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
