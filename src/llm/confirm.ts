/**
 * Showing the user what is about to be written, before it is.
 *
 * Speaking is fast because you do not have to look, and that is exactly why a
 * mis-heard word is dangerous here: "meeting with James" and "meeting with
 * Jason" are one phoneme apart and the wrong one lands silently. `LastAction`
 * closes that loop *after* the fact, and for a task or an event that is
 * enough — the receipt carries an undo and the row goes away again.
 *
 * For everything else it is not enough, and `src/features/home/undo.ts` is
 * where that becomes obvious. Read its refusals: `habit_log` reports the
 * habit rather than the log entry, so undoing it would take the streak and
 * every past entry with it; `note_create` upserts, so undoing "add three lines
 * to Shopping" would throw away everything already on the list; every update
 * needs prior values nothing keeps; every delete needs the row back and only
 * the calendar keeps a tombstone.
 *
 * So the rule here is not "confirm every write" — that would put a dialog in
 * front of the fastest thing about the app, and a prompt shown every time is a
 * prompt nobody reads. It is **confirm what undo cannot take back**. The two
 * lists are mostly complements by construction: if the receipt can offer you an
 * undo, you get the speed; if it cannot, you get the question. Neither list is
 * allowed to be a judgement call, which is why both are spelled out.
 *
 * Two things sit on top of that rule, and both exist because tool identity is
 * not the only thing that decides how likely this row is to be wrong:
 *
 *  - **How well the words were heard.** The recogniser reports a confidence per
 *    utterance and it was, until this gate learned to read it, measured, stored
 *    in `llm_interactions` and acted on by nothing. A barely-understood
 *    sentence executed exactly like a crisp one. `REVIEW_CONFIDENCE_THRESHOLD`
 *    below is the second dimension: an undoable write still lands silently when
 *    the engine was sure, and asks first when it was not.
 *  - **What a wrong value costs even when it *can* be undone.** `ALWAYS_ASKS`
 *    is that exception, and money is currently its only member.
 */
import type { LlmAction, ToolName } from './contract';

/** How much the assistant asks before it writes. */
export type ConfirmMode =
  /** Everything lands immediately. The receipt is the only safety net. */
  | 'never'
  /** Only what `undo.ts` cannot reverse. The default. */
  | 'irreversible'
  /** Every write, including the ones a tap could undo. */
  | 'always';

export const DEFAULT_CONFIRM_MODE: ConfirmMode = 'irreversible';

/**
 * Tools that change stored data.
 *
 * Spelled out rather than inferred from the name. `ledger_query` and
 * `checklist_toggle` both end in a verb that sounds like a write and only one
 * of them is; `briefing_generate` and `summary_generate` create text and store
 * nothing. Guessing from the string is how a write ends up unguarded.
 */
const WRITES: ReadonlySet<ToolName> = new Set<ToolName>([
  'calendar_add',
  'calendar_update',
  'calendar_delete',
  'note_create',
  'note_update',
  'note_delete',
  'habit_log',
  'activity_log',
  'task_add',
  'task_complete',
  'task_add_dependency',
  'ledger_add',
  'checklist_add',
  'checklist_toggle',
  'crm_add_commitment',
  'crm_log_interaction',
  'curriculum_add',
  'geofence_add',
  'place_save',
  'project_create',
  'project_add_item',
  'project_item_toggle',
  'timer_start',
  'timer_control',
]);

/**
 * The writes the receipt can undo, mirroring `UNDOABLE` in
 * `src/features/home/undo.ts`.
 *
 * Duplicated deliberately and narrowly: that module imports React state types
 * and this one must stay loadable under plain Node so the rule can be tested
 * without a renderer. `confirm.test.ts` asserts the two lists agree, so the
 * copy cannot drift into disagreeing about which mistakes are recoverable.
 */
const REVERSIBLE: ReadonlySet<ToolName> = new Set<ToolName>([
  'task_add',
  'calendar_add',
  'activity_log',
  'ledger_add',
]);

