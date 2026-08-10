import { localToEpoch } from '@/core/time';
import type { ActivityEntry, ChecklistItem, Note, Project, ProjectItem, Task, Transaction } from '@/db/schema';
import type { ActivitySummary } from '@/repositories/activity';
import type { LedgerQueryResult } from '@/repositories/ledger';
import type { ProjectOverview } from '@/repositories/projects';
import type { BriefingData } from '@/features/briefing/collect';
import {
  briefingMarkdown,
  escapeHtml,
  escapeMarkdown,
  ledgerMarkdown,
  markdownToHtml,
  projectMarkdown,
  weeklyStandup,
} from '@/features/export/markdown';

const ZONE = 'Europe/Sofia';
const at = (local: string): number => localToEpoch(local, ZONE);

/** A title carrying every character that can break a markdown document. */
const HOSTILE = 'Budget | Q3 # notes *starred* _under_ [link] <b> `code`';

function entry(overrides: Partial<ActivityEntry> & { id: string; localDate: string }): ActivityEntry {
  return {
    habitId: null,
    description: 'Did a thing',
    durationMinutes: null,
    loggedAt: at(`${overrides.localDate}T09:00`),
    projectId: null,
    source: 'voice',
    ...overrides,
  };
}

function summary(): ActivitySummary {
  const monday = [
    entry({ id: 'a1', localDate: '2026-08-03', description: 'Wrote the report', durationMinutes: 45 }),
    entry({ id: 'a2', localDate: '2026-08-03', description: 'Ran', durationMinutes: 30 }),
  ];
  const tuesday = [entry({ id: 'a3', localDate: '2026-08-04', description: HOSTILE })];
  return {
    entries: [...monday, ...tuesday],
    totalMinutes: 75,
    byDay: [
      { date: '2026-08-03', entries: monday, minutes: 75 },
      { date: '2026-08-04', entries: tuesday, minutes: 0 },
    ],
    byProject: [{ id: 'p1', name: 'Robotics | club', count: 2, minutes: 75 }],
    byHabit: [{ id: 'h1', name: 'Running', count: 1, minutes: 30 }],
  };
}

describe('escapeMarkdown', () => {
  it('neutralises every structural character', () => {
    expect(escapeMarkdown(HOSTILE)).toBe(
      'Budget \\| Q3 \\# notes \\*starred\\* \\_under\\_ \\[link\\] \\<b\\> \\`code\\`',
    );
  });

  it('collapses newlines so a cell cannot escape its row', () => {
    expect(escapeMarkdown('one\ntwo\n\nthree ')).toBe('one two three');
  });

  it('escapes the backslash itself before anything else', () => {
    expect(escapeMarkdown('C:\\Users\\*')).toBe('C:\\\\Users\\\\\\*');
  });
});

describe('weeklyStandup', () => {
  const md = weeklyStandup(summary(), { zone: ZONE });

  it('groups entries under a day heading with the day total', () => {
    expect(md).toContain('## Monday 3 Aug — 1h 15m');
    expect(md).toContain('- Wrote the report (45m)');
    expect(md).toContain('- Ran (30m)');
    expect(md).toContain('## Tuesday 4 Aug');
  });

  it('omits a duration the user never gave', () => {
    expect(md).not.toContain('(0m)');
  });

  it('reports the totals and the per-project breakdown', () => {
    expect(md).toContain('- Tracked: 1h 15m');
    expect(md).toContain('- Entries: 3');
    expect(md).toContain('- Days active: 2');
    expect(md).toContain('| Project | Entries | Time |');
    expect(md).toContain('| Robotics \\| club | 2 | 1h 15m |');
    expect(md).toContain('| Habit | Entries | Time |');
  });

  it('keeps every table row to the same number of unescaped pipes', () => {
    const rows = md.split('\n').filter((line) => line.startsWith('|'));
    const columns = rows.map((row) => row.replace(/\\\|/g, '').split('|').length);
    expect(new Set(columns).size).toBe(1);
  });

  it('says so plainly when nothing was logged', () => {
    const empty = weeklyStandup(
      { entries: [], totalMinutes: 0, byDay: [], byProject: [], byHabit: [] },
      { zone: ZONE },
    );
    expect(empty).toBe('# Weekly standup\n\n_No activity logged in this period._\n');
  });

  it('matches the recorded snapshot', () => {
    expect(md).toMatchSnapshot();
  });
});

/* -------------------------------------------------------------- briefing -- */

