import { localToEpoch } from '@/core/time';
import {
  briefingTimeline,
  composeSpoken,
  composeVisual,
  wordCount,
  SPOKEN_WORD_CAP,
} from '@/features/briefing/compose';
import type {
  BriefingClass,
  BriefingCommitment,
  BriefingData,
  BriefingEvent,
  BriefingHabit,
  BriefingTask,
} from '@/features/briefing/collect';

const ZONE = 'Europe/Sofia';
const at = (local: string): number => localToEpoch(local, ZONE);
const NOW = at('2026-08-11T07:30');

function briefing(overrides: Partial<BriefingData> = {}): BriefingData {
  return {
    scope: 'today',
    now: NOW,
    zone: ZONE,
    date: '2026-08-11',
    window: { start: at('2026-08-11T00:00'), end: at('2026-08-12T00:00') },
    events: [],
    classes: [],
    overdueTasks: [],
    dueTasks: [],
    upcomingTasks: [],
    unlockedTasks: [],
    streaks: [],
    streaksAtRisk: [],
    commitments: [],
    focus: null,
    unsyncedCount: 0,
    ...overrides,
  };
}

function event(overrides: Partial<BriefingEvent> & { title: string; startsAt: number }): BriefingEvent {
  return {
    id: overrides.title,
    endsAt: overrides.startsAt + 3_600_000,
    allDay: false,
    location: null,
    kind: 'event',
    isBuffer: false,
    bufferFor: null,
    ...overrides,
  };
}

function lesson(subject: string, start: string, end: string): BriefingClass {
  return { subject, startsAt: at(start), endsAt: at(end), location: null, teacher: null };
}

function task(title: string, due: number | null): BriefingTask {
  return { id: title, title, dueDate: due, priority: 2, estimatedMinutes: null, projectId: null };
}

function habit(name: string, streak: number, atRisk = false): BriefingHabit {
  return { id: name, name, streak, lastLoggedDate: atRisk ? '2026-08-10' : '2026-08-11', atRisk };
}

function promise(overrides: Partial<BriefingCommitment> = {}): BriefingCommitment {
  return {
    id: 'c1',
    text: 'send the design file',
    personName: 'Ivo',
    direction: 'i_owe',
    dueDate: at('2026-08-11T17:00'),
    isOverdue: false,
    ...overrides,
  };
}

/** The spec's worked example, as data. */
const FULL = briefing({
  classes: [lesson('Math', '2026-08-11T10:00', '2026-08-11T11:30')],
  events: [
    event({ title: 'Project meeting with Ivo', startsAt: at('2026-08-11T15:00') }),
    event({
      title: 'Leave for Project meeting with Ivo',
      startsAt: at('2026-08-11T14:35'),
      endsAt: at('2026-08-11T15:00'),
      kind: 'buffer',
      isBuffer: true,
      bufferFor: 'Project meeting with Ivo',
    }),
  ],
  upcomingTasks: [task('Physics homework', at('2026-08-12T00:00'))],
  streaks: [habit('study', 4)],
});

describe('briefingTimeline', () => {
  it('orders classes and events together and folds buffers into what they precede', () => {
    const timeline = briefingTimeline(FULL);
    expect(timeline.map((item) => item.title)).toEqual(['Math', 'Project meeting with Ivo']);
    expect(timeline[1]!.leaveAt).toBe(at('2026-08-11T14:35'));
    expect(timeline[0]!.leaveAt).toBeNull();
  });

  it('drops a timetable slot that was also mirrored onto the calendar', () => {
    const data = briefing({
      classes: [lesson('Math', '2026-08-11T10:00', '2026-08-11T11:30')],
      events: [
        event({
          title: 'math',
          startsAt: at('2026-08-11T10:00'),
          endsAt: at('2026-08-11T11:30'),
          kind: 'class',
        }),
      ],
    });
    expect(briefingTimeline(data)).toHaveLength(1);
  });

  it('holds all-day events back so they cannot claim the next-up slot', () => {
    const data = briefing({
      events: [
        event({ title: 'Public holiday', startsAt: at('2026-08-11T00:00'), allDay: true }),
        event({ title: 'Dentist', startsAt: at('2026-08-11T09:00') }),
      ],
    });
    expect(briefingTimeline(data).map((item) => item.title)).toEqual(['Dentist']);
  });
});