/**
 * The writes that ask however well they were heard and however easily the
 * receipt could take them back.
 *
 * `ledger_add` is the only member, and it is here rather than struck off
 * `REVERSIBLE` on purpose. Striking it off was the other option and it is the
 * worse one: `undo.ts` would have to lose it too, or `confirm.test.ts` fails on
 * the two lists disagreeing — and the two lists disagreeing is exactly the bug
 * that pair exists to make impossible. That would trade a safety net for a
 * safety net. Keeping it on both gives it two: a question before, and an undo
 * on the receipt after.
 *
 * Money earns the double cover because it is the one domain where a wrong
 * value is *unnoticed* rather than visible. A mis-heard event title is read
 * back off the agenda the next time you look at the day; a mis-heard 15 that
 * should have been 50 looks exactly like a real transaction for ever, and
 * "fifty" and "fifteen" are one phoneme apart in the position where recognisers
 * are least reliable. Undo only helps someone who notices, and the question is
 * the thing that makes them notice. It is also cheap: nobody logs forty
 * expenses in a sitting, so the interruption is rare in a way a question on
 * `task_add` would not be.
 *
 * `never` still means never — see the note there. This raises the floor inside
 * a policy the user chose, it does not overrule the policy.
 */
const ALWAYS_ASKS: ReadonlySet<ToolName> = new Set<ToolName>(['ledger_add']);

/**
 * Below this, a write is shown before it lands even when undo could take it
 * back.
 *
 * **Deliberately not `settings.voiceConfidenceThreshold`**, which is a
 * different question with a different consequence. That one (0.7 by default,
 * `DEFAULT_MIN_CONFIDENCE` in `@/voice/types`) is *should I even try* — below
 * it `evaluateTranscript` rejects the utterance outright and the user is asked
 * to say it again. This one is *should I check first* — above it the sentence
 * was legible enough to interpret, and the only question left is whether to
 * write it without looking.
 *
 * Which is why reusing that setting would not have worked, and why a *lower*
 * constant would not either: every voice turn reaching this gate has already
 * cleared the hearing floor, so a review threshold at or below it can never
 * fire and would be dead code that reads like a safety feature. It has to sit
 * above. 0.85 leaves a real 0.70–0.85 band — heard well enough to parse, not
 * well enough to bet a row on — and still lets a clean capture through
 * untouched, which is the whole point of a voice-first app.
 *
 * It is a constant and not a setting for the reason on the Settings screen: a
 * stranger setting this to its worst value (1) would put a question in front of
 * every single write, and to its other worst value (0) would silently remove
 * the guard entirely. Neither is a dial worth shipping. The *hearing* floor is
 * already exposed on the developer screen, and lowering it there widens this
 * band rather than escaping it.
 */
export const REVIEW_CONFIDENCE_THRESHOLD = 0.85;

/**
 * Which question a "yes" answered.
 *
 * Two questions reach the user through the same yes/no envelope and they are
 * not the same question, which cost a double-booking before it was written
 * down:
 *
 *  - `review` — "is this what you said?", asked by the gate in `executor.ts`
 *    before anything runs. It shows the *fields* and knows nothing about the
 *    data they will land in.
 *  - `details` — "is this what you meant?", asked by a handler that has already
 *    looked: a clash with an existing event, an overwrite, a delete.
 *
 * A yes to the first cannot stand in for the second, because the first was
 * asked before anybody had looked. A yes to the second *can* stand in for the
 * first: the handler question is downstream of the gate, so reaching it at all
 * means the gate was already released. So the ordering is one-way, and the two
 * flags on `ExecuteOptions` say which grant is in hand rather than one boolean
 * standing for both.
 */
export type ConfirmScope = 'review' | 'details';

/** Whether this tool writes at all. Queries never ask. */
export function isWrite(tool: ToolName): boolean {
  return WRITES.has(tool);
}

/** Whether a mistake here can be taken back from the receipt. */
export function isReversible(tool: ToolName): boolean {
  return REVERSIBLE.has(tool);
}

/**
 * Whether a wrong value here is the kind nobody notices, so its question leads.
 *
 * The dock has room for exactly one question, and when an utterance blocks more
 * than one action the others are folded into a count. Which one gets to be the
 * question therefore decides what the user actually reads before saying yes —
 * and "add milk to the shopping list and log fifty on groceries" blocks two,
 * with the money second. Read as source order, the sentence spoken is about
 * milk and the amount never appears, which is the one thing `ALWAYS_ASKS`
 * exists to make impossible.
 */
export function alwaysAsks(tool: ToolName): boolean {
  return ALWAYS_ASKS.has(tool);
}

