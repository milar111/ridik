/**
 * The LLM tool-calling contract.
 *
 * This is the seam between a probabilistic model and a deterministic database.
 * Everything the model can do to the user's data passes through these Zod
 * schemas first; anything that does not validate never reaches a repository.
 *
 * Design notes:
 *  - Datetimes are **wall-clock strings** (`YYYY-MM-DDTHH:mm`), never epochs and
 *    never offsets. The model is told "now" and the user's IANA zone; we resolve
 *    to UTC ourselves so DST is our problem, not the model's.
 *  - Entity references are fuzzy *queries*, not ids. The model has never seen an
 *    id; resolution happens in the executor where we can score and disambiguate.
 *  - Every tool carries only what a human would say out loud. Anything derivable
 *    (order indexes, streaks, buffers) is computed locally.
 */
import { z } from 'zod';
import { LOCAL_DATETIME_RE, LOCAL_DATE_RE, TIME_OF_DAY_RE } from '@/core/time';

/* ------------------------------------------------------------ primitives -- */

const nonEmpty = (max = 500) => z.string().trim().min(1).max(max);

export const localDateTimeSchema = z
  .string()
  .regex(LOCAL_DATETIME_RE, 'Expected YYYY-MM-DDTHH:mm (local wall clock, no timezone offset)');

export const localDateSchema = z.string().regex(LOCAL_DATE_RE, 'Expected YYYY-MM-DD');

export const timeOfDaySchema = z.string().regex(TIME_OF_DAY_RE, 'Expected HH:mm (24-hour)');

export const dayOfWeekSchema = z
  .number()
  .int()
  .min(0)
  .max(6)
  .describe('0 = Sunday .. 6 = Saturday');

/** ISO-4217, upper-cased. Accepts common symbols and words from speech. */
export const currencySchema = z
  .string()
  .trim()
  .min(1)
  .max(24)
  .transform((v) => normaliseCurrency(v));

const SYMBOL_TO_ISO: Record<string, string> = {
  '€': 'EUR',
  '$': 'USD',
  '£': 'GBP',
  '¥': 'JPY',
  '₽': 'RUB',
  '₹': 'INR',
  'лв': 'BGN',
  'лв.': 'BGN',
};

const WORD_TO_ISO: Record<string, string> = {
  euro: 'EUR',
  euros: 'EUR',
  eur: 'EUR',
  dollar: 'USD',
  dollars: 'USD',
  bucks: 'USD',
  buck: 'USD',
  usd: 'USD',
  pound: 'GBP',
  pounds: 'GBP',
  quid: 'GBP',
  gbp: 'GBP',
  lev: 'BGN',
  leva: 'BGN',
  bgn: 'BGN',
  yen: 'JPY',
  jpy: 'JPY',
  rupee: 'INR',
  rupees: 'INR',
  inr: 'INR',
};

export function normaliseCurrency(input: string): string {
  const raw = input.trim();
  if (SYMBOL_TO_ISO[raw]) return SYMBOL_TO_ISO[raw]!;
  const lower = raw.toLowerCase();
  if (WORD_TO_ISO[lower]) return WORD_TO_ISO[lower]!;
  const upper = raw.toUpperCase();
  if (/^[A-Z]{3}$/.test(upper)) return upper;
  return upper.slice(0, 3);
}

/** How the model points at something that already exists. */
export const entityQuerySchema = z.object({
  query: nonEmpty(200).describe('Words the user used, e.g. "math homework"'),
  on_date: localDateSchema.optional().describe('Narrows the search to one day'),
  near_time: localDateTimeSchema.optional(),
});
export type EntityQuery = z.infer<typeof entityQuerySchema>;

/* ------------------------------------------------------- tool parameters -- */

export const calendarAddSchema = z.object({
  title: nonEmpty(200),
  start: localDateTimeSchema,
  end: localDateTimeSchema.optional(),
  duration_minutes: z.number().int().min(1).max(60 * 24).optional(),
  location: z.string().trim().max(300).optional(),
  description: z.string().trim().max(2000).optional(),
  all_day: z.boolean().optional(),
  kind: z.enum(['event', 'exam', 'class', 'reminder']).default('event'),
  /** Set when the model believes travel/prep time is warranted. */
  needs_buffer: z.boolean().optional(),
  buffer_minutes: z.number().int().min(0).max(240).optional(),
  reminder_minutes_before: z.number().int().min(0).max(60 * 24 * 7).optional(),
  project: z.string().trim().max(120).optional(),
  /** Audit trail: why the model picked this slot ("day before next Math class"). */
  schedule_reason: z.string().trim().max(300).optional(),
});

