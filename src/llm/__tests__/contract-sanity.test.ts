/**
 * The contract asked a second question.
 *
 * Type-checking a reply only proves the model filled the right boxes. These
 * cases are the ones where every box is the right type and the values still
 * cannot mean what they say: an event that ends before it starts, a timetable
 * row of negative length, a range whose end precedes its beginning, a task that
 * is its own prerequisite, the same write repeated until it stops being a
 * sentence. Each used to pass validation and reach a repository, where the
 * damage is quiet — a lie in the audit trail, a task that can never unlock, a
 * "nothing found" delivered with total confidence.
 *
 * Two properties are asserted throughout:
 *  - a bad value is a **rejection**, not a clamp. The repair loop can explain a
 *    rejection to the model; a silently corrected value is our mistake now.
 *  - the issue **names the field**, because that string is what the retry
 *    prompt shows the model and is the whole reason repair works at all.
 *
 * The second half is the other half of the bargain: utterances that look odd
 * but are perfectly ordinary must still go through. A validator that fails
 * those costs the user a round trip to be told what they already said.
 */
import { MAX_IDENTICAL_ACTIONS, parseLlmResponse, type LlmAction } from '@/llm/contract';

type Draft = { tool_name: string; parameters: unknown };

function issuesFor(...actions: Draft[]): string[] {
  const parsed = parseLlmResponse({
    conversational_feedback: 'Done.',
    requires_user_input: false,
    actions,
  });
  return parsed.ok ? [] : parsed.issues;
}

/** Asserts a rejection whose message the retry prompt can act on. */
function expectRejected(action: Draft, ...fragments: string[]): void {
  const issues = issuesFor(action);
  expect(issues.length).toBeGreaterThan(0);
  const joined = issues.join('\n');
  for (const fragment of fragments) expect(joined).toContain(fragment);
}

function expectAccepted(...actions: Draft[]): void {
  expect(issuesFor(...actions)).toEqual([]);
}

describe('times that cannot be what they say', () => {
  it('refuses an event that ends before it starts', () => {
    expectRejected(
      {
        tool_name: 'calendar_add',
        parameters: { title: 'Dentist', start: '2026-08-14T15:00', end: '2026-08-14T14:00' },
      },
      'actions.0.parameters.end',
      'after the start',
    );
  });

  /* Zero length is the same mistake with a rounder number, and the executor
     would happily write it. Which of the two times is wrong is not ours to
     guess, so the model is asked. */
  it('refuses an event that ends the moment it starts', () => {
    expectRejected({
      tool_name: 'calendar_add',
      parameters: { title: 'Standup', start: '2026-08-14T15:00', end: '2026-08-14T15:00' },
    }, 'actions.0.parameters.end');
  });

  it('reads a space and stray seconds the same way it reads a T', () => {
    expectRejected({
      tool_name: 'calendar_add',
      parameters: { title: 'Dentist', start: '2026-08-14T15:00:00', end: '2026-08-14 14:59' },
    }, 'actions.0.parameters.end');
  });

  /* An all-day event's own times are replaced by the day's bounds, so there is
     nothing left for a contradiction to corrupt — and "block out Friday" is a
     real utterance that arrives with a time attached. */
  it('leaves an all-day event alone, whatever times it carries', () => {
    expectAccepted({
      tool_name: 'calendar_add',
      parameters: {
        title: 'Conference',
        start: '2026-08-14T09:00',
        end: '2026-08-14T08:00',
        all_day: true,
      },
    });
  });

  it('refuses a move that would end before it starts', () => {
    expectRejected(
      {
        tool_name: 'calendar_update',
        parameters: {
          target: { query: 'dentist' },
          start: '2026-08-14T15:00',
          end: '2026-08-14T09:00',
        },
      },
      'actions.0.parameters.end',
    );
  });

  /* A timetable row is the one place a wrong length stays invisible: it repeats
     every week and nobody re-reads it. */
  it('refuses a class that ends before it begins', () => {
    expectRejected(
      {
        tool_name: 'curriculum_add',
        parameters: {
          entries: [
            { subject_name: 'Physics', day_of_week: 1, start_time: '08:00', end_time: '09:30' },
            { subject_name: 'Maths', day_of_week: 1, start_time: '11:30', end_time: '10:00' },
          ],
        },
      },
      'actions.0.parameters.entries.1.end_time',
    );
  });
});

