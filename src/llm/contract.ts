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
 *  - Parameter objects are **strict** and cross-field sanity is checked here
 *    rather than downstream. See the two sections at the bottom of this header.
 *
 * Why strict parameters. Zod's default is to strip an undeclared key, which
 * makes a misunderstanding look like a success: a model that puts `end_time` on
 * `calendar_add` (the field belongs to `curriculum_add`) gets a one-hour default
 * event and a cheerful confirmation. The dangerous unknown key is never
 * `sql: "DROP TABLE"` — that one is inert once stripped — it is the plausible
 * one whose loss silently changes what gets written. The cost is real and was
 * weighed: a model that adds one harmless field now fails a turn it could have
 * completed. It costs one repair round trip, the validator names the exact key,
 * and under provider-side structured output the case cannot arise at all.
 *
 * Why the sanity rules stop where they do. A rule earns its place only when the
 * user's intent is *unrecoverable* from what the model sent — "which of these
 * two times is wrong?" — never when we could infer it. An all-day event whose
 * start carries 15:00 is obvious (the day is what was meant) and is left alone;
 * an event ending before it starts is not, and is rejected so the repair loop
 * can ask. Everything here is a rejection with a sentence attached, never a
 * silent clamp: clamping is how a confused model's mistake becomes ours.
 */
import { z } from 'zod';
import { localToEpoch, LOCAL_DATETIME_RE, LOCAL_DATE_RE, TIME_OF_DAY_RE } from '@/core/time';

/* ------------------------------------------------------------ primitives -- */

const nonEmpty = (max = 500) => z.string().trim().min(1).max(max);

/**
 * The window a personal-organiser date can plausibly fall in.
 *
 * Wide on purpose: the point is to catch a model that has lost the plot — an
 * epoch-zero 1970, a hallucinated 2140 — not to second-guess a user planning a
 * wedding or backfilling last year's expenses. The contract has no clock of its
 * own (it is parsed in tests, in the offline engine and on a replayed pending
 * action alike), so the bound is absolute rather than relative to "now".
 */
export const MIN_PLAUSIBLE_YEAR = 2000;
export const MAX_PLAUSIBLE_YEAR = 2100;

/** Digit-shaped is not the same as real: "2026-02-30" and "2026-13-01" match the regex. */
function isRealDay(value: string): boolean {
  const day = value.slice(0, 10);
  // A malformed string has already been reported by the regex; one complaint
  // per field repairs far better than three.
  if (!LOCAL_DATE_RE.test(day)) return true;
  try {
    // Whether a day exists has the same answer in every zone, so UTC keeps this
    // deterministic and never drags DST into a question that does not need it.
    localToEpoch(day, 'UTC');
    return true;
  } catch {
    return false;
  }
}

function withinPlausibleYears(value: string): boolean {
  const year = Number(value.slice(0, 4));
  if (!Number.isFinite(year)) return true;
  return year >= MIN_PLAUSIBLE_YEAR && year <= MAX_PLAUSIBLE_YEAR;
}

const REAL_DAY_MESSAGE = 'That calendar day does not exist';
const PLAUSIBLE_YEAR_MESSAGE = `The year must be between ${MIN_PLAUSIBLE_YEAR} and ${MAX_PLAUSIBLE_YEAR} — resolve the date against the current date you were given`;

export const localDateTimeSchema = z
  .string()
  .regex(LOCAL_DATETIME_RE, 'Expected YYYY-MM-DDTHH:mm (local wall clock, no timezone offset)')
  .refine(isRealDay, REAL_DAY_MESSAGE)
  .refine(withinPlausibleYears, PLAUSIBLE_YEAR_MESSAGE);

export const localDateSchema = z
  .string()
  .regex(LOCAL_DATE_RE, 'Expected YYYY-MM-DD')
  .refine(isRealDay, REAL_DAY_MESSAGE)
  .refine(withinPlausibleYears, PLAUSIBLE_YEAR_MESSAGE);

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

/* --------------------------------------------------------- sanity helpers -- */

/** Just enough of a `ctx` to raise one issue; keeps the helpers free of zod internals. */
type Ctx = {
  addIssue: (issue: { code: 'custom'; message: string; path: (string | number)[] }) => void;
};

function reject(ctx: Ctx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: 'custom', message, path });
}

/**
 * Two wall-clock strings compare correctly as text once padded, because the
 * format is fixed-width and zero-filled. Ordering is also the one question a
 * zone cannot change, which is why this needs neither a zone nor Luxon.
 */
