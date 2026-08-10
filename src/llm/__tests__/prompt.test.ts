import { freezeClock } from '@/core/clock';
import { localToEpoch } from '@/core/time';
import { parseLlmResponse, TOOL_NAMES } from '@/llm/contract';
import {
  buildRetryPrompt,
  buildSystemPrompt,
  DOCUMENTED_TOOLS,
  FEW_SHOT_EXAMPLES,
  type LlmContext,
} from '@/llm/prompt';

const ZONE = 'Europe/Sofia';
const NOW = localToEpoch('2026-03-04T18:05', ZONE); // a Wednesday

const at = (local: string) => localToEpoch(local, ZONE);

const minimalContext: LlmContext = { now: NOW, zone: ZONE, weekStart: 'monday' };

const fullContext: LlmContext = {
  ...minimalContext,
  upcomingClasses: [
    { subject: 'Physics', startsAt: at('2026-03-09T08:00'), endsAt: at('2026-03-09T09:30'), location: 'Room 204' },
    { subject: 'Mathematics', startsAt: at('2026-03-05T10:00'), endsAt: at('2026-03-05T11:30') },
  ],
  todayEvents: [
    { title: 'Robotics club', startsAt: at('2026-03-04T19:00'), endsAt: at('2026-03-04T21:00'), location: 'The lab' },
  ],
  tomorrowEvents: [{ title: 'Chemistry exam', startsAt: at('2026-03-05T09:00'), kind: 'exam' }],
  openTasks: [
    { title: 'Print the brackets', dueAt: at('2026-03-06T18:00'), project: 'Drone build' },
    { title: 'Email the landlord' },
  ],
  projects: [
    { name: 'Drone build', kind: 'project' },
    { name: 'Greece trip', kind: 'trip' },
  ],
  notes: [{ title: 'Order 10k resistors', tag: 'electronics' }],
  checklistNames: ['Groceries', 'Hardware store'],
  crmNames: ['Ivo', 'Professor Dimitrov'],
  placeLabels: ['The lab', 'Home'],
  ledgerCategories: ['food', 'transport'],
  habitNames: ['Running', 'Reading'],
  focusSession: { label: 'Physics revision', subject: 'Physics', status: 'running', startedAt: at('2026-03-04T17:40') },
};

/** The injected-context block only, so the RULES prose cannot satisfy an assertion. */
function contextBlock(prompt: string): string {
  const start = prompt.indexOf('CONTEXT —');
  if (start === -1) return '';
  const end = prompt.indexOf('TOOLS (* = required)', start);
  return prompt.slice(start, end === -1 ? undefined : end);
}