/**
 * Whether the recogniser told us it struggled with this utterance.
 *
 * Three-valued on purpose, and the middle value is the interesting one. `null`
 * — typed text, Whisper, and most Android engines, which report nothing at all
 * — is **not** low and **not** high: it is *no evidence*, and this returns
 * false so the decision falls back to the tool-identity rule alone.
 *
 * Reading null as low would ask about every typed turn, which is the one input
 * path with no mis-hearing to protect against; the user looked at the words as
 * they wrote them. Reading it as high would be the worse mistake — but note
 * that it is not what "false" means here. False does not release anything: it
 * declines to *add* a question, and everything the gate asked before still
 * asks. That is what makes null safe to treat as no evidence, and it is why
 * `ledger_add` is on `ALWAYS_ASKS` rather than relying on a number that the
 * whole Android fleet reports as nothing.
 *
 * A non-positive or non-finite value is the same "no evidence": Android returns
 * 0 or -1 for "unavailable" and iOS returns 0 on partials, and `stt.ts` and
 * `vad.ts` both already read those as unknown. Treating a 0 as "0 < 0.85, so
 * ask" would put a question in front of every write on those devices.
 */
export function wasPoorlyHeard(confidence: number | null | undefined): boolean {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return false;
  if (confidence <= 0) return false;
  return confidence < REVIEW_CONFIDENCE_THRESHOLD;
}

/**
 * Whether this action should be shown to the user before it runs.
 *
 * `timer_start` and `timer_control` are writes and are not on the undoable
 * list, and they are still not worth a question: the mistake is visible the
 * instant it happens, on the screen you are already looking at, and costs one
 * tap. A confirmation there would be the app asking permission to do the thing
 * you just asked it to do. That argument does not weaken when the words were
 * heard badly — a mis-heard timer is wrong in front of you either way — so this
 * list sits above the confidence check rather than under it.
 */
const NEVER_ASKS: ReadonlySet<ToolName> = new Set<ToolName>(['timer_start', 'timer_control']);

/**
 * @param confidence How well the recogniser heard the utterance these actions
 *   came from, on 0..1. `null`/omitted when nothing measured it — see
 *   `wasPoorlyHeard`, which is where that case is decided.
 */
export function needsConfirmation(
  tool: ToolName,
  mode: ConfirmMode,
  confidence?: number | null,
): boolean {
  // `never` is a policy the user chose, and it is the one answer nothing below
  // may raise: a user who turned the gate off and then met a question anyway
  // would reasonably conclude the setting is broken.
  if (mode === 'never') return false;
  // A mis-heard query reads a row and writes none: it costs a wrong answer the
  // user can see, not a wrong row they cannot. Low confidence does not change
  // that, so this stays above the confidence check too.
  if (!isWrite(tool)) return false;
  if (NEVER_ASKS.has(tool)) return false;
  if (mode === 'always') return true;
  if (ALWAYS_ASKS.has(tool)) return true;
  if (wasPoorlyHeard(confidence)) return true;
  return !isReversible(tool);
}

/* ------------------------------------------------------------- describing -- */

/**
 * What the user is being asked to approve, in their words.
 *
 * A confirmation is only worth interrupting for if it is *checkable at a
 * glance*, which rules out both extremes: a raw parameter dump ("title:
 * Meeting with Jason, start: 1755792000000") cannot be read, and a summary
 * that says "Add an event?" does not contain the word that might be wrong.
 * What has to survive into this string is every value the recogniser could
 * have got wrong — the name, the time, the amount.
 */
export type ActionPreview = {
  /** "Add to calendar", "Log a habit" — what kind of change this is. */
  title: string;
  /** The values worth checking, in reading order. */
  lines: string[];
};

/**
 * The preview as one spoken sentence.
 *
 * The card is the good surface, but the assistant is answered by voice and by
 * a sheet that may be shut, so the question has to stand on its own. "Save a
 * note?" does not: it names the *kind* of change and none of its content, and
 * a yes/no with nothing in it to check gets a yes every time — which would
 * make the whole gate an extra tap that protects nothing.
 *
 * So the values come with it, capped at the two that matter most. Past two the
 * sentence stops being something you can hold in your head while it is read
 * aloud, and the card is there for the rest.
 */
export function previewSentence(preview: ActionPreview): string {
  const shown = preview.lines.slice(0, 2);
  if (shown.length === 0) return `${preview.title}?`;
  return `${preview.title} — ${shown.join(', ')}?`;
}

