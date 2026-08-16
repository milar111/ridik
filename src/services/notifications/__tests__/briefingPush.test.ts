import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { localToEpoch } from '@/core/time';
import type { Briefing } from '@/features/briefing';
import { composeVisual } from '@/features/briefing/compose';
import type {
  BriefingCommitment,
  BriefingData,
  BriefingEvent,
  BriefingHabit,
  BriefingTask,
} from '@/features/briefing/collect';
import {
  BRIEFING_HREF,
  BRIEFING_TAG_KEYS,
  PUSH_BLOCKED_SEGMENTS,
  PUSH_ROUTE_SEGMENTS,
  briefingPushBody,
  briefingPushTags,
  dueForRefresh,
  pushAppId,
  resolvePushHref,
  shouldOptIn,
  tagsChanged,
  type BriefingTags,
} from '@/services/notifications/briefingPush';

const ZONE = 'Europe/Sofia';
const at = (local: string): number => localToEpoch(local, ZONE);
const NOW = at('2026-08-11T07:30');

function data(overrides: Partial<BriefingData> = {}): BriefingData {
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

function event(
  overrides: Partial<BriefingEvent> & { title: string; startsAt: number },
): BriefingEvent {
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

const task = (title: string, due: number | null): BriefingTask => ({
  id: title,
  title,
  dueDate: due,
  priority: 2,
  estimatedMinutes: null,
  projectId: null,
});

const habit = (name: string, streak: number, atRisk = false): BriefingHabit => ({
  id: name,
  name,
  streak,
  lastLoggedDate: atRisk ? '2026-08-10' : '2026-08-11',
  atRisk,
});

const promise = (overrides: Partial<BriefingCommitment> = {}): BriefingCommitment => ({
  id: 'c1',
  text: 'send the design file',
  personName: 'Ivo',
  direction: 'i_owe',
  dueDate: at('2026-08-11T17:00'),
  isOverdue: false,
  ...overrides,
});

/**
 * Built through the real `composeVisual`, never from hand-written bullets.
 *
 * The point of this whole module is that a push cannot word the day differently
 * from the card, and a fixture that invents its own bullets would test the
 * opposite — it would keep passing after the two drifted apart.
 */
const briefing = (overrides: Partial<BriefingData> = {}): Briefing => {
  const collected = data(overrides);
  return { data: collected, bullets: composeVisual(collected), spoken: '' };
};

/* ------------------------------------------------------------------ body -- */

describe('briefingPushBody', () => {
  it('says only what the day actually holds', () => {
    const { bullets } = briefing({
      events: [event({ title: 'Dentist', startsAt: at('2026-08-11T10:00') })],
    });

    const body = briefingPushBody(bullets);

    expect(body).toContain('Dentist at 10:00');
    // Bullets two and three are "Nothing due today." / "No promises
    // outstanding." — true, and the fastest way to train a swipe-away.
    expect(body).not.toMatch(/Nothing due/);
    expect(body).not.toMatch(/No promises/);
  });

  it('repeats the card word for word', () => {
    const { bullets } = briefing({
      events: [event({ title: 'Dentist', startsAt: at('2026-08-11T10:00') })],
      overdueTasks: [task('Physics homework', at('2026-08-10T18:00'))],
      streaksAtRisk: [habit('Reading', 12, true)],
    });

    const body = briefingPushBody(bullets);

    for (const bullet of bullets) expect(body).toContain(bullet.text);
  });

  it('leaves an empty day as one honest sentence', () => {
    const { bullets } = briefing();

    const body = briefingPushBody(bullets);

    // Not "Nothing on your calendar today. Nothing due today. No promises
    // outstanding." — the two filler lines are what a reader learns to ignore.
    expect(body).toBe('Nothing on your calendar today.');
    expect(body).not.toContain(bullets[1].text);
    expect(body).not.toContain(bullets[2].text);
  });

  it('leads with the schedule even when the day is only tasks', () => {
    const { bullets } = briefing({
      overdueTasks: [task('Physics homework', at('2026-08-10T18:00'))],
    });

    expect(briefingPushBody(bullets)).toBe(
      'Nothing on your calendar today. Physics homework is overdue.',
    );
  });

  it('drops a whole trailing sentence rather than cutting one in half', () => {
    const { bullets } = briefing({
      events: [event({ title: 'Dentist', startsAt: at('2026-08-11T10:00') })],
      overdueTasks: [task('Physics homework', at('2026-08-10T18:00'))],
      streaksAtRisk: [habit('Reading', 12, true)],
    });

    const body = briefingPushBody(bullets, bullets[0].text.length + 4);

    expect(body).toBe(bullets[0].text);
    expect(body.endsWith('.')).toBe(true);
  });

  it('keeps the first sentence whole even when it alone is over the cap', () => {
    const { bullets } = briefing({
      events: [event({ title: 'Dentist', startsAt: at('2026-08-11T10:00') })],
    });

    expect(briefingPushBody(bullets, 5)).toBe(bullets[0].text);
  });
});

/* ------------------------------------------------------------------ tags -- */

describe('briefingPushTags', () => {
  it('publishes exactly the keys it claims to own, all as strings', () => {
    const tags = briefingPushTags(briefing());

    expect(Object.keys(tags).sort()).toEqual([...BRIEFING_TAG_KEYS].sort());
    for (const value of Object.values(tags)) expect(typeof value).toBe('string');
  });

  it('carries the same line the card is showing', () => {
    const full = briefing({
      events: [event({ title: 'Dentist', startsAt: at('2026-08-11T10:00') })],
    });

    const tags = briefingPushTags(full);

    expect(tags.briefing_line).toBe(briefingPushBody(full.bullets));
    expect(tags.briefing_headline).toBe(full.bullets[0].text);
  });

  it('counts real events, not travel buffers', () => {
    const tags = briefingPushTags(
      briefing({
        events: [
          event({ title: 'Dentist', startsAt: at('2026-08-11T10:00') }),
          event({
            title: 'Leave for Dentist',
            startsAt: at('2026-08-11T09:30'),
            isBuffer: true,
            bufferFor: 'Dentist',
          }),
        ],
      }),
    );

    expect(tags.briefing_events).toBe('1');
  });

  it('folds overdue into the due count and reports it separately', () => {
    const tags = briefingPushTags(
      briefing({
        overdueTasks: [task('Physics homework', at('2026-08-10T18:00'))],
        dueTasks: [task('Book the car in', at('2026-08-11T17:00'))],
      }),
    );

    expect(tags.briefing_due).toBe('2');
    expect(tags.briefing_overdue).toBe('1');
  });

  it('marks a genuinely empty day quiet, so a segment can skip the send', () => {
    expect(briefingPushTags(briefing()).briefing_quiet).toBe('1');
  });

  it('is not quiet when a streak is one missed day from ending', () => {
    const tags = briefingPushTags(briefing({ streaksAtRisk: [habit('Reading', 12, true)] }));

    expect(tags.briefing_quiet).toBe('0');
    expect(tags.briefing_streak_risk).toBe('1');
  });

  it('is not quiet when a promise is outstanding', () => {
    expect(briefingPushTags(briefing({ commitments: [promise()] })).briefing_quiet).toBe('0');
  });

  it("reports Ridik's own zone, which the device may disagree with", () => {
    const tags = briefingPushTags(briefing({ zone: 'America/New_York' }));

    expect(tags.briefing_zone).toBe('America/New_York');
    expect(tags.briefing_date).toBe('2026-08-11');
  });
});

describe('tagsChanged', () => {
  const tags = (overrides: Partial<BriefingTags> = {}): BriefingTags => ({
    ...briefingPushTags(briefing()),
    ...overrides,
  });

  it('is true when nothing has ever been published', () => {
    expect(tagsChanged(null, tags())).toBe(true);
  });

  it('is false for an identical day, so a foreground switch costs no upload', () => {
    expect(tagsChanged(tags(), tags())).toBe(false);
  });

  it('is true across midnight even when the words are the same', () => {
    expect(tagsChanged(tags(), tags({ briefing_date: '2026-08-12' }))).toBe(true);
  });
});

describe('dueForRefresh', () => {
  it('always allows the first refresh', () => {
    expect(dueForRefresh(null, 1_000, 60_000)).toBe(true);
  });

  it('swallows the burst of app-state changes iOS emits for one switch', () => {
    expect(dueForRefresh(1_000, 1_200, 60_000)).toBe(false);
  });

  it('allows one through once the interval has passed', () => {
    expect(dueForRefresh(1_000, 61_000, 60_000)).toBe(true);
  });

  it('does not lock out refreshing when the clock goes backwards', () => {
    expect(dueForRefresh(10_000, 1_000, 60_000)).toBe(true);
  });
});

/* ----------------------------------------------------------- subscription -- */

describe('shouldOptIn', () => {
  it('never opts in without permission — optIn() would raise the dialog', () => {
    expect(shouldOptIn(false, false)).toBe(false);
  });

  it('repairs a device that opted out under an earlier build', () => {
    expect(shouldOptIn(true, false)).toBe(true);
  });

  it('leaves an already-subscribed device alone', () => {
    expect(shouldOptIn(true, true)).toBe(false);
  });
});

describe('pushAppId', () => {
  it('is null when nothing is configured', () => {
    expect(pushAppId(undefined)).toBeNull();
    expect(pushAppId({})).toBeNull();
    expect(pushAppId({ oneSignal: {} })).toBeNull();
  });

  it('treats the empty string app.config.ts defaults to as unset', () => {
    expect(pushAppId({ oneSignal: { appId: '' } })).toBeNull();
    expect(pushAppId({ oneSignal: { appId: '   ' } })).toBeNull();
  });

  it('ignores a value of the wrong shape rather than initialising against it', () => {
    expect(pushAppId({ oneSignal: { appId: 42 } })).toBeNull();
    expect(pushAppId('not-an-object')).toBeNull();
  });

  it('trims what it returns', () => {
    expect(pushAppId({ oneSignal: { appId: ' abc-123 ' } })).toBe('abc-123');
  });
});

/* ------------------------------------------------------------------ href -- */

describe('resolvePushHref', () => {
  it('follows the href the dashboard put in the payload', () => {
    expect(resolvePushHref({ data: { href: '/tasks' } })).toBe('/tasks');
  });

  it('falls back to the briefing when the payload says nothing', () => {
    expect(resolvePushHref({})).toBe(BRIEFING_HREF);
    expect(resolvePushHref({ data: {} })).toBe(BRIEFING_HREF);
    expect(resolvePushHref({ data: null })).toBe(BRIEFING_HREF);
  });

  it('uses the launch URL only when there is no href', () => {
    expect(resolvePushHref({ url: 'ridik:///habits' })).toBe('/habits');
    expect(resolvePushHref({ data: { href: '/tasks' }, url: 'ridik:///habits' })).toBe('/tasks');
  });

  it('accepts both shapes of the app scheme', () => {
    expect(resolvePushHref({ data: { href: 'ridik:///briefing' } })).toBe('/briefing');
    expect(resolvePushHref({ data: { href: 'ridik://briefing' } })).toBe('/briefing');
  });

  it('keeps a query string — the app has deep links that need one', () => {
    expect(resolvePushHref({ data: { href: '/notes?pane=lists&list=Hardware' } })).toBe(
      '/notes?pane=lists&list=Hardware',
    );
    expect(resolvePushHref({ data: { href: '/plans?pane=curriculum' } })).toBe(
      '/plans?pane=curriculum',
    );
  });

  /**
   * Home stays openable and the verb does not.
   *
   * `?speak=1` used to be a meaningless parameter, which is why it stood in the
   * test above as an example of a query string surviving. It is now the address
   * a widget, the launcher long-press, the Control Center button and the Quick
   * Settings tile use to open the microphone — so that same assertion had
   * quietly become "a message anybody can send you may start recording". A
   * blocked segment cannot fix it, because the segment is home.
   */
  it('will not let a message somebody sends you switch the microphone on', () => {
    for (const href of [
      '/?speak=1',
      'ridik:///?speak=1',
      '/?speak=0',
      '/tasks?speak=1',
      '/notes?pane=lists&speak=true',
      // Decoded before it is compared: every query parser reads this as `speak`.
      '/?%73peak=1',
    ]) {
      expect(resolvePushHref({ data: { href } }, null)).toBeNull();
    }

    // The route itself is untouched — a briefing may still open home.
    expect(resolvePushHref({ data: { href: '/' } }, null)).toBe('/');
  });

  it('refuses to leave the app', () => {
    for (const href of [
      'https://example.com/briefing',
      '//example.com/briefing',
      'javascript:alert(1)',
      'mailto:someone@example.com',
      'briefing',
    ]) {
      expect(resolvePushHref({ data: { href } }, null)).toBeNull();
    }
  });

  it('refuses a route that does not exist', () => {
    expect(resolvePushHref({ data: { href: '/wallet' } }, null)).toBeNull();
  });

  it('will not open the developer screen from a message somebody can send you', () => {
    expect(resolvePushHref({ data: { href: '/developer' } }, null)).toBeNull();
    expect(resolvePushHref({ data: { href: 'ridik:///developer' } }, null)).toBeNull();
  });

  /* A full-screen "Allow" that a stranger's message can open is the shape of
     every consent-farming attack there is. The screen is reached from the first
     run, from Settings, and from the app's own refusal notice — all three of
     which are the user already looking at Ridik. */
  it('will not open the consent screen from a message somebody can send you', () => {
    expect(resolvePushHref({ data: { href: '/consent' } }, null)).toBeNull();
    expect(resolvePushHref({ data: { href: 'ridik:///consent' } }, null)).toBeNull();
  });

  it('returns null rather than guessing when the caller offers no fallback', () => {
    expect(resolvePushHref({}, null)).toBeNull();
  });

  it('ignores an href of the wrong type', () => {
    expect(resolvePushHref({ data: { href: 42 } }, null)).toBeNull();
    expect(resolvePushHref({ data: { href: '   ' } }, null)).toBeNull();
  });
});

/**
 * The allow-list is hand-written — nothing at runtime can enumerate expo-router's
 * routes — so this is what stops it drifting. A screen added to `app/` and not
 * added here is simply unreachable from a push, and nothing else would say so.
 */
describe('PUSH_ROUTE_SEGMENTS', () => {
  it('is every route in app/, minus the ones deliberately kept out', () => {
    const dir = resolve(__dirname, '../../../../app');
    const onDisk = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.name !== '_layout.tsx' && !entry.name.endsWith('.test.tsx'))
      .filter((entry) => entry.isDirectory() || entry.name.endsWith('.tsx'))
      .map((entry) => (entry.isDirectory() ? entry.name : entry.name.replace(/\.tsx$/, '')))
      .map((name) => (name === 'index' ? '' : name));

    const expected = onDisk.filter((name) => !PUSH_BLOCKED_SEGMENTS.includes(name));

    expect([...PUSH_ROUTE_SEGMENTS].sort()).toEqual(expected.sort());
  });
});