describe('buildSystemPrompt', () => {
  it('injects now, zone, weekday and week start', () => {
    const prompt = buildSystemPrompt(minimalContext);
    expect(prompt).toContain('Local datetime: 2026-03-04T18:05 (Wednesday)');
    expect(prompt).toContain('Timezone: Europe/Sofia');
    expect(prompt).toContain('Today: 2026-03-04');
    expect(prompt).toContain('Week starts on: Monday');
  });

  it('honours a Sunday week start', () => {
    expect(buildSystemPrompt({ ...minimalContext, weekStart: 'sunday' })).toContain(
      'Week starts on: Sunday',
    );
  });

  it('renders every context section as local wall clock', () => {
    const prompt = buildSystemPrompt(fullContext);
    expect(prompt).toContain('CLASSES (next 7 days)');
    expect(prompt).toContain('- 2026-03-09T08:00–09:30 Physics @ Room 204');
    expect(prompt).toContain('- 2026-03-05T10:00–11:30 Mathematics');
    expect(prompt).toContain('- 2026-03-04T19:00–21:00 Robotics club @ The lab');
    expect(prompt).toContain('- 2026-03-05T09:00 Chemistry exam [exam]');
    expect(prompt).toContain('- Print the brackets (due 2026-03-06T18:00) [Drone build]');
    expect(prompt).toContain('- Email the landlord');
    expect(prompt).toContain('- Greece trip (trip)');
    expect(prompt).toContain('- Order 10k resistors #electronics');
    expect(prompt).toContain('CHECKLISTS: Groceries, Hardware store');
    expect(prompt).toContain('PEOPLE & ORGS: Ivo, Professor Dimitrov');
    expect(prompt).toContain('SAVED PLACES: The lab, Home');
    expect(prompt).toContain('SPENDING CATEGORIES: food, transport');
    expect(prompt).toContain('HABITS: Running, Reading');
    expect(prompt).toContain('FOCUS SESSION: "Physics revision" is running, started 2026-03-04T17:40');
  });

  it('drops the whole context block when there is no data', () => {
    expect(contextBlock(buildSystemPrompt(minimalContext))).toBe('');
  });

  it('omits the sections that are empty', () => {
    const block = contextBlock(
      buildSystemPrompt({ ...minimalContext, openTasks: [{ title: 'Email the landlord' }] }),
    );
    expect(block).toContain('OPEN TASKS');
    for (const heading of [
      'CLASSES',
      'TODAY',
      'TOMORROW',
      'PROJECTS',
      'NOTES',
      'CHECKLISTS:',
      'PEOPLE & ORGS:',
      'SAVED PLACES:',
      'SPENDING CATEGORIES:',
      'HABITS:',
      'FOCUS SESSION:',
    ]) {
      expect(block).not.toContain(heading);
    }
  });

  it('caps long sections and says how many were dropped', () => {
    const prompt = buildSystemPrompt({
      ...minimalContext,
      openTasks: Array.from({ length: 100 }, (_, i) => ({ title: `Task ${i}` })),
      crmNames: Array.from({ length: 40 }, (_, i) => `Person ${i}`),
    });
    expect(prompt).toContain('- Task 14');
    expect(prompt).not.toContain('- Task 15');
    expect(prompt).toContain('… and 85 more');
    expect(prompt).toContain('Person 24, … and 15 more');
  });

  it('is byte-identical for the same context regardless of the wall clock', () => {
    const first = buildSystemPrompt(fullContext);
    const restore = freezeClock(at('2031-12-25T04:00'));
    try {
      expect(buildSystemPrompt(fullContext)).toBe(first);
    } finally {
      restore();
    }
    expect(buildSystemPrompt(fullContext)).toBe(first);
  });

  it('states the behavioural rules from the spec', () => {
    const prompt = buildSystemPrompt(fullContext);
    expect(prompt).toContain('MULTI-INTENT');
    expect(prompt).toContain('CURRICULUM INFERENCE');
    expect(prompt).toContain('schedule_reason');
    expect(prompt).toContain('BUFFERS');
    expect(prompt).toContain('needs_buffer');
    expect(prompt).toContain('CLARIFICATION');
    expect(prompt).toContain('requires_user_input');
    expect(prompt).toContain('PROJECTS');
    expect(prompt).toContain('project_add_item');
    expect(prompt).toContain('NEVER invent ids');
    expect(prompt).toContain('YYYY-MM-DDTHH:mm');
  });

  it('documents every tool in the contract exactly once', () => {
    expect([...DOCUMENTED_TOOLS].sort()).toEqual([...TOOL_NAMES].sort());
    expect(new Set(DOCUMENTED_TOOLS).size).toBe(TOOL_NAMES.length);
    const prompt = buildSystemPrompt(minimalContext);
    for (const name of TOOL_NAMES) expect(prompt).toContain(`${name}(`);
  });

  it('stays within a sane size on a full context', () => {
    expect(buildSystemPrompt(fullContext).length).toBeLessThan(16_000);
  });
});

describe('few-shot examples', () => {
  it('has between 6 and 10 of them', () => {
    expect(FEW_SHOT_EXAMPLES.length).toBeGreaterThanOrEqual(6);
    expect(FEW_SHOT_EXAMPLES.length).toBeLessThanOrEqual(10);
  });

  it('every example output validates against the contract', () => {
    for (const example of FEW_SHOT_EXAMPLES) {
      const parsed = parseLlmResponse(JSON.parse(JSON.stringify(example.output)));
      if (!parsed.ok) throw new Error(`${example.input} -> ${parsed.issues.join('; ')}`);
      expect(parsed.ok).toBe(true);
    }
  });

  it('covers multi-intent, curriculum inference, buffers and clarification', () => {
    const outputs = FEW_SHOT_EXAMPLES.map((e) => e.output);
    expect(outputs.some((o) => (o.actions ?? []).length >= 3)).toBe(true);
    expect(JSON.stringify(outputs)).toContain('schedule_reason');
    expect(JSON.stringify(outputs)).toContain('needs_buffer');
    expect(outputs.some((o) => o.requires_user_input === true && (o.actions ?? []).length === 0)).toBe(
      true,
    );
  });

  it('embeds the examples in the prompt as compact JSON', () => {
    const prompt = buildSystemPrompt(minimalContext);
    for (const example of FEW_SHOT_EXAMPLES) {
      expect(prompt).toContain(`Input: ${example.input}`);
      expect(prompt).toContain(JSON.stringify(example.output));
    }
  });
});

describe('buildRetryPrompt', () => {
  it('restates the raw reply and every validation error', () => {
    const retry = buildRetryPrompt('{"actions": [{"tool_name": "nope"}]}', [
      'actions.0.tool_name: Invalid discriminator value',
      'actions.0.parameters: Required',
    ]);
    expect(retry).toContain('{"actions": [{"tool_name": "nope"}]}');
    expect(retry).toContain('- actions.0.tool_name: Invalid discriminator value');
    expect(retry).toContain('- actions.0.parameters: Required');
    expect(retry).toContain('corrected JSON object only');
  });

  it('truncates a runaway reply and survives an empty issue list', () => {
    const retry = buildRetryPrompt('x'.repeat(5000), []);
    expect(retry.length).toBeLessThan(2500);
    expect(retry).toContain('the reply was not a JSON object');
  });
});