export const calendarUpdateSchema = z.object({
  target: entityQuerySchema,
  title: nonEmpty(200).optional(),
  start: localDateTimeSchema.optional(),
  end: localDateTimeSchema.optional(),
  duration_minutes: z.number().int().min(1).max(60 * 24).optional(),
  location: z.string().trim().max(300).optional(),
  description: z.string().trim().max(2000).optional(),
});

export const calendarDeleteSchema = z.object({
  target: entityQuerySchema,
  /** "cancelled" keeps a tombstone for the day; "delete" removes it entirely. */
  mode: z.enum(['delete', 'cancel']).default('delete'),
});

export const noteCreateSchema = z.object({
  title_summary: nonEmpty(160),
  category_tag: nonEmpty(60),
  bullets: z.array(nonEmpty(1000)).min(1).max(50),
  project: z.string().trim().max(120).optional(),
});

export const noteUpdateSchema = z.object({
  target: entityQuerySchema,
  append_bullets: z.array(nonEmpty(1000)).max(50).optional(),
  new_title_summary: nonEmpty(160).optional(),
  new_category_tag: nonEmpty(60).optional(),
});

export const noteDeleteSchema = z.object({
  target: entityQuerySchema,
});

export const habitLogSchema = z.object({
  habit_name: nonEmpty(80),
  duration_minutes: z.number().int().min(0).max(60 * 24).optional(),
  note: z.string().trim().max(500).optional(),
  /** Defaults to today; lets "I worked out yesterday" backfill a streak. */
  on_date: localDateSchema.optional(),
});

export const activityLogSchema = z.object({
  description: nonEmpty(1000),
  duration_minutes: z.number().int().min(0).max(60 * 24).optional(),
  habit_name: z.string().trim().max(80).optional(),
  project: z.string().trim().max(120).optional(),
  at: localDateTimeSchema.optional(),
});

export const timerStartSchema = z.object({
  label: nonEmpty(80),
  subject: z.string().trim().max(80).optional(),
  total_minutes: z.number().int().min(1).max(60 * 12).optional(),
  focus_minutes: z.number().int().min(1).max(60 * 6).default(25),
  break_minutes: z.number().int().min(0).max(120).default(5),
  long_break_minutes: z.number().int().min(0).max(120).optional(),
  cycles_before_long_break: z.number().int().min(1).max(12).optional(),
  project: z.string().trim().max(120).optional(),
});

export const timerControlSchema = z.object({
  action: z.enum(['pause', 'resume', 'stop', 'skip']),
});

export const ledgerAddSchema = z.object({
  amount: z.number().positive().max(1_000_000_000),
  currency: currencySchema.default('EUR'),
  category: nonEmpty(80),
  entity_name: z.string().trim().max(120).optional(),
  description: z.string().trim().max(500).optional(),
  direction: z.enum(['expense', 'income']).default('expense'),
  at: localDateTimeSchema.optional(),
  project: z.string().trim().max(120).optional(),
});

export const ledgerQuerySchema = z.object({
  category: z.string().trim().max(80).optional(),
  entity_name: z.string().trim().max(120).optional(),
  direction: z.enum(['expense', 'income', 'both']).default('expense'),
  period: z.enum(['today', 'week', 'month', 'year', 'all', 'custom']).default('month'),
  from: localDateSchema.optional(),
  to: localDateSchema.optional(),
  group_by: z.enum(['none', 'category', 'entity', 'day']).default('none'),
});

export const checklistAddSchema = z.object({
  list_name: nonEmpty(80),
  items: z
    .array(
      z.union([
        nonEmpty(200),
        z.object({ text: nonEmpty(200), quantity: z.string().trim().max(40).optional() }),
      ]),
    )
    .min(1)
    .max(60),
  project: z.string().trim().max(120).optional(),
});

export const checklistToggleSchema = z.object({
  list_name: z.string().trim().max(80).optional(),
  item_query: nonEmpty(200),
  completed: z.boolean().default(true),
});

export const geofenceAddSchema = z.object({
  label: nonEmpty(80).describe('Place name, e.g. "the lab"'),
  action_description: nonEmpty(300).describe('What to remind the user about'),
  trigger_type: z.enum(['ENTER', 'EXIT']),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  radius_meters: z.number().int().min(50).max(5000).default(150),
  one_shot: z.boolean().default(true),
  expires_in_days: z.number().int().min(1).max(365).optional(),
});

export const placeSaveSchema = z.object({
  label: nonEmpty(80),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radius_meters: z.number().int().min(50).max(5000).default(150),
  address: z.string().trim().max(300).optional(),
});

export const crmAddCommitmentSchema = z.object({
  entity_name: nonEmpty(120),
  commitment_text: nonEmpty(400),
  due: localDateTimeSchema.optional(),
  direction: z.enum(['i_owe', 'they_owe']).default('i_owe'),
  relationship_context: z.string().trim().max(200).optional(),
  /** Free-text summary of the interaction that produced this commitment. */
  interaction_summary: z.string().trim().max(1000).optional(),
  create_task: z.boolean().default(true),
});