describe('composeVisual', () => {
  it('produces exactly three bullets', () => {
    const bullets = composeVisual(FULL);
    expect(bullets).toHaveLength(3);
    for (const bullet of bullets) {
      expect(bullet.text.length).toBeGreaterThan(0);
      expect(bullet.text).not.toMatch(/undefined|NaN|null/);
      expect(bullet.text.endsWith('.')).toBe(true);
    }
  });

  it('leads with the next thing on the schedule and counts the rest', () => {
    expect(composeVisual(FULL)[0]).toEqual({
      icon: 'calendar',
      text: 'Math at 10:00, then 1 more.',
    });
  });

  it('says when to leave once a buffer is the next thing standing', () => {
    const [schedule] = composeVisual({ ...FULL, now: at('2026-08-11T13:00') });
    expect(schedule).toEqual({
      icon: 'travel',
      text: 'Leave at 14:35 for Project meeting with Ivo at 15:00.',
    });
  });

  it('reports the day as wrapped up once everything has finished', () => {
    const [schedule] = composeVisual({ ...FULL, now: at('2026-08-11T23:00') });
    expect(schedule.text).toBe('2 things today, all wrapped up.');
  });

  it('falls back to an all-day event when nothing is timed', () => {
    const [schedule] = composeVisual(
      briefing({
        events: [event({ title: 'Public holiday', startsAt: at('2026-08-11T00:00'), allDay: true })],
      }),
    );
    expect(schedule.text).toBe('Public holiday — all day.');
  });

  it('prefers overdue work over anything merely due', () => {
    const bullets = composeVisual(
      briefing({
        overdueTasks: [task('Return the library book', at('2026-08-09T12:00'))],
        dueTasks: [task('Physics homework', at('2026-08-11T18:00'))],
      }),
    );
    expect(bullets[1]).toEqual({ icon: 'overdue', text: 'Return the library book is overdue.' });
  });

  it('reads a midnight due date as a date, not as a time', () => {
    const bullets = composeVisual(
      briefing({ dueTasks: [task('Physics homework', at('2026-08-11T00:00'))] }),
    );
    expect(bullets[1]!.text).toBe('Physics homework is due today.');
  });

  it('names the due time when the user gave one', () => {
    const bullets = composeVisual(
      briefing({ dueTasks: [task('Physics homework', at('2026-08-11T18:00'))] }),
    );
    expect(bullets[1]!.text).toBe('Physics homework is due today at 18:00.');
  });

  it('offers the freshly unblocked task when nothing is due', () => {
    const bullets = composeVisual(briefing({ unlockedTasks: [task('Order the servos', null)] }));
    expect(bullets[1]).toEqual({ icon: 'task', text: 'Next up: Order the servos.' });
  });

  it('puts a streak about to lapse ahead of an open commitment', () => {
    const bullets = composeVisual(
      briefing({
        streaks: [habit('Running', 4, true)],
        streaksAtRisk: [habit('Running', 4, true)],
        commitments: [promise()],
      }),
    );
    expect(bullets[2]).toEqual({ icon: 'streak', text: 'Log Running to keep your 4-day streak.' });
  });

  it('names the commitment and its direction when no streak is at risk', () => {
    expect(composeVisual(briefing({ commitments: [promise()] }))[2]).toEqual({
      icon: 'promise',
      text: 'You owe Ivo: send the design file (today).',
    });
    expect(
      composeVisual(briefing({ commitments: [promise({ direction: 'they_owe' })] }))[2]!.text,
    ).toBe('Ivo owes you: send the design file (today).');
  });

  it('falls back to a running focus session, then to a clear line', () => {
    const withFocus = composeVisual(
      briefing({
        focus: {
          id: 'f1',
          label: 'Physics revision',
          subject: 'Physics',
          status: 'running',
          phase: 'focus',
          remainingMs: 12 * 60_000 + 30_000,
        },
      }),
    );
    expect(withFocus[2]).toEqual({
      icon: 'focus',
      text: 'Physics revision running — 12:30 left.',
    });
    expect(composeVisual(briefing())[2]).toEqual({
      icon: 'clear',
      text: 'No promises outstanding.',
    });
  });

  it('degrades to three real sentences on an empty day', () => {
    const bullets = composeVisual(briefing());
    expect(bullets.map((bullet) => bullet.text)).toEqual([
      'Nothing on your calendar today.',
      'Nothing due today.',
      'No promises outstanding.',
    ]);
  });

  it('adds the weekday when the scope is a whole week', () => {
    const data = briefing({
      scope: 'week',
      window: { start: at('2026-08-11T00:00'), end: at('2026-08-18T00:00') },
      events: [event({ title: 'Dentist', startsAt: at('2026-08-13T09:00') })],
    });
    expect(composeVisual(data)[0]!.text).toBe('Dentist on Thursday at 09:00.');
  });
});