function briefingData(): BriefingData {
  return {
    scope: 'today',
    now: at('2026-08-11T07:30'),
    zone: ZONE,
    date: '2026-08-11',
    window: { start: at('2026-08-11T00:00'), end: at('2026-08-12T00:00') },
    events: [
      {
        id: 'e1',
        title: 'Project meeting with Ivo',
        startsAt: at('2026-08-11T15:00'),
        endsAt: at('2026-08-11T16:00'),
        allDay: false,
        location: 'Cafe | Central',
        kind: 'event',
        isBuffer: false,
        bufferFor: null,
      },
      {
        id: 'e2',
        title: 'Leave for Project meeting with Ivo',
        startsAt: at('2026-08-11T14:35'),
        endsAt: at('2026-08-11T15:00'),
        allDay: false,
        location: null,
        kind: 'buffer',
        isBuffer: true,
        bufferFor: 'Project meeting with Ivo',
      },
    ],
    classes: [
      {
        subject: 'Math',
        startsAt: at('2026-08-11T10:00'),
        endsAt: at('2026-08-11T11:30'),
        location: 'Room 3',
        teacher: null,
      },
    ],
    overdueTasks: [
      { id: 't1', title: 'Return the book', dueDate: at('2026-08-09T12:00'), priority: 1, estimatedMinutes: null, projectId: null },
    ],
    dueTasks: [
      { id: 't2', title: HOSTILE, dueDate: at('2026-08-11T18:00'), priority: 2, estimatedMinutes: 30, projectId: null },
    ],
    upcomingTasks: [],
    unlockedTasks: [
      { id: 't3', title: 'Order the servos', dueDate: null, priority: 2, estimatedMinutes: null, projectId: null },
    ],
    streaks: [{ id: 'h1', name: 'Running', streak: 4, lastLoggedDate: '2026-08-10', atRisk: true }],
    streaksAtRisk: [{ id: 'h1', name: 'Running', streak: 4, lastLoggedDate: '2026-08-10', atRisk: true }],
    commitments: [
      {
        id: 'c1',
        text: 'send the design file',
        personName: 'Ivo',
        direction: 'i_owe',
        dueDate: at('2026-08-11T17:00'),
        isOverdue: false,
      },
    ],
    focus: null,
    unsyncedCount: 2,
  };
}

