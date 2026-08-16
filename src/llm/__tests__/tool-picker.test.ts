/**
 * Which tools go out with an utterance.
 *
 * Twenty-eight tools across sixteen domains were offered on every call, while
 * a real utterance touches one domain of two or three. Google's guidance is to
 * keep the active set to 10–20, and the cost of ignoring it is not an error
 * message: with the decoder constrained by the enum, a tool the model cannot
 * emit is not refused, it is *substituted* — a plausible receipt over the wrong
 * row, which is the failure this whole app is arranged around.
 *
 * That is why the interesting tests here are the ones about refusing. A picker
 * that narrows confidently and wrongly is worse than the 28 it replaced, so it
 * has to be able to say "I don't know" exactly as `resolveOne` does, and these
 * hold the two places it must: an utterance whose intent it cannot see at all,
 * and one where it can only see *part* of what was said.
 */
import { TOOL_NAMES, type ToolName } from '@/llm/contract';
import { FEW_SHOT_EXAMPLES } from '@/llm/prompt';
import {
  ALWAYS_OFFERED,
  DOMAIN_TOOLS,
  MAX_NARROWED_TOOLS,
  pickTools,
  splitClauses,
  normaliseUtterance,
  type ToolDomain,
} from '@/llm/toolPicker';

const domains = Object.keys(DOMAIN_TOOLS) as ToolDomain[];

describe('the domain map', () => {
  /**
   * The one that must never rot. A tool missing from this map is a tool that
   * cannot be emitted on any narrowed turn — the build stays green, the
   * validator stays happy, and a capability simply stops existing for every
   * utterance the picker is sure about.
   */
  it('gives every tool in the contract exactly one domain', () => {
    const mapped = domains.flatMap((domain) => [...DOMAIN_TOOLS[domain]]);

    expect([...mapped].sort()).toEqual([...TOOL_NAMES].sort());
    expect(new Set(mapped).size).toBe(mapped.length);
  });

  it('offers the one tool that cannot lose anything, whatever was said', () => {
    // The same rule the offline engine follows: everything unrecognised becomes
    // a note, because a note is lossless even when the classification is wrong.
    expect(ALWAYS_OFFERED).toEqual(['note_create']);
  });
});

describe('saying "I don\'t know"', () => {
  it('offers everything when nothing named a domain', () => {
    for (const utterance of ['', '   ', 'Hello there', 'Tell me a joke']) {
      expect(pickTools(utterance).tools).toBeNull();
    }
  });

  /**
   * The dangerous case, and the reason clauses are split at all. Half the
   * sentence is understood, the other half names a domain we did not
   * recognise, and narrowing around the half we read is how the rest gets
   * filed under the nearest tool that was left.
   */
  it('offers everything when part of the utterance is unaccounted for', () => {
    const pick = pickTools('Add milk to the shopping list and I want to learn Japanese');

    expect(pick.tools).toBeNull();
    expect(pick.reason).toBe('unexplained_clause');
    // It still says what it *did* recognise, so a log line is diagnosable.
    expect(pick.domains).toContain('checklists');
  });

  it('offers everything when the utterance really does span the app', () => {
    const pick = pickTools(
      'Remind me at 4, I ran 5k, I spent 12 on lunch, and I finished the drone project',
    );

    expect(pick.tools).toBeNull();
    expect(pick.reason).toBe('too_broad');
  });
});