describe('composeSpoken', () => {
  it('reads the worked example as one natural sentence plus the streak', () => {
    expect(composeSpoken(FULL)).toBe(
      'Good morning. You have Math at 10 AM, Project meeting with Ivo at 3 PM and your Physics homework is due tomorrow. ' +
        "You're on a 4-day study streak.",
    );
  });

  it('stays inside the hard word cap even with a crowded day', () => {
    const crowded = briefing({
      events: [
        event({ title: 'Standup with the robotics club', startsAt: at('2026-08-11T09:00') }),
        event({ title: 'Chemistry lab write-up review', startsAt: at('2026-08-11T11:00') }),
        event({ title: 'Project meeting with Ivo', startsAt: at('2026-08-11T15:00') }),
        event({ title: 'Football training at the north pitch', startsAt: at('2026-08-11T18:00') }),
        event({ title: 'Call grandma about the weekend', startsAt: at('2026-08-11T20:00') }),
      ],
      overdueTasks: [task('Return the library book to the school office', at('2026-08-09T12:00'))],
      streaks: [habit('Running', 12)],
      streaksAtRisk: [habit('Running', 12, true)],
      commitments: [promise({ text: 'the sponsorship letter for the competition' })],
    });
    const script = composeSpoken(crowded);
    expect(wordCount(script)).toBeLessThanOrEqual(SPOKEN_WORD_CAP);
    expect(script).not.toMatch(/undefined|NaN/);
  });

  it('lands in the fifteen-second range for a typical day', () => {
    const words = wordCount(
      composeSpoken(
        briefing({
          classes: [
            lesson('Math', '2026-08-11T10:00', '2026-08-11T11:30'),
            lesson('Physics', '2026-08-11T12:00', '2026-08-11T13:30'),
          ],
          events: [event({ title: 'Project meeting with Ivo', startsAt: at('2026-08-11T15:00') })],
          dueTasks: [task('Physics homework', at('2026-08-11T20:00'))],
          streaks: [habit('study', 4)],
          commitments: [promise()],
        }),
      ),
    );
    expect(words).toBeGreaterThanOrEqual(30);
    expect(words).toBeLessThanOrEqual(SPOKEN_WORD_CAP);
  });

  it('greets by time of day', () => {
    expect(composeSpoken(briefing({ now: at('2026-08-11T14:00') }))).toMatch(/^Good afternoon\./);
    expect(composeSpoken(briefing({ now: at('2026-08-11T21:00') }))).toMatch(/^Good evening\./);
  });

  it('gives an empty day an encouraging one-liner rather than "undefined"', () => {
    const script = composeSpoken(briefing());
    expect(script).toBe(
      'Good morning. Nothing scheduled today and nothing due — the day is yours.',
    );
    expect(script).not.toMatch(/undefined|NaN|null/);
  });

  it('points at the next unblocked step when the calendar is empty', () => {
    expect(composeSpoken(briefing({ unlockedTasks: [task('Order the servos', null)] }))).toBe(
      'Good morning. Nothing is scheduled today, so the next step is Order the servos.',
    );
  });

  it('opens on the due item when there is nothing scheduled', () => {
    expect(
      composeSpoken(briefing({ dueTasks: [task('Physics homework', at('2026-08-11T20:00'))] })),
    ).toBe('Good morning. Your Physics homework is due today at 8 PM.');
  });

  it('is deterministic for the same data', () => {
    expect(composeSpoken(FULL)).toBe(composeSpoken(FULL));
    expect(composeVisual(FULL)).toEqual(composeVisual(FULL));
  });

  it('matches the recorded snapshot', () => {
    expect({ bullets: composeVisual(FULL), spoken: composeSpoken(FULL) }).toMatchSnapshot();
  });
});