function wallClockKey(value: string): string {
  const [date = '', time = '00:00'] = value.replace(' ', 'T').split('T');
  return `${date}T${time.length === 5 ? `${time}:00` : time}`;
}

function endsBeforeStart(start: string, end: string): boolean {
  return wallClockKey(end) <= wallClockKey(start);
}

const ORDER_MESSAGE = 'Must be after the start time; swap them or fix whichever one is wrong';

/** `2026-08-14T09:00` and `2026-08-15` disagree about which day is meant. */
function dayOf(value: string): string {
  return value.slice(0, 10);
}

/** How the model points at something that already exists. */
export const entityQuerySchema = z
  .strictObject({
    query: nonEmpty(200).describe('Words the user used, e.g. "math homework"'),
    on_date: localDateSchema.optional().describe('Narrows the search to one day'),
    near_time: localDateTimeSchema.optional(),
  })
  .superRefine((value, ctx) => {
    // Two hints that disagree cannot both narrow the search, and picking one is
    // exactly the guess `resolveOne` exists to refuse.
    if (value.on_date && value.near_time && dayOf(value.near_time) !== value.on_date) {
      reject(ctx, ['near_time'], `Falls on a different day from on_date (${value.on_date})`);
    }
  });
export type EntityQuery = z.infer<typeof entityQuerySchema>;

/* ------------------------------------------------------- tool parameters -- */

export const calendarAddSchema = z
  .strictObject({
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
  })
  .superRefine((value, ctx) => {
    // An all-day event's own times are replaced by the day's bounds, so there is
    // nothing here for a contradiction to corrupt.
    if (value.all_day === true) return;
    if (value.end !== undefined && endsBeforeStart(value.start, value.end)) {
      reject(ctx, ['end'], ORDER_MESSAGE);
    }
  });

export const calendarUpdateSchema = z
  .strictObject({
    target: entityQuerySchema,
    title: nonEmpty(200).optional(),
    start: localDateTimeSchema.optional(),
    end: localDateTimeSchema.optional(),
    duration_minutes: z.number().int().min(1).max(60 * 24).optional(),
    location: z.string().trim().max(300).optional(),
    description: z.string().trim().max(2000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.start !== undefined && value.end !== undefined && endsBeforeStart(value.start, value.end)) {
      reject(ctx, ['end'], ORDER_MESSAGE);
    }
    // An update with nothing to update still reports "Moved …" to the user,
    // which is a lie about their data rather than a harmless no-op.
    const changes = [
      value.title,
      value.start,
      value.end,
      value.duration_minutes,
      value.location,
      value.description,
    ];
    if (changes.every((field) => field === undefined)) {
      reject(ctx, ['target'], 'Nothing to change: send at least one field besides target');
    }
  });

export const calendarDeleteSchema = z.strictObject({
  target: entityQuerySchema,
  /** "cancelled" keeps a tombstone for the day; "delete" removes it entirely. */
  mode: z.enum(['delete', 'cancel']).default('delete'),
});

export const noteCreateSchema = z.strictObject({
  title_summary: nonEmpty(160),
  category_tag: nonEmpty(60),
  bullets: z.array(nonEmpty(1000)).min(1).max(50),
  project: z.string().trim().max(120).optional(),
});

export const noteUpdateSchema = z
  .strictObject({
    target: entityQuerySchema,
    append_bullets: z.array(nonEmpty(1000)).max(50).optional(),
    new_title_summary: nonEmpty(160).optional(),
    new_category_tag: nonEmpty(60).optional(),
  })
  .superRefine((value, ctx) => {
    const appends = value.append_bullets ?? [];
    if (
      appends.length === 0 &&
      value.new_title_summary === undefined &&
      value.new_category_tag === undefined
    ) {
      reject(ctx, ['target'], 'Nothing to change: send bullets to append or a new title or tag');
    }
  });

export const noteDeleteSchema = z.strictObject({
  target: entityQuerySchema,
});

export const habitLogSchema = z.strictObject({
  habit_name: nonEmpty(80),
  duration_minutes: z.number().int().min(0).max(60 * 24).optional(),
  note: z.string().trim().max(500).optional(),
  /** Defaults to today; lets "I worked out yesterday" backfill a streak. */
  on_date: localDateSchema.optional(),
});

