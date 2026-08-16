/**
 * The rule about which mistakes are recoverable exists in two files, and they
 * have to agree — see the note on `REVERSIBLE` in `confirm.ts`.
 */
import { UNDOABLE_TOOLS } from '@/features/home/undo';
import { TOOL_NAMES } from '../contract';
import type { LlmAction, ToolName } from '../contract';
import {
  DEFAULT_CONFIRM_MODE,
  describeAction,
  isReversible,
  isWrite,
  needsConfirmation,
  previewSentence,
} from '../confirm';

/** Fixed, so a rendered time is a value this file can assert rather than today's. */
const clock = (epochMs: number): string =>
  new Date(epochMs).toISOString().replace('T', ' ').slice(0, 16);

const action = (tool: ToolName, parameters: Record<string, unknown> = {}): LlmAction =>
  ({ tool_name: tool, parameters }) as LlmAction;

describe('what gets confirmed', () => {
  it('never asks about a query', () => {
    for (const tool of ['search', 'ledger_query', 'briefing_generate', 'summary_generate'] as const) {
      expect(isWrite(tool)).toBe(false);
      expect(needsConfirmation(tool, 'always')).toBe(false);
    }
  });

  it('asks about the writes undo cannot take back', () => {
    for (const tool of ['habit_log', 'note_create', 'note_update', 'note_delete', 'calendar_delete'] as const) {
      expect(needsConfirmation(tool, 'irreversible')).toBe(true);
    }
  });

  it('stays out of the way of the ones the receipt can undo', () => {
    for (const tool of ['task_add', 'calendar_add', 'activity_log', 'ledger_add'] as const) {
      expect(needsConfirmation(tool, 'irreversible')).toBe(false);
      // ...but the user can still ask to be asked.
      expect(needsConfirmation(tool, 'always')).toBe(true);
    }
  });

  /* A timer is wrong in front of you, on the screen you are already looking at,
     and costs one tap. Asking there is the app requesting permission to do the
     thing it was just told to do. */
  it('does not interrupt a timer', () => {
    expect(needsConfirmation('timer_start', 'always')).toBe(false);
    expect(needsConfirmation('timer_control', 'always')).toBe(false);
  });

  it('"never" means never', () => {
    for (const tool of TOOL_NAMES) {
      expect(needsConfirmation(tool, 'never')).toBe(false);
    }
  });

  it('defaults to asking only about what cannot be undone', () => {
    expect(DEFAULT_CONFIRM_MODE).toBe('irreversible');
  });
});

describe('the two lists of recoverable mistakes agree', () => {
  /* `undo.ts` decides what the receipt offers; `confirm.ts` decides what gets
     a question first. If they disagree, some tool is either asked about *and*
     undoable — two safety nets and an interruption — or neither, which is a
     silent unrecoverable write. That second one is the bug this pair exists to
     make impossible. */
  it('every tool undo can reverse is one confirm treats as reversible', () => {
    for (const tool of UNDOABLE_TOOLS) {
      expect({ tool, reversible: isReversible(tool) }).toEqual({ tool, reversible: true });
    }
  });

  it('and nothing else claims to be', () => {
    const claimed = TOOL_NAMES.filter(isReversible).sort();
    expect(claimed).toEqual([...UNDOABLE_TOOLS].sort());
  });

  it('every reversible tool is a write', () => {
    for (const tool of TOOL_NAMES.filter(isReversible)) {
      expect({ tool, write: isWrite(tool) }).toEqual({ tool, write: true });
    }
  });
});