export const crmLogInteractionSchema = z.object({
  entity_name: nonEmpty(120),
  summary: nonEmpty(1000),
  at: localDateTimeSchema.optional(),
  relationship_context: z.string().trim().max(200).optional(),
});

export const taskAddSchema = z.object({
  title: nonEmpty(200),
  due: localDateTimeSchema.optional(),
  notes: z.string().trim().max(2000).optional(),
  estimated_minutes: z.number().int().min(1).max(60 * 24).optional(),
  priority: z.number().int().min(1).max(3).default(2),
  project: z.string().trim().max(120).optional(),
  /** Titles of prerequisite tasks, created on demand if they do not exist. */
  depends_on: z.array(nonEmpty(200)).max(20).optional(),
});

export const taskAddDependencySchema = z.object({
  /** The blocked task. */
  child: nonEmpty(200),
  /** Prerequisites; created as unlocked tasks when unknown. */
  parents: z.array(nonEmpty(200)).min(1).max(20),
  child_due: localDateTimeSchema.optional(),
  project: z.string().trim().max(120).optional(),
});

export const taskCompleteSchema = z.object({
  target: entityQuerySchema,
  completed: z.boolean().default(true),
});

export const curriculumAddSchema = z.object({
  entries: z
    .array(
      z.object({
        subject_name: nonEmpty(80),
        day_of_week: dayOfWeekSchema,
        start_time: timeOfDaySchema,
        end_time: timeOfDaySchema,
        location: z.string().trim().max(200).optional(),
        teacher: z.string().trim().max(120).optional(),
        week_parity: z.enum(['every', 'odd', 'even']).default('every'),
      }),
    )
    .min(1)
    .max(40),
  replace_existing: z.boolean().default(false),
});

export const projectCreateSchema = z.object({
  name: nonEmpty(120),
  kind: z.enum(['project', 'event', 'trip', 'area', 'course']).default('project'),
  description: z.string().trim().max(1000).optional(),
  target_date: localDateSchema.optional(),
  start_date: localDateSchema.optional(),
  emoji: z.string().trim().max(8).optional(),
  sections: z.array(nonEmpty(80)).max(12).optional(),
});

export const projectAddItemSchema = z.object({
  project: nonEmpty(120).describe('Project name; created if it does not exist'),
  items: z
    .array(
      z.object({
        content: nonEmpty(500),
        kind: z.enum(['idea', 'todo', 'note', 'link', 'milestone', 'question']).default('idea'),
        detail: z.string().trim().max(2000).optional(),
        is_checkbox: z.boolean().optional(),
        section: z.string().trim().max(80).optional(),
        due: localDateSchema.optional(),
      }),
    )
    .min(1)
    .max(40),
  create_if_missing: z.boolean().default(true),
});

export const projectItemToggleSchema = z.object({
  project: z.string().trim().max(120).optional(),
  item_query: nonEmpty(300),
  completed: z.boolean().default(true),
});

export const briefingGenerateSchema = z.object({
  scope: z.enum(['today', 'tomorrow', 'week']).default('today'),
  speak: z.boolean().default(true),
});

export const summaryGenerateSchema = z.object({
  period: z.enum(['day', 'week', 'month', 'custom']).default('week'),
  from: localDateSchema.optional(),
  to: localDateSchema.optional(),
  format: z.enum(['markdown', 'spoken']).default('markdown'),
});

export const searchSchema = z.object({
  query: nonEmpty(300),
  scopes: z
    .array(z.enum(['notes', 'tasks', 'checklists', 'projects', 'crm', 'ledger', 'calendar']))
    .optional(),
});

/* ------------------------------------------------------------ the union --- */

/**
 * Discriminated on `tool_name`. The 15 names from the product spec are
 * preserved verbatim; the rest cover capabilities that would otherwise be
 * unreachable by voice.
 */