export const activityLogSchema = z.strictObject({
  description: nonEmpty(1000),
  duration_minutes: z.number().int().min(0).max(60 * 24).optional(),
  habit_name: z.string().trim().max(80).optional(),
  project: z.string().trim().max(120).optional(),
  at: localDateTimeSchema.optional(),
});

export const timerStartSchema = z.strictObject({
  label: nonEmpty(80),
  subject: z.string().trim().max(80).optional(),
  total_minutes: z.number().int().min(1).max(60 * 12).optional(),
  focus_minutes: z.number().int().min(1).max(60 * 6).default(25),
  break_minutes: z.number().int().min(0).max(120).default(5),
  long_break_minutes: z.number().int().min(0).max(120).optional(),
  cycles_before_long_break: z.number().int().min(1).max(12).optional(),
  project: z.string().trim().max(120).optional(),
});

export const timerControlSchema = z.strictObject({
  action: z.enum(['pause', 'resume', 'stop', 'skip']),
});

export const ledgerAddSchema = z.strictObject({
  amount: z.number().positive().max(1_000_000_000),
  currency: currencySchema.default('EUR'),
  category: nonEmpty(80),
  entity_name: z.string().trim().max(120).optional(),
  description: z.string().trim().max(500).optional(),
  direction: z.enum(['expense', 'income']).default('expense'),
  at: localDateTimeSchema.optional(),
  project: z.string().trim().max(120).optional(),
});

/**
 * `from`/`to` order is checked, not silently swapped: a range the wrong way
 * round answers "nothing found" with total confidence, and which end is wrong
 * is not ours to decide.
 */
const dateRangeRules = (value: { period: string; from?: string; to?: string }, ctx: Ctx): void => {
  if (value.from && value.to && value.to < value.from) {
    reject(ctx, ['to'], 'Must not be earlier than from');
  }
  if (value.period === 'custom' && (!value.from || !value.to)) {
    reject(ctx, ['period'], 'A custom period needs both from and to; otherwise name a period');
  }
};

export const ledgerQuerySchema = z
  .strictObject({
    category: z.string().trim().max(80).optional(),
    entity_name: z.string().trim().max(120).optional(),
    direction: z.enum(['expense', 'income', 'both']).default('expense'),
    period: z.enum(['today', 'week', 'month', 'year', 'all', 'custom']).default('month'),
    from: localDateSchema.optional(),
    to: localDateSchema.optional(),
    group_by: z.enum(['none', 'category', 'entity', 'day']).default('none'),
  })
  .superRefine(dateRangeRules);

export const checklistAddSchema = z.strictObject({
  list_name: nonEmpty(80),
  items: z
    .array(
      z.union(
        [
          nonEmpty(200),
          z.strictObject({ text: nonEmpty(200), quantity: z.string().trim().max(40).optional() }),
        ],
        // A failed union reports "Invalid input" and nothing else, which is the
        // one kind of complaint the repair loop cannot act on. Spell out the two
        // shapes instead.
        { error: 'Each item is either a plain string or an object with text and optional quantity' },
      ),
    )
    .min(1)
    .max(60),
  project: z.string().trim().max(120).optional(),
});

export const checklistToggleSchema = z.strictObject({
  list_name: z.string().trim().max(80).optional(),
  item_query: nonEmpty(200),
  completed: z.boolean().default(true),
});

export const geofenceAddSchema = z
  .strictObject({
    label: nonEmpty(80).describe('Place name, e.g. "the lab"'),
    action_description: nonEmpty(300).describe('What to remind the user about'),
    trigger_type: z.enum(['ENTER', 'EXIT']),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    radius_meters: z.number().int().min(50).max(5000).default(150),
    one_shot: z.boolean().default(true),
    expires_in_days: z.number().int().min(1).max(365).optional(),
  })
  .superRefine((value, ctx) => {
    // Half a coordinate points at nowhere. Saying so beats asking the user to
    // pin a place they already described well enough to have a latitude for.
    if ((value.latitude === undefined) !== (value.longitude === undefined)) {
      reject(ctx, ['longitude'], 'Latitude and longitude must be sent together or not at all');
    }
  });

export const placeSaveSchema = z.strictObject({
  label: nonEmpty(80),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radius_meters: z.number().int().min(50).max(5000).default(150),
  address: z.string().trim().max(300).optional(),
});

export const crmAddCommitmentSchema = z.strictObject({
  entity_name: nonEmpty(120),
  commitment_text: nonEmpty(400),
  due: localDateTimeSchema.optional(),
  direction: z.enum(['i_owe', 'they_owe']).default('i_owe'),
  relationship_context: z.string().trim().max(200).optional(),
  /** Free-text summary of the interaction that produced this commitment. */
  interaction_summary: z.string().trim().max(1000).optional(),
  create_task: z.boolean().default(true),
});