describe('narrowing', () => {
  const pickedFor = (utterance: string): readonly ToolName[] => {
    const pick = pickTools(utterance);
    expect(pick.reason).toBe('narrowed');
    return pick.tools ?? [];
  };

  it('cuts a plain single-intent utterance to its own domain', () => {
    expect(pickedFor('Add milk and bread to the shopping list')).toEqual([
      'note_create',
      'checklist_add',
      'checklist_toggle',
    ]);
    expect(pickedFor('Spent 12 leva on lunch')).toEqual([
      'note_create',
      'ledger_add',
      'ledger_query',
    ]);
    expect(pickedFor('Pause the timer')).toEqual([
      'note_create',
      'timer_start',
      'timer_control',
    ]);
  });

  it('keeps every domain a multi-intent utterance touches', () => {
    const tools = pickedFor('Spent 12 leva on lunch and I ran 5k this morning');

    expect(tools).toContain('ledger_add');
    expect(tools).toContain('habit_log');
  });

  /* Adding a domain costs two or three enum entries; missing one costs the
     user a wrong row. So the triggers overlap deliberately — three domains own
     a "that one is done" tool and the user says the same words for all three. */
  it('offers all three toggles when the words fit all three', () => {
    const tools = pickedFor('Mark the frame as printed');

    expect(tools).toEqual(
      expect.arrayContaining(['task_complete', 'checklist_toggle', 'project_item_toggle']),
    );
  });

  /* A timetable dictated as "physics Monday at 8, maths Tuesday at 9" names
     neither a class nor a timetable. Read as a calendar it becomes two one-off
     events that never repeat — the wrong row, silently, every week. */
  it('reads two weekdays in one breath as a timetable', () => {
    expect(pickedFor('Physics on Monday at 8, Maths on Tuesday at 9')).toContain('curriculum_add');
  });

  it('stays inside the active-set guidance and well under the full surface', () => {
    for (const utterance of [
      'Add milk to the shopping list',
      'Remind me to call the dentist at 4',
      'Spent 12 leva on lunch and I ran 5k this morning',
      'Mark the frame as printed',
      'Note that the lab needs 10k resistors',
    ]) {
      const tools = pickedFor(utterance);
      expect(tools.length).toBeLessThanOrEqual(MAX_NARROWED_TOOLS);
      expect(tools.length).toBeLessThan(TOOL_NAMES.length / 2);
      expect(tools).toContain('note_create');
    }
  });

  it('answers in contract order, so the same words build the same request', () => {
    const tools = pickedFor('Remind me to call Ivo at 4 and note the resistors');
    const order = [...tools].sort((a, b) => TOOL_NAMES.indexOf(a) - TOOL_NAMES.indexOf(b));

    expect(tools).toEqual(order);
    expect(pickTools('Add milk to the list')).toEqual(pickTools('add MILK to the LIST!'));
  });
});

/**
 * The regression net. Every example in the prompt carries both an utterance and
 * the actions it is supposed to produce, so the picker can be held to them
 * without anybody maintaining a second list that drifts: for each one, either
 * it declines to narrow, or every tool the example uses survives the narrowing.
 *
 * A new example, or a changed one, re-tests the picker for free.
 */
describe('the prompt\'s own examples', () => {
  it.each(FEW_SHOT_EXAMPLES.map((example) => [example.input, example] as const))(
    'never drops the tool %s needs',
    (_input, example) => {
      const pick = pickTools(example.input);
      if (pick.tools === null) return;

      for (const action of example.output.actions ?? []) {
        expect(pick.tools).toContain(action.tool_name);
      }
    },
  );
});

describe('reading the words', () => {
  it('keeps a contraction in one piece', () => {
    expect(normaliseUtterance("What's on today?")).toBe('whats on today');
    expect(pickTools("What's on today?").domains).toContain('briefing');
  });

  /* Splitting on every "and" would make "milk, eggs and bread" three clauses,
     two of which explain nothing — and every dictated list would bail. */
  it('breaks a clause only where a new instruction starts', () => {
    expect(splitClauses('add milk eggs and bread to the shopping list')).toHaveLength(1);
    expect(splitClauses('spent 12 on lunch and i ran 5k')).toEqual([
      'spent 12 on lunch',
      'i ran 5k',
    ]);
    expect(
      splitClauses('remind me to call ivo at 4 and note that the lab needs resistors'),
    ).toHaveLength(2);
  });
});
