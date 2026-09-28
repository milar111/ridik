/**
 * No tool may ever ask a blank question.
 *
 * The review gate turns an action into a yes/no that is read aloud and drawn on
 * a card. `describeAction` builds it from named parameters — and for every
 * entity-targeted tool it was reading the wrong shape. The contract gives them
 * `target: { query, on_date?, near_time? }`, an OBJECT; the describer called
 * `str()` on it, got null, fell back to fields those tools do not have, and
 * produced a preview with no lines. `previewSentence` then degraded to the bare
 * title.
 *
 * What the user actually heard:
 *
 *     "Delete an event?"        — which event? there is no undo for a delete
 *     "Curriculum add?"         — a yes here runs DELETE FROM curriculum_schedule
 *
 * The second is the whole timetable, untombstoned, not on the undo allow-list,
 * recoverable only from a JSON backup somebody probably has not made.
 *
 * The existing suite could not catch it: it asserted `preview.title.length > 0`
 * and fed flat `{ title, name }` parameters that no tool actually receives.
 *
 * So this file iterates the *contract* rather than a hand-written list, and
 * feeds each tool the shape its schema really declares. A new tool with an
 * unhandled parameter shape fails here rather than on somebody's timetable.
 */
import { TOOL_NAMES, type ToolName } from '../contract';
import { describeAction, previewSentence } from '../confirm';

const clock = { now: () => Date.parse('2026-08-17T09:00:00Z'), zone: 'Europe/Sofia' };

/**
 * Parameters shaped the way the contract declares them.
 *
 * Deliberately hand-written rather than generated from the Zod schemas: the
 * point is to encode what the *model* really sends, including the two shapes
 * that broke it — an entity `target` object, and list items that are
 * `{ text, quantity }` rather than strings.
 */
const PARAMS: Record<ToolName, Record<string, unknown>> = {
  calendar_add: { title: 'Dentist', start: '2026-08-18T15:00' },
  calendar_update: { target: { query: 'dentist' }, start: '2026-08-18T16:00' },
  calendar_delete: { target: { query: 'dentist', on_date: '2026-08-21' } },
  note_create: { title_summary: 'Robotics lab', bullets: ['10k resistors'] },
  note_update: { target: { query: 'robotics lab' }, append_bullets: ['servos'] },
  note_delete: { target: { query: 'robotics lab' } },
  habit_log: { habit_name: 'Gym' },
  activity_log: { habit_name: 'Gym', minutes: 30 },
  timer_start: { minutes: 25, label: 'Focus' },
  timer_control: { action: 'pause' },
  ledger_add: { amount: 12.5, currency: 'EUR', category: 'lunch' },
  ledger_query: { period: 'month' },
  ledger_delete: { query: 'lunch', amount: 12.5 },
  checklist_add: { list_name: 'Shopping', items: [{ text: 'milk', quantity: 2 }] },
  checklist_toggle: { list_name: 'Shopping', item_text: 'milk', done: true },
  checklist_remove: { list_name: 'Shopping', item_query: 'milk' },
  checklist_delete: { list_name: 'Shopping' },
  geofence_add: { place_name: 'Maker lab', note: 'pick up the frame' },
  place_save: { name: 'Maker lab', latitude: 42.7, longitude: 23.3 },
  crm_add_commitment: { person_name: 'Ivo', commitment_text: 'send the schematic' },
  crm_log_interaction: { person_name: 'Ivo', summary: 'talked about the frame' },
  task_add: { title: 'Buy paint' },
  task_add_dependency: { child_title: 'Assembly', parent_titles: ['Print frame'] },
  task_update: { target: { query: 'buy paint' }, due: '2026-08-19T18:00' },
  task_delete: { target: { query: 'buy paint' } },
  task_complete: { target: { query: 'buy paint' } },
  // The dangerous one. `replace_existing` is a boolean and `classes` an array
  // of objects, so a describer that reads only strings says nothing at all.
  curriculum_add: {
    entries: [{ subject: 'Math', weekday: 1, start: '08:00', end: '09:00' }],
    replace_existing: true,
  },
  project_create: { name: 'Japan trip' },
  project_add_item: { project_name: 'Japan trip', item_text: 'pack slippers' },
  project_item_toggle: { project_name: 'Japan trip', item_text: 'pack slippers', done: true },
  briefing_generate: { scope: 'today', speak: true },
  summary_generate: { period: 'week', format: 'markdown' },
  search: { query: 'resistors' },
} as Record<ToolName, Record<string, unknown>>;

describe('every tool can describe itself', () => {
  /* The registry, not a list maintained here — a new tool arrives in this test
     the moment it arrives in the contract. */
  it('has parameters pinned for every tool the contract declares', () => {
    const missing = TOOL_NAMES.filter((name) => PARAMS[name as ToolName] === undefined);
    expect(missing).toEqual([]);
  });

  it.each(TOOL_NAMES)('says something specific about %s', (name) => {
    const preview = describeAction(
      { tool_name: name, parameters: PARAMS[name as ToolName] } as never,
      clock as never,
    );

    expect(preview.title.length).toBeGreaterThan(0);
    // The actual assertion. A preview with no lines is a question with nothing
    // in it, and this is the condition that held for six tools.
    expect(preview.lines.length).toBeGreaterThan(0);
  });

  /* And the sentence that gets read aloud is the thing that has to carry it. */
  it.each(TOOL_NAMES)('reads aloud as more than a bare title for %s', (name) => {
    const preview = describeAction(
      { tool_name: name, parameters: PARAMS[name as ToolName] } as never,
      clock as never,
    );
    const spoken = previewSentence(preview);

    expect(spoken).not.toBe(`${preview.title}?`);
    expect(spoken).toContain('—');
  });
});

describe('the questions that destroy things name what they destroy', () => {
  const preview = (name: ToolName) =>
    previewSentence(
      describeAction({ tool_name: name, parameters: PARAMS[name] } as never, clock as never),
    );

  it('names the event it is about to delete', () => {
    expect(preview('calendar_delete')).toContain('dentist');
  });

  it('names the note it is about to delete', () => {
    expect(preview('note_delete')).toContain('robotics lab');
  });

  /**
   * The worst one in the app.
   *
   * `curriculum_add` with `replace_existing: true` runs a full-table delete of
   * the user's timetable. It asked "Curriculum add?" — a boolean and an array
   * of objects, both invisible to a describer that read only strings. The
   * question must say that everything already there is being replaced.
   */
  it('says a timetable is about to be replaced', () => {
    expect(preview('curriculum_add')).toMatch(/replac/i);
  });

  it('names the items it is adding to a list', () => {
    expect(preview('checklist_add')).toContain('milk');
  });

  it('names the promise it is recording', () => {
    expect(preview('crm_add_commitment')).toContain('schematic');
  });
});