/** A parameter bag, read loosely: the describer must never throw on a shape. */
type Params = Record<string, unknown>;

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The thing an action is about, whether it arrived as a string or a target.
 *
 * Every entity-targeted tool in the contract takes `target: entityQuerySchema`,
 * which is an OBJECT — `{ query, on_date?, near_time? }`. `str()` returns null
 * for an object, and the fallbacks these call sites used (`params.title`,
 * `params.title_summary`) are fields those tools do not have. So every line
 * came back null, `compact()` yielded an empty array, and `previewSentence`
 * degraded to just the title.
 *
 * The result was a spoken yes/no question that named nothing: "Delete an
 * event?" over a fuzzy resolve the user could not see, with no undo underneath
 * it. The worst instance asked "Curriculum add?" and a yes ran
 * `DELETE FROM curriculum_schedule` — a whole term, untombstoned, recoverable
 * only from a JSON backup.
 */
function subject(value: unknown): string | null {
  const direct = str(value);
  if (direct) return direct;
  if (value && typeof value === 'object') {
    return str((value as { query?: unknown }).query);
  }
  return null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A wall-clock rendering of an epoch, in a named zone.
 *
 * The only place in this module that touches time, and it takes the zone
 * rather than reading a default: a confirmation showing the device's clock for
 * an event the user dictated in another timezone is the exact class of error
 * the confirmation exists to catch.
 */
export type Clock = (epochMs: number) => string;

function when(value: unknown, clock: Clock): string | null {
  const at = num(value);
  if (at !== null) return clock(at);
  // The model is also allowed to emit a wall-clock string, which the executor
  // resolves later. Showing it verbatim is honest: it is what was understood.
  return str(value);
}

function list(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  // Items are strings in some tools and `{ text, quantity }` objects in others
  // — `checklist_add` sends the latter, and reading only strings dropped every
  // item from the question that was asked about them.
  const items = value
    .map((item) => str(item) ?? str((item as { text?: unknown } | null)?.text))
    .filter((line): line is string => line !== null);
  return items.length === 0 ? null : items.join(' · ');
}

/**
 * Any scalar, as words. Used only by the fallback below.
 *
 * Booleans are spelled out rather than printed: `replace_existing: true` is the
 * difference between adding two classes and deleting a whole term, and "true"
 * is not what that means to somebody being asked to approve it.
 */
function scalar(key: string, value: unknown): string | null {
  // `subject` first: an entity `target` is an object, and the fallback exists
  // precisely for tools whose case did not read one — `task_complete` reaches
  // here with nothing else to say.
  const text = subject(value);
  if (text) return text;
  const n = num(value);
  if (n !== null) return String(n);
  if (typeof value === 'boolean') {
    if (!value) return null;
    return key === 'replace_existing' ? 'Replaces everything already there' : 'Yes';
  }
  return list(value);
}

/** Present only when there is something to say. */
function line(label: string, value: string | null): string | null {
  return value === null ? null : `${label}: ${value}`;
}

function compact(...lines: (string | null)[]): string[] {
  return lines.filter((entry): entry is string => entry !== null);
}

/**
 * Describes an action for the confirmation card.
 *
 * Total by construction. A tool with no case here still produces a usable card
 * from its own name rather than an empty one — a new tool must not be able to
 * make the confirmation silently blank, because a blank card is a yes/no
 * question with nothing to read and the user will simply press yes.
 */
export function describeAction(action: LlmAction, clock: Clock): ActionPreview {
  const preview = describeKnownAction(action, clock);
  if (preview.lines.length > 0) return preview;

  /*
   * A blank question is structurally impossible from here down.
   *
   * Every case below builds its lines from named fields, and a contract change
   * that renames one — or a tool whose parameters are a shape the case did not
   * expect — silently produced a preview with no lines at all. `previewSentence`
   * then degraded to just the title, so the user was asked "Delete an event?"
   * and "Curriculum add?" with nothing to judge, on the two tools with the
   * largest blast radius in the app.
   *
   * So a preview that says nothing falls back to every scalar parameter. It can
   * be ugly — "Replace existing: Replaces everything already there, Classes: …"
   * is not a sentence anybody wrote — and ugly is strictly better than blank,
   * because the thing being protected is the user's ability to say no.
   */
  const params = (action.parameters ?? {}) as Params;
  const everything = Object.entries(params)
    .map(([key, value]) => line(label(key), scalar(key, value)))
    .filter((entry): entry is string => entry !== null)
    .slice(0, 5);
  return { ...preview, lines: everything };
}

function describeKnownAction(action: LlmAction, clock: Clock): ActionPreview {
  const params = (action.parameters ?? {}) as Params;

  switch (action.tool_name) {
    case 'calendar_add':
      return {
        title: 'Add to calendar',
        lines: compact(
          line('Title', str(params.title)),
          line('Starts', when(params.start, clock)),
          line('Ends', when(params.end, clock)),
          line('For', minutes(num(params.duration_minutes))),
          line('Where', str(params.location)),
          params.all_day === true ? 'All day' : null,
        ),
      };

    case 'calendar_update':
      return {
        title: 'Change an event',
        lines: compact(
          line('Event', subject(params.target) ?? str(params.title) ?? str(params.query)),
          line('New time', when(params.start, clock)),
          line('New place', str(params.location)),
        ),
      };

    case 'calendar_delete':
      return {
        title: 'Delete an event',
        lines: compact(
          line('Event', subject(params.target) ?? str(params.query) ?? str(params.title)),
          line('On', when(params.on_date, clock)),
        ),
      };

    case 'note_create':
      return {
        title: 'Save a note',
        lines: compact(
          line('Note', str(params.title_summary)),
          line('Adding', list(params.bullets)),
          line('Tag', str(params.category_tag)),
        ),
      };

    case 'note_update':
      return {
        title: 'Change a note',
        lines: compact(
          line('Note', subject(params.target) ?? str(params.title_summary)),
          line('Adding', list(params.append_bullets)),
          line('New title', str(params.new_title_summary)),
        ),
      };

    case 'note_delete':
      return { title: 'Delete a note', lines: compact(line('Note', subject(params.target) ?? str(params.title_summary))) };

    case 'habit_log':
      return {
        title: 'Log a habit',
        lines: compact(
          line('Habit', str(params.habit_name)),
          line('For', minutes(num(params.duration_minutes))),
          line('On', when(params.on_date ?? params.at, clock)),
          line('Note', str(params.note)),
        ),
      };

    case 'ledger_add':
      return {
        title: 'Record money',
        lines: compact(
          line('Amount', money(num(params.amount), str(params.currency))),
          line('Direction', str(params.direction)),
          line('Who', str(params.entity_name)),
          line('What', str(params.description) ?? str(params.category)),
          line('When', when(params.at, clock)),
        ),
      };

    case 'task_add':
      return {
        title: 'Add a task',
        lines: compact(
          line('Task', str(params.title)),
          line('Due', when(params.due, clock)),
          line('Notes', str(params.notes)),
        ),
      };

    case 'place_save':
      return {
        title: 'Save a place',
        lines: compact(line('Place', str(params.name) ?? str(params.label)), line('Address', str(params.address))),
      };

    case 'crm_add_commitment':
      return {
        title: 'Add a commitment',
        lines: compact(
          line('Who', str(params.person_name) ?? str(params.entity_name)),
          line('What', str(params.commitment_text) ?? str(params.description) ?? str(params.title)),
          line('By', when(params.due ?? params.at, clock)),
        ),
      };

    case 'checklist_add':
      return {
        title: 'Add to a list',
        lines: compact(line('List', str(params.list_name)), line('Adding', list(params.items) ?? str(params.item_text))),
      };

    default: {
      // Readable without a case of its own: "project_add_item" -> "Project add
      // item", and every string parameter shown so nothing mis-heard is hidden.
      const words = action.tool_name.replace(/_/g, ' ');
      return {
        title: words.charAt(0).toUpperCase() + words.slice(1),
        lines: Object.entries(params)
          .map(([key, value]) => line(label(key), scalar(key, value)))
          .filter((entry): entry is string => entry !== null)
          .slice(0, 5),
      };
    }
  }
}

function label(key: string): string {
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function minutes(value: number | null): string | null {
  if (value === null || value <= 0) return null;
  if (value < 60) return `${value}m`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

function money(amount: number | null, currency: string | null): string | null {
  if (amount === null) return null;
  // Two decimals only when they carry something: "12" reads faster than
  // "12.00", and this line exists to be read fast.
  const shown = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return currency ? `${shown} ${currency}` : shown;
}