describe('the card shows what could have been mis-heard', () => {
  it('puts the name and the time of an event on it', () => {
    const preview = describeAction(
      action('calendar_add', { title: 'Meeting with James', start: 1_755_792_000_000, location: 'Maker lab' }),
      clock,
    );
    expect(preview.title).toBe('Add to calendar');
    expect(preview.lines.join('\n')).toContain('Meeting with James');
    expect(preview.lines.join('\n')).toContain('Maker lab');
    expect(preview.lines.some((l) => l.startsWith('Starts:'))).toBe(true);
  });

  it('puts the amount and the person on a payment', () => {
    const preview = describeAction(
      action('ledger_add', { amount: 42.5, currency: 'EUR', entity_name: 'Ana', direction: 'out' }),
      clock,
    );
    expect(preview.lines.join('\n')).toContain('42.50 EUR');
    expect(preview.lines.join('\n')).toContain('Ana');
  });

  it('drops decimals that carry nothing', () => {
    const preview = describeAction(action('ledger_add', { amount: 12, currency: 'EUR' }), clock);
    expect(preview.lines.join('\n')).toContain('12 EUR');
  });

  it('lists the bullets a note is about to gain', () => {
    const preview = describeAction(
      action('note_create', { title_summary: 'Shopping', bullets: ['milk', 'bread'] }),
      clock,
    );
    expect(preview.lines.join('\n')).toContain('milk · bread');
  });

  /* The recogniser's own timezone bug: an event dictated abroad rendered in the
     device's clock would show a time the user never said, on the card whose
     whole job is catching exactly that. */
  it('renders time through the clock it is given, not the device', () => {
    const preview = describeAction(action('calendar_add', { title: 'x', start: 0 }), clock);
    expect(preview.lines.join('\n')).toContain('1970-01-01 00:00');
  });

  it('shows a wall-clock string the model emitted verbatim', () => {
    const preview = describeAction(action('task_add', { title: 'x', due: 'tomorrow 5pm' }), clock);
    expect(preview.lines.join('\n')).toContain('tomorrow 5pm');
  });

  /* A blank card is a yes/no question with nothing to read, and the answer to
     one of those is always yes. */
  it.each(TOOL_NAMES)('%s never produces an unreadable card', (tool) => {
    const preview = describeAction(action(tool, { title: 'something', name: 'something' }), clock);
    expect(preview.title.length).toBeGreaterThan(0);
    expect(preview.title).toBe(preview.title.trim());
  });

  it('survives parameters of the wrong shape without throwing', () => {
    const preview = describeAction(
      action('calendar_add', { title: null, start: {}, location: 42, bullets: [null, 1] }),
      clock,
    );
    expect(Array.isArray(preview.lines)).toBe(true);
  });

  it('omits a line rather than printing an empty one', () => {
    const preview = describeAction(action('calendar_add', { title: 'x', location: '   ' }), clock);
    expect(preview.lines.some((l) => /:\s*$/.test(l))).toBe(false);
    expect(preview.lines.join('\n')).not.toContain('Where');
  });
});

describe('the spoken question carries the words that might be wrong', () => {
  /* The sheet can be shut and the assistant is answered by voice, so the
     question has to stand alone. "Add to calendar?" does not — a yes/no with
     nothing in it to check gets a yes, and the gate becomes a tap that
     protects nothing. */
  it('names the thing, not just the kind of change', () => {
    const preview = describeAction(
      action('calendar_add', { title: 'Meeting with James', start: 1_755_792_000_000 }),
      clock,
    );
    const spoken = previewSentence(preview);
    expect(spoken).toContain('Meeting with James');
    expect(spoken.endsWith('?')).toBe(true);
  });

  it('stops at two values, so it stays holdable while it is read aloud', () => {
    const preview = describeAction(
      action('ledger_add', {
        amount: 42, currency: 'EUR', entity_name: 'Ana',
        direction: 'out', description: 'lunch', at: 0,
      }),
      clock,
    );
    expect(previewSentence(preview).split(',').length).toBeLessThanOrEqual(2);
  });

  it('still asks something answerable when there is nothing to show', () => {
    expect(previewSentence({ title: 'Delete a note', lines: [] })).toBe('Delete a note?');
  });
});