export const crmLogInteractionSchema = z.strictObject({
  entity_name: nonEmpty(120),
  summary: nonEmpty(1000),
  at: localDateTimeSchema.optional(),
  relationship_context: z.string().trim().max(200).optional(),
});

/** A task that is its own prerequisite can never unlock. Same word, same task. */
function sameTitle(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export const taskAddSchema = z
  .strictObject({
    title: nonEmpty(200),
    due: localDateTimeSchema.optional(),
    notes: z.string().trim().max(2000).optional(),
    estimated_minutes: z.number().int().min(1).max(60 * 24).optional(),
    priority: z.number().int().min(1).max(3).default(2),
    project: z.string().trim().max(120).optional(),
    /** Titles of prerequisite tasks, created on demand if they do not exist. */
    depends_on: z.array(nonEmpty(200)).max(20).optional(),
  })
  .superRefine((value, ctx) => {
    const self = (value.depends_on ?? []).findIndex((parent) => sameTitle(parent, value.title));
    if (self !== -1) {
      reject(ctx, ['depends_on', self], 'A task cannot be its own prerequisite');
    }
  });

export const taskAddDependencySchema = z
  .strictObject({
    /** The blocked task. */
    child: nonEmpty(200),
    /** Prerequisites; created as unlocked tasks when unknown. */
    parents: z.array(nonEmpty(200)).min(1).max(20),
    child_due: localDateTimeSchema.optional(),
    project: z.string().trim().max(120).optional(),
  })
  .superRefine((value, ctx) => {
    const self = value.parents.findIndex((parent) => sameTitle(parent, value.child));
    if (self !== -1) {
      reject(ctx, ['parents', self], 'A task cannot be its own prerequisite');
    }
  });

export const taskCompleteSchema = z.strictObject({
  target: entityQuerySchema,
  completed: z.boolean().default(true),
});

export const curriculumAddSchema = z.strictObject({
  entries: z
    .array(
      z
        .strictObject({
          subject_name: nonEmpty(80),
          day_of_week: dayOfWeekSchema,
          start_time: timeOfDaySchema,
          end_time: timeOfDaySchema,
          location: z.string().trim().max(200).optional(),
          teacher: z.string().trim().max(120).optional(),
          week_parity: z.enum(['every', 'odd', 'even']).default('every'),
        })
        .superRefine((entry, ctx) => {
          // A timetable row is the one place a wrong length is invisible: it
          // repeats every week and nobody re-reads it.
          if (entry.end_time <= entry.start_time) {
            reject(ctx, ['end_time'], ORDER_MESSAGE);
          }
        }),
    )
    .min(1)
    .max(40),
  replace_existing: z.boolean().default(false),
});

export const projectCreateSchema = z
  .strictObject({
    name: nonEmpty(120),
    kind: z.enum(['project', 'event', 'trip', 'area', 'course']).default('project'),
    description: z.string().trim().max(1000).optional(),
    target_date: localDateSchema.optional(),
    start_date: localDateSchema.optional(),
    emoji: z.string().trim().max(8).optional(),
    sections: z.array(nonEmpty(80)).max(12).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.start_date && value.target_date && value.target_date < value.start_date) {
      reject(ctx, ['target_date'], 'Must not be earlier than start_date');
    }
  });