describe('briefingMarkdown', () => {
  const md = briefingMarkdown(briefingData());

  it('renders the day in schedule order and labels the buffer as travel time', () => {
    const schedule = md.slice(md.indexOf('## Schedule'), md.indexOf('## Overdue'));
    expect(schedule).toContain('- 10:00–11:30 Math · Room 3 _(class)_');
    expect(schedule).toContain('- 14:35–15:00 Leave for Project meeting with Ivo _(travel time for Project meeting with Ivo)_');
    expect(schedule.indexOf('10:00')).toBeLessThan(schedule.indexOf('14:35'));
    expect(schedule.indexOf('14:35')).toBeLessThan(schedule.indexOf('15:00–16:00'));
  });

  it('separates overdue, due and unblocked work', () => {
    expect(md).toContain('## Overdue');
    expect(md).toContain('- [ ] Return the book — due Sun 9 Aug, 12:00');
    expect(md).toContain('## Due');
    expect(md).toContain('## Unblocked');
    expect(md).toContain('- [ ] Order the servos');
  });

  it('flags a streak at risk and the outstanding promise', () => {
    expect(md).toContain('- Running — 4 days _(at risk today)_');
    expect(md).toContain('- You owe Ivo: send the design file — Tue 11 Aug, 17:00');
  });

  it('mentions the unsynced backlog', () => {
    expect(md).toContain('_2 changes still waiting to sync._');
  });

  it('escapes a hostile task title', () => {
    expect(md).toContain('Budget \\| Q3 \\# notes');
    expect(md).not.toMatch(/^# notes/m);
  });

  it('does not pretend an empty day is full', () => {
    const empty = briefingMarkdown({
      ...briefingData(),
      events: [],
      classes: [],
      overdueTasks: [],
      dueTasks: [],
      upcomingTasks: [],
      unlockedTasks: [],
      streaks: [],
      streaksAtRisk: [],
      commitments: [],
      unsyncedCount: 0,
    });
    expect(empty).toBe('# Today — Tuesday 11 Aug\n\n_Nothing scheduled and nothing due._\n');
  });
});

/* --------------------------------------------------------------- project -- */

function project(): Project {
  return {
    id: 'p1',
    name: 'Robot arm',
    kind: 'project',
    description: 'Build the arm before the * competition *',
    status: 'active',
    startDate: null,
    targetDate: at('2026-09-01T00:00'),
    color: null,
    emoji: '🤖',
    createdAt: at('2026-08-01T09:00'),
    updatedAt: at('2026-08-10T09:00'),
  };
}

function item(overrides: Partial<ProjectItem> & { id: string; content: string }): ProjectItem {
  return {
    projectId: 'p1',
    sectionId: null,
    kind: 'todo',
    detail: null,
    isCheckbox: true,
    isCompleted: false,
    completedAt: null,
    orderIndex: 0,
    dueDate: null,
    createdAt: at('2026-08-01T09:00'),
    updatedAt: at('2026-08-01T09:00'),
    ...overrides,
  };
}

function overview(): ProjectOverview {
  return {
    project: project(),
    sections: [
      { section: null, items: [item({ id: 'i0', content: 'Sketch the gripper', isCheckbox: false })] },
      {
        section: { id: 's1', projectId: 'p1', title: 'Parts', orderIndex: 0, createdAt: 0 },
        items: [
          item({ id: 'i1', content: 'Print the frame', isCompleted: true }),
          item({ id: 'i2', content: HOSTILE, detail: 'from the club budget', dueDate: at('2026-08-20T00:00') }),
        ],
      },
    ],
    counts: { total: 3, done: 1, openTodos: 2 },
    linked: {
      tasks: [
        {
          id: 't1',
          title: 'Order the servos',
          dueDate: at('2026-08-15T00:00'),
          isCompleted: false,
          isLocked: true,
          createdAt: 0,
          notes: null,
          projectId: 'p1',
          priority: 2,
          estimatedMinutes: null,
          completedAt: null,
          unlockedAt: null,
          calendarEventId: null,
          source: 'voice',
          updatedAt: 0,
        } satisfies Task,
      ],
      notes: [
        {
          id: 'n1',
          titleSummary: 'Servo spec',
          categoryTag: 'robotics',
          createdAt: 0,
          updatedAt: 0,
          projectId: 'p1',
          isPinned: false,
          isArchived: false,
        } satisfies Note,
      ],
      checklists: [
        {
          id: 'c1',
          listName: 'Hardware',
          itemText: 'M3 bolts',
          isCompleted: false,
          createdAt: 0,
          quantity: '20',
          projectId: 'p1',
          orderIndex: 0,
          completedAt: null,
        } satisfies ChecklistItem,
      ],
      transactions: [
        {
          id: 'x1',
          amount: 42.5,
          currency: 'EUR',
          category: 'parts',
          entityName: null,
          description: null,
          createdAt: at('2026-08-05T12:00'),
          direction: 'expense',
          projectId: 'p1',
          localDate: '2026-08-05',
        } satisfies Transaction,
      ],
    },
  };
}

describe('projectMarkdown', () => {
  const md = projectMarkdown(overview(), { zone: ZONE });

  it('leads with the emoji, the name and the progress meta line', () => {
    expect(md.startsWith('# 🤖 Robot arm\n')).toBe(true);
    expect(md).toContain('_project · active · target 1 Sep 2026 · 1/3 done · 2 open todos_');
  });

  it('renders un-sectioned items first and then each section', () => {
    expect(md.indexOf('## Items')).toBeLessThan(md.indexOf('## Parts'));
    expect(md).toContain('- Sketch the gripper');
    expect(md).toContain('- [x] Print the frame');
  });

  it('carries detail and due date onto the item line', () => {
    expect(md).toContain('— from the club budget (due 20 Aug 2026)');
  });

  it('lists everything merely linked to the project', () => {
    expect(md).toContain('- [ ] Order the servos — due 15 Aug 2026 _(blocked)_');
    expect(md).toContain('- Servo spec _(robotics)_');
    expect(md).toContain('- [ ] M3 bolts ×20 _(Hardware)_');
    expect(md).toContain('| 5 Aug 2026 | parts | −€42.50 |');
  });

  it('escapes the description and the hostile item', () => {
    expect(md).toContain('Build the arm before the \\* competition \\*');
    expect(md).toContain('Budget \\| Q3');
  });

  it('matches the recorded snapshot', () => {
    expect(md).toMatchSnapshot();
  });
});

/* ---------------------------------------------------------------- ledger -- */

function ledger(): LedgerQueryResult {
  return {
    total: 240,
    count: 12,
    from: at('2026-08-01T00:00'),
    to: at('2026-09-01T00:00'),
    primaryCurrency: 'EUR',
    totalsByCurrency: { EUR: 240, USD: 30 },
    expenseByCurrency: { EUR: 240, USD: 30 },
    incomeByCurrency: { EUR: 50 },
    netByCurrency: { EUR: -190, USD: -30 },
    groups: [
      { key: 'groceries | co-op', total: 180, count: 8, totalsByCurrency: { EUR: 180 }, expenseByCurrency: { EUR: 180 }, incomeByCurrency: {} },
      { key: 'books', total: 60, count: 4, totalsByCurrency: { EUR: 60, USD: 30 }, expenseByCurrency: { EUR: 60, USD: 30 }, incomeByCurrency: {} },
    ],
  };
}

describe('ledgerMarkdown', () => {
  const md = ledgerMarkdown(ledger(), { zone: ZONE });

  it('reports the inclusive period the user actually asked about', () => {
    expect(md).toContain('_1 Aug 2026 – 31 Aug 2026 · 12 transactions_');
  });

  it('gives every currency its own row rather than one impossible total', () => {
    expect(md).toContain('| EUR | €240.00 | €50.00 | −€190.00 |');
    expect(md).toContain('| USD | $30.00 | $0.00 | −$30.00 |');
  });

  it('keeps a multi-currency group honest', () => {
    expect(md).toContain('| books | 4 | €60.00 + $30.00 |');
  });

  it('escapes a category the user dictated with a pipe in it', () => {
    expect(md).toContain('| groceries \\| co-op | 8 | €180.00 |');
  });

  it('says nothing was recorded rather than printing an empty table', () => {
    const empty = ledgerMarkdown(
      {
        total: 0,
        count: 0,
        from: null,
        to: null,
        primaryCurrency: null,
        totalsByCurrency: {},
        expenseByCurrency: {},
        incomeByCurrency: {},
        netByCurrency: {},
        groups: [],
      },
      { zone: ZONE },
    );
    expect(empty).toContain('_All time · 0 transactions_');
    expect(empty).toContain('_Nothing recorded in this period._');
  });
});

/* ------------------------------------------------------------------ html -- */

describe('markdownToHtml', () => {
  it('escapes HTML entities in user text', () => {
    const html = markdownToHtml(`# ${escapeMarkdown('<script>alert("x")</script>')}`);
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('escapes the document title too', () => {
    expect(markdownToHtml('# Hi', { title: '<b>Report</b>' })).toContain(
      '<title>&lt;b&gt;Report&lt;/b&gt;</title>',
    );
  });

  it('converts headings, bullets and checkboxes', () => {
    const html = markdownToHtml('## Due\n\n- [ ] Buy milk\n- [x] Print frame');
    expect(html).toContain('<h2>Due</h2>');
    expect(html).toContain('<li>☐ Buy milk</li>');
    expect(html).toContain('<li>☑ Print frame</li>');
  });

  it('converts a table and drops the divider row', () => {
    const html = markdownToHtml('| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(html).toContain('<thead><tr><th>A</th><th>B</th></tr></thead>');
    expect(html).toContain('<tbody><tr><td>1</td><td>2</td></tr></tbody>');
    expect(html).not.toContain('---');
  });

  it('keeps an escaped pipe inside its cell', () => {
    const html = markdownToHtml(`| Group | Total |\n| --- | --- |\n| ${escapeMarkdown('a|b')} | 1 |`);
    expect(html).toContain('<td>a|b</td>');
  });

  it('never reads an escaped asterisk back as emphasis', () => {
    const html = markdownToHtml(`- ${escapeMarkdown('**not bold**')}`);
    expect(html).toContain('<li>**not bold**</li>');
    expect(html).not.toContain('<strong>');
  });

  it('does render the emphasis the generators themselves emit', () => {
    expect(markdownToHtml('_1 Aug – 7 Aug_')).toContain('<p><em>1 Aug – 7 Aug</em></p>');
    expect(markdownToHtml('- late **overdue**')).toContain('<li>late <strong>overdue</strong></li>');
  });

  it('survives a full generated document without leaking raw markup', () => {
    const html = markdownToHtml(briefingMarkdown(briefingData()), { title: 'Today' });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Budget | Q3 # notes');
    expect(html.split('<body>')[1]).not.toContain('<b>');
  });
});

describe('escapeHtml', () => {
  it('covers the five characters that matter', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});