export const actionSchema = z.discriminatedUnion('tool_name', [
  z.object({ tool_name: z.literal('calendar_add'), parameters: calendarAddSchema }),
  z.object({ tool_name: z.literal('calendar_update'), parameters: calendarUpdateSchema }),
  z.object({ tool_name: z.literal('calendar_delete'), parameters: calendarDeleteSchema }),
  z.object({ tool_name: z.literal('note_create'), parameters: noteCreateSchema }),
  z.object({ tool_name: z.literal('note_update'), parameters: noteUpdateSchema }),
  z.object({ tool_name: z.literal('note_delete'), parameters: noteDeleteSchema }),
  z.object({ tool_name: z.literal('habit_log'), parameters: habitLogSchema }),
  z.object({ tool_name: z.literal('activity_log'), parameters: activityLogSchema }),
  z.object({ tool_name: z.literal('timer_start'), parameters: timerStartSchema }),
  z.object({ tool_name: z.literal('timer_control'), parameters: timerControlSchema }),
  z.object({ tool_name: z.literal('ledger_add'), parameters: ledgerAddSchema }),
  z.object({ tool_name: z.literal('ledger_query'), parameters: ledgerQuerySchema }),
  z.object({ tool_name: z.literal('checklist_add'), parameters: checklistAddSchema }),
  z.object({ tool_name: z.literal('checklist_toggle'), parameters: checklistToggleSchema }),
  z.object({ tool_name: z.literal('geofence_add'), parameters: geofenceAddSchema }),
  z.object({ tool_name: z.literal('place_save'), parameters: placeSaveSchema }),
  z.object({ tool_name: z.literal('crm_add_commitment'), parameters: crmAddCommitmentSchema }),
  z.object({ tool_name: z.literal('crm_log_interaction'), parameters: crmLogInteractionSchema }),
  z.object({ tool_name: z.literal('task_add'), parameters: taskAddSchema }),
  z.object({ tool_name: z.literal('task_add_dependency'), parameters: taskAddDependencySchema }),
  z.object({ tool_name: z.literal('task_complete'), parameters: taskCompleteSchema }),
  z.object({ tool_name: z.literal('curriculum_add'), parameters: curriculumAddSchema }),
  z.object({ tool_name: z.literal('project_create'), parameters: projectCreateSchema }),
  z.object({ tool_name: z.literal('project_add_item'), parameters: projectAddItemSchema }),
  z.object({ tool_name: z.literal('project_item_toggle'), parameters: projectItemToggleSchema }),
  z.object({ tool_name: z.literal('briefing_generate'), parameters: briefingGenerateSchema }),
  z.object({ tool_name: z.literal('summary_generate'), parameters: summaryGenerateSchema }),
  z.object({ tool_name: z.literal('search'), parameters: searchSchema }),
]);

export const llmResponseSchema = z.object({
  conversational_feedback: z.string().trim().max(600).optional(),
  requires_user_input: z.boolean().optional().default(false),
  /** Present when `requires_user_input`; carries the question to speak back. */
  clarification: z
    .object({
      question: nonEmpty(400),
      /** Opaque state echoed back on the follow-up turn. */
      pending: z.string().max(4000).optional(),
    })
    .optional(),
  actions: z.array(actionSchema).max(25).default([]),
});

export type LlmAction = z.infer<typeof actionSchema>;
export type LlmResponse = z.infer<typeof llmResponseSchema>;
export type ToolName = LlmAction['tool_name'];

export type ActionParams<T extends ToolName> = Extract<LlmAction, { tool_name: T }>['parameters'];

export const TOOL_NAMES = [
  'calendar_add',
  'calendar_update',
  'calendar_delete',
  'note_create',
  'note_update',
  'note_delete',
  'habit_log',
  'activity_log',
  'timer_start',
  'timer_control',
  'ledger_add',
  'ledger_query',
  'checklist_add',
  'checklist_toggle',
  'geofence_add',
  'place_save',
  'crm_add_commitment',
  'crm_log_interaction',
  'task_add',
  'task_add_dependency',
  'task_complete',
  'curriculum_add',
  'project_create',
  'project_add_item',
  'project_item_toggle',
  'briefing_generate',
  'summary_generate',
  'search',
] as const satisfies readonly ToolName[];

/* ------------------------------------------------------------- validation - */

export type ParseOk = { ok: true; value: LlmResponse };
export type ParseErr = { ok: false; issues: string[]; raw: unknown };
export type ParseResult = ParseOk | ParseErr;

/**
 * Validates a model response. Errors come back as short, model-readable
 * sentences so the retry prompt can tell the model exactly what to fix.
 */
export function parseLlmResponse(raw: unknown): ParseResult {
  const result = llmResponseSchema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  const issues = result.error.issues.map((i) => {
    const path = i.path.length ? i.path.join('.') : '(root)';
    return `${path}: ${i.message}`;
  });
  return { ok: false, issues, raw };
}

/**
 * Pulls a JSON object out of a model reply that may be wrapped in prose or a
 * ```json fence. Returns null when nothing parseable is present.
 */
export function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidates = [fenced?.[1], trimmed].filter((c): c is string => Boolean(c));

  for (const candidate of candidates) {
    const direct = tryParse(candidate);
    if (direct !== undefined) return direct;
    const sliced = sliceBalanced(candidate);
    if (sliced) {
      const parsed = tryParse(sliced);
      if (parsed !== undefined) return parsed;
    }
  }
  return null;
}

function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Finds the first balanced {...} block, ignoring braces inside strings. */
function sliceBalanced(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