describe('dates that are not dates', () => {
  it.each([
    ['1970-01-01T00:00', 'the epoch a lost model falls back to'],
    ['2140-06-01T09:00', 'a century past anything a diary holds'],
  ])('refuses %s (%s)', (start) => {
    expectRejected(
      { tool_name: 'calendar_add', parameters: { title: 'Nowhen', start } },
      'actions.0.parameters.start',
      'year must be between',
    );
  });

  it('refuses a day the calendar does not have', () => {
    // Digit-shaped is not the same as real: both of these match the regex.
    expectRejected(
      { tool_name: 'calendar_add', parameters: { title: 'Nowhen', start: '2026-02-30T10:00' } },
      'does not exist',
    );
    expectRejected(
      { tool_name: 'habit_log', parameters: { habit_name: 'Running', on_date: '2026-13-01' } },
      'actions.0.parameters.on_date',
      'does not exist',
    );
  });

  it('complains once about a malformed date, not three times', () => {
    const issues = issuesFor({
      tool_name: 'habit_log',
      parameters: { habit_name: 'Running', on_date: 'yesterday' },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('Expected YYYY-MM-DD');
  });

  it('keeps a leap day, which is exactly the kind of date that gets over-validated', () => {
    expectAccepted({
      tool_name: 'calendar_add',
      parameters: { title: 'Leap party', start: '2028-02-29T20:00' },
    });
  });
});

describe('ranges and pairs that contradict themselves', () => {
  it('refuses a period that ends before it starts', () => {
    expectRejected(
      {
        tool_name: 'ledger_query',
        parameters: { period: 'custom', from: '2026-08-01', to: '2026-07-01' },
      },
      'actions.0.parameters.to',
    );
  });

  /* Without both ends, a custom period silently becomes today and answers a
     question nobody asked with a number they will believe. */
  it('refuses a custom period with no range', () => {
    expectRejected(
      { tool_name: 'summary_generate', parameters: { period: 'custom' } },
      'actions.0.parameters.period',
      'both from and to',
    );
  });

  it('refuses a project whose target date precedes its start', () => {
    expectRejected(
      {
        tool_name: 'project_create',
        parameters: { name: 'Drone build', start_date: '2026-09-01', target_date: '2026-08-01' },
      },
      'actions.0.parameters.target_date',
    );
  });

  /* Two hints that disagree cannot both narrow the search, and choosing between
     them is precisely the guess the resolver exists to refuse. */
  it('refuses a target whose two time hints point at different days', () => {
    expectRejected(
      {
        tool_name: 'calendar_delete',
        parameters: {
          target: { query: 'dentist', on_date: '2026-08-14', near_time: '2026-08-15T09:00' },
        },
      },
      'actions.0.parameters.target.near_time',
    );
  });

  it('refuses half a coordinate', () => {
    expectRejected(
      {
        tool_name: 'geofence_add',
        parameters: {
          label: 'the lab',
          action_description: 'Grab the brackets',
          trigger_type: 'ENTER',
          latitude: 42.65,
        },
      },
      'actions.0.parameters.longitude',
    );
  });

  it('takes a geofence with no coordinates at all, which resolves by name', () => {
    expectAccepted({
      tool_name: 'geofence_add',
      parameters: {
        label: 'the lab',
        action_description: 'Grab the brackets',
        trigger_type: 'ENTER',
      },
    });
  });
});

describe('writes that would achieve nothing, or lock something for ever', () => {
  /* Both of these report success. "Moved Dentist to Friday 15:00" for an event
     that did not move is a lie about the user's data, which is worse than an
     error they can act on. */
  it('refuses an update that changes nothing', () => {
    expectRejected(
      { tool_name: 'calendar_update', parameters: { target: { query: 'dentist' } } },
      'Nothing to change',
    );
    expectRejected(
      { tool_name: 'note_update', parameters: { target: { query: 'robotics' } } },
      'Nothing to change',
    );
    expectRejected(
      {
        tool_name: 'note_update',
        parameters: { target: { query: 'robotics' }, append_bullets: [] },
      },
      'Nothing to change',
    );
  });

  it('refuses a task that is its own prerequisite', () => {
    expectRejected(
      {
        tool_name: 'task_add',
        parameters: { title: 'Assemble the frame', depends_on: ['assemble the frame  '] },
      },
      'actions.0.parameters.depends_on.0',
      'own prerequisite',
    );
    expectRejected(
      {
        tool_name: 'task_add_dependency',
        parameters: { child: 'Print the brackets', parents: ['Order PLA', 'Print the brackets'] },
      },
      'actions.0.parameters.parents.1',
    );
  });
});

describe('the same action, over and over', () => {
  const coffee = {
    tool_name: 'ledger_add',
    parameters: { amount: 3, currency: 'EUR', category: 'coffee' },
  };

  /* The decoding loop this catches: one utterance, twenty-five identical
     writes. Nothing downstream would question it — every one of them is valid. */
  it('refuses a turn that repeats one action past the point of meaning', () => {
    const many = Array.from({ length: 25 }, () => coffee);
    const issues = issuesFor(...many);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.join('\n')).toContain('identical parameters');
    // Named at the first repeat past the limit, so the model can see where.
    expect(issues.join('\n')).toContain(`actions.${MAX_IDENTICAL_ACTIONS}`);
  });

  /* "Two coffees at three euros each" is a real sentence. Failing it to catch a
     rarer fault would be trading a certainty for a maybe. */
  it('takes two of the same, because people buy two of the same', () => {
    expectAccepted(coffee, coffee);
  });

  it('sees past key order when deciding what identical means', () => {
    const reordered = {
      tool_name: 'ledger_add',
      parameters: { category: 'coffee', currency: 'EUR', amount: 3 },
    };
    expect(issuesFor(coffee, reordered, coffee).join('\n')).toContain('identical parameters');
  });

  it('leaves a batch of genuinely different actions alone', () => {
    expectAccepted(
      coffee,
      { tool_name: 'ledger_add', parameters: { amount: 4, currency: 'EUR', category: 'coffee' } },
      { tool_name: 'habit_log', parameters: { habit_name: 'Running' } },
    );
  });
});

describe('what a strict parameter object costs and buys', () => {
  /* The key that matters is not the attacker's — that one is inert whether it
     is dropped or rejected. It is this one: `end_time` belongs to
     `curriculum_add`, and dropping it silently gave the event the default hour
     and told the user it was booked. */
  it('catches the plausible key, not just the malicious one', () => {
    expectRejected(
      {
        tool_name: 'calendar_add',
        parameters: { title: 'Dentist', start: '2026-08-14T15:00', end_time: '16:00' },
      },
      'end_time',
    );
  });

  it('states the cost honestly: one harmless extra field fails the turn', () => {
    // Weighed and accepted. It costs a repair round trip, the validator names
    // the key, and a provider decoding against the derived schema cannot emit
    // one in the first place.
    expectRejected(
      {
        tool_name: 'note_create',
        parameters: {
          title_summary: 'Resistors',
          category_tag: 'electronics',
          bullets: ['10k'],
          confidence: 0.9,
        },
      },
      'confidence',
    );
  });

  /* A union that fails reports "Invalid input" and nothing else — the one kind
     of complaint the repair loop cannot act on — so this one says what the two
     shapes are. */
  it('leaves a nested object no room either, and says what it wanted instead', () => {
    expectRejected(
      {
        tool_name: 'checklist_add',
        parameters: { list_name: 'groceries', items: [{ text: 'milk', unit: 'litres' }] },
      },
      'actions.0.parameters.items.0',
      'plain string or an object with text',
    );
  });
});

describe('the ordinary turns all of this must not break', () => {
  it('takes the shapes the prompt teaches', () => {
    const actions: Draft[] = [
      {
        tool_name: 'calendar_add',
        parameters: {
          title: 'Dentist',
          start: '2026-08-14T15:00',
          duration_minutes: 60,
          location: 'Clinic on Vitosha',
          kind: 'event',
          needs_buffer: true,
          // Travel routinely outlasts the appointment; a ratio rule here would
          // fail more real turns than it saved.
          buffer_minutes: 90,
        },
      },
      {
        tool_name: 'calendar_add',
        parameters: { title: 'Exam', start: '2026-08-15T09:00', end: '2026-08-15T11:00' },
      },
      {
        tool_name: 'task_add',
        parameters: { title: 'Assemble the frame', depends_on: ['Print the brackets'] },
      },
      { tool_name: 'ledger_query', parameters: { period: 'month', group_by: 'category' } },
      {
        tool_name: 'summary_generate',
        parameters: { period: 'custom', from: '2026-08-01', to: '2026-08-31' },
      },
      {
        tool_name: 'curriculum_add',
        parameters: {
          entries: [
            { subject_name: 'Physics', day_of_week: 1, start_time: '08:00', end_time: '09:30' },
          ],
        },
      },
    ];
    expectAccepted(...actions);
  });

  it('still applies every default it applied before', () => {
    const parsed = parseLlmResponse({
      actions: [{ tool_name: 'calendar_add', parameters: { title: 'x', start: '2026-08-14T15:00' } }],
    });
    expect(parsed.ok).toBe(true);
    const action = (parsed.ok ? parsed.value.actions[0] : null) as LlmAction;
    if (action.tool_name !== 'calendar_add') throw new Error('expected calendar_add');
    expect(action.parameters.kind).toBe('event');
  });
});