export const projectAddItemSchema = z.strictObject({
  project: nonEmpty(120).describe('Project name; created if it does not exist'),
  items: z
    .array(
      z.strictObject({
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

export const projectItemToggleSchema = z.strictObject({
  project: z.string().trim().max(120).optional(),
  item_query: nonEmpty(300),
  completed: z.boolean().default(true),
});

export const briefingGenerateSchema = z.strictObject({
  scope: z.enum(['today', 'tomorrow', 'week']).default('today'),
  speak: z.boolean().default(true),
});

export const summaryGenerateSchema = z
  .strictObject({
    period: z.enum(['day', 'week', 'month', 'custom']).default('week'),
    from: localDateSchema.optional(),
    to: localDateSchema.optional(),
    format: z.enum(['markdown', 'spoken']).default('markdown'),
  })
  .superRefine(dateRangeRules);

export const searchSchema = z.strictObject({
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
  z.strictObject({ tool_name: z.literal('calendar_add'), parameters: calendarAddSchema }),
  z.strictObject({ tool_name: z.literal('calendar_update'), parameters: calendarUpdateSchema }),
  z.strictObject({ tool_name: z.literal('calendar_delete'), parameters: calendarDeleteSchema }),
  z.strictObject({ tool_name: z.literal('note_create'), parameters: noteCreateSchema }),
  z.strictObject({ tool_name: z.literal('note_update'), parameters: noteUpdateSchema }),
  z.strictObject({ tool_name: z.literal('note_delete'), parameters: noteDeleteSchema }),
  z.strictObject({ tool_name: z.literal('habit_log'), parameters: habitLogSchema }),
  z.strictObject({ tool_name: z.literal('activity_log'), parameters: activityLogSchema }),
  z.strictObject({ tool_name: z.literal('timer_start'), parameters: timerStartSchema }),
  z.strictObject({ tool_name: z.literal('timer_control'), parameters: timerControlSchema }),
  z.strictObject({ tool_name: z.literal('ledger_add'), parameters: ledgerAddSchema }),
  z.strictObject({ tool_name: z.literal('ledger_query'), parameters: ledgerQuerySchema }),
  z.strictObject({ tool_name: z.literal('checklist_add'), parameters: checklistAddSchema }),
  z.strictObject({ tool_name: z.literal('checklist_toggle'), parameters: checklistToggleSchema }),
  z.strictObject({ tool_name: z.literal('geofence_add'), parameters: geofenceAddSchema }),
  z.strictObject({ tool_name: z.literal('place_save'), parameters: placeSaveSchema }),
  z.strictObject({ tool_name: z.literal('crm_add_commitment'), parameters: crmAddCommitmentSchema }),
  z.strictObject({ tool_name: z.literal('crm_log_interaction'), parameters: crmLogInteractionSchema }),
  z.strictObject({ tool_name: z.literal('task_add'), parameters: taskAddSchema }),
  z.strictObject({ tool_name: z.literal('task_add_dependency'), parameters: taskAddDependencySchema }),
  z.strictObject({ tool_name: z.literal('task_complete'), parameters: taskCompleteSchema }),
  z.strictObject({ tool_name: z.literal('curriculum_add'), parameters: curriculumAddSchema }),
  z.strictObject({ tool_name: z.literal('project_create'), parameters: projectCreateSchema }),
  z.strictObject({ tool_name: z.literal('project_add_item'), parameters: projectAddItemSchema }),
  z.strictObject({ tool_name: z.literal('project_item_toggle'), parameters: projectItemToggleSchema }),
  z.strictObject({ tool_name: z.literal('briefing_generate'), parameters: briefingGenerateSchema }),
  z.strictObject({ tool_name: z.literal('summary_generate'), parameters: summaryGenerateSchema }),
  z.strictObject({ tool_name: z.literal('search'), parameters: searchSchema }),
]);

/**
 * How many times the same action may appear in one turn before it stops looking
 * like intent and starts looking like a decoding loop.
 *
 * Two is deliberate, not timid: "two coffees at three euros each" is a real
 * utterance that produces two identical `ledger_add`s, and failing it to catch
 * a rarer fault would be trading a certainty for a maybe. Three is where the
 * repetition stops explaining itself.
 */
export const MAX_IDENTICAL_ACTIONS = 2;

/**
 * Same tool, same parameters. Keys are sorted first so the comparison does not
 * quietly depend on whatever order the parser happens to rebuild an object in.
 */
function actionFingerprint(action: LlmAction): string {
  return JSON.stringify([action.tool_name, sortedKeys(action.parameters)]);
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, sortedKeys(entry)]),
  );
}

/**
 * The envelope stays open where the parameters are strict. A stray
 * `"reasoning"` beside `actions` is the model talking to itself and losing it
 * costs the user nothing; a stray key *inside* an action is a claim about their
 * data that we would be dropping on the floor.
 */
export const llmResponseSchema = z
  .object({
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
  })
  // One utterance, the same write over and over: nothing downstream would
  // question it, because every one of them is valid on its own.
  .superRefine((value, ctx) => {
    const seen = new Map<string, number>();
    value.actions.forEach((action, index) => {
      const key = actionFingerprint(action);
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      if (count === MAX_IDENTICAL_ACTIONS + 1) {
        reject(
          ctx,
          ['actions', index],
          `Repeated ${action.tool_name} ${count} times with identical parameters — send it once`,
        );
      }
    });
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
