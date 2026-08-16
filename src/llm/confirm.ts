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
 * lists are complements by construction: if the receipt can offer you an undo,
 * you get the speed; if it cannot, you get the question. Neither list is
 * allowed to be a judgement call, which is why both are spelled out.
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

/** Whether this tool writes at all. Queries never ask. */
export function isWrite(tool: ToolName): boolean {
  return WRITES.has(tool);
}

/** Whether a mistake here can be taken back from the receipt. */
export function isReversible(tool: ToolName): boolean {
  return REVERSIBLE.has(tool);
}

/**
 * Whether this action should be shown to the user before it runs.
 *
 * `timer_start` and `timer_control` are writes and are not on the undoable
 * list, and they are still not worth a question: the mistake is visible the
 * instant it happens, on the screen you are already looking at, and costs one
 * tap. A confirmation there would be the app asking permission to do the thing
 * you just asked it to do.
 */
const NEVER_ASKS: ReadonlySet<ToolName> = new Set<ToolName>(['timer_start', 'timer_control']);

export function needsConfirmation(tool: ToolName, mode: ConfirmMode): boolean {
  if (mode === 'never') return false;
  if (!isWrite(tool)) return false;
  if (NEVER_ASKS.has(tool)) return false;
  return mode === 'always' ? true : !isReversible(tool);
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
  const items = value.map(str).filter((line): line is string => line !== null);
  return items.length === 0 ? null : items.join(' · ');
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
          line('Event', str(params.title) ?? str(params.query)),
          line('New time', when(params.start, clock)),
          line('New place', str(params.location)),
        ),
      };

    case 'calendar_delete':
      return { title: 'Delete an event', lines: compact(line('Event', str(params.query) ?? str(params.title))) };

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
          line('Note', str(params.target) ?? str(params.title_summary)),
          line('Adding', list(params.append_bullets)),
          line('New title', str(params.new_title_summary)),
        ),
      };

    case 'note_delete':
      return { title: 'Delete a note', lines: compact(line('Note', str(params.target) ?? str(params.title_summary))) };

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
          line('What', str(params.description) ?? str(params.title)),
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
          .map(([key, value]) => line(label(key), str(value) ?? list(value)))
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
