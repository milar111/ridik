/**
 * Turning a `BriefingData` into words.
 *
 * Pure and clock-free: "now" and the zone arrive on the data object, so the
 * same briefing always produces the same bytes and both shapes are
 * snapshot-testable under plain Node.
 *
 * Two shapes, because a card and a voice line want opposite things. The card
 * gets exactly three scannable bullets with 24-hour times — the spec's
 * three-bullet briefing card. The script gets one flowing paragraph with times
 * a person would actually say, capped hard so it cannot outstay its welcome
 * while the user is halfway out of the door.
 */
import { countLabel, joinNatural, truncate } from '@/core/format';
import {
  epochToLocal,
  formatClock,
  formatDayHeading,
  formatTime,
  formatSpokenTime,
} from '@/core/time';

import type { BriefingData, BriefingScope, BriefingTask } from './collect';

export type BriefingIcon =
  | 'calendar'
  | 'travel'
  | 'task'
  | 'overdue'
  | 'streak'
  | 'promise'
  | 'focus'
  | 'clear';

export type BriefingBullet = { icon: BriefingIcon; text: string };

/** Exactly three: the schedule, the thing due, and the streak/commitment line. */
export type BriefingBullets = readonly [BriefingBullet, BriefingBullet, BriefingBullet];

/** Roughly fifteen seconds of speech. Beyond this the user has stopped listening. */
export const SPOKEN_WORD_CAP = 60;

const MAX_SPOKEN_ITEMS = 3;
const CARD_TITLE_LIMIT = 48;
const SPOKEN_TITLE_LIMIT = 36;

const SCOPE_WORD: Record<BriefingScope, string> = {
  today: 'today',
  tomorrow: 'tomorrow',
  week: 'this week',
};

/** Only these read naturally in lower case; a real date does not. */
const RELATIVE_DAYS = new Set(['Today', 'Tomorrow', 'Yesterday']);

type TimelineItem = {
  title: string;
  startsAt: number;
  endsAt: number;
  location: string | null;
  /** Start of the travel/prep block that precedes it, when the day has one. */
  leaveAt: number | null;
};

/**
 * Classes and calendar events merged into one time-ordered list.
 *
 * Buffers are folded into the thing they exist for rather than listed, and an
 * all-day event is held back: it has no time, so it would otherwise sort to
 * midnight and claim the "next up" slot from a real appointment.
 */
export function briefingTimeline(data: BriefingData): TimelineItem[] {
  const leaveByTitle = new Map<string, number>();
  for (const event of data.events) {
    if (!event.isBuffer || !event.bufferFor) continue;
    const known = leaveByTitle.get(event.bufferFor);
    if (known === undefined || event.startsAt < known) {
      leaveByTitle.set(event.bufferFor, event.startsAt);
    }
  }

  const items: TimelineItem[] = [];
  const seen = new Set<string>();
  const push = (item: TimelineItem): void => {
    // A timetable slot that was also mirrored onto the calendar is one thing
    // that happens once, and must not be announced twice.
    const key = `${item.startsAt}|${item.title.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  for (const event of data.events) {
    if (event.isBuffer || event.allDay) continue;
    push({
      title: event.title,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      location: event.location,
      leaveAt: leaveByTitle.get(event.title) ?? null,
    });
  }
  for (const entry of data.classes) {
    push({
      title: entry.subject,
      startsAt: entry.startsAt,
      endsAt: entry.endsAt,
      location: entry.location,
      leaveAt: leaveByTitle.get(entry.subject) ?? null,
    });
  }

  return items.sort((a, b) => a.startsAt - b.startsAt || a.title.localeCompare(b.title));
}

/* ----------------------------------------------------------------- visual -- */

export function composeVisual(data: BriefingData): BriefingBullets {
  return [scheduleBullet(data), dueBullet(data), commitmentBullet(data)];
}

function scheduleBullet(data: BriefingData): BriefingBullet {
  const timeline = briefingTimeline(data);
  const allDay = data.events.filter((event) => event.allDay && !event.isBuffer);
  const scope = SCOPE_WORD[data.scope];

  if (timeline.length === 0) {
    const first = allDay[0];
    if (first) {
      const more = allDay.length - 1;
      const rest = more > 0 ? `, plus ${countLabel(more, 'more', 'more')}` : '';
      return { icon: 'calendar', text: `${title(first.title)} — all day${rest}.` };
    }
    return { icon: 'calendar', text: `Nothing on your calendar ${scope}.` };
  }

  const index = timeline.findIndex((item) => item.endsAt > data.now);
  if (index < 0) {
    return {
      icon: 'calendar',
      text: `${countLabel(timeline.length, 'thing')} ${scope}, all wrapped up.`,
    };
  }

  const next = timeline[index]!;
  const later = timeline.length - index - 1;
  const rest = later > 0 ? `, then ${countLabel(later, 'more', 'more')}` : '';
  const when = pointInTime(next.startsAt, data);

  if (next.leaveAt != null && next.leaveAt > data.now) {
    return {
      icon: 'travel',
      text: `Leave at ${formatTime(next.leaveAt, data.zone)} for ${title(next.title)} ${when}${rest}.`,
    };
  }
  return { icon: 'calendar', text: `${title(next.title)} ${when}${rest}.` };
}

function dueBullet(data: BriefingData): BriefingBullet {
  const [overdue] = data.overdueTasks;
  if (overdue) {
    const more = data.overdueTasks.length - 1;
    const rest = more > 0 ? `, plus ${countLabel(more, 'more', 'more')}` : '';
    return { icon: 'overdue', text: `${title(overdue.title)} is overdue${rest}.` };
  }

  const due = data.dueTasks[0] ?? data.upcomingTasks[0];
  if (due) {
    const more = data.dueTasks.length - 1;
    const rest = more > 0 ? `, plus ${countLabel(more, 'more', 'more')} due` : '';
    return { icon: 'task', text: `${title(due.title)} is due ${dueMoment(due, data)}${rest}.` };
  }

  const next = data.unlockedTasks[0];
  if (next) return { icon: 'task', text: `Next up: ${title(next.title)}.` };

  return { icon: 'clear', text: `Nothing due ${SCOPE_WORD[data.scope]}.` };
}

function commitmentBullet(data: BriefingData): BriefingBullet {
  const [risky] = data.streaksAtRisk;
  if (risky) {
    return {
      icon: 'streak',
      text: `Log ${title(risky.name)} to keep your ${risky.streak}-day streak.`,
    };
  }

  const [promise] = data.commitments;
  if (promise) {
    const when = promise.dueDate == null ? '' : ` (${dayWord(promise.dueDate, data)})`;
    const text =
      promise.direction === 'i_owe'
        ? `You owe ${title(promise.personName)}: ${title(promise.text)}${when}.`
        : `${title(promise.personName)} owes you: ${title(promise.text)}${when}.`;
    return { icon: 'promise', text };
  }

  const [streak] = data.streaks;
  if (streak) {
    return {
      icon: 'streak',
      text: `${streak.streak}-day ${title(streak.name)} streak going strong.`,
    };
  }

  if (data.focus) {
    const state = data.focus.status === 'paused' ? 'paused' : 'running';
    return {
      icon: 'focus',
      text: `${title(data.focus.label)} ${state} — ${formatClock(data.focus.remainingMs)} left.`,
    };
  }

  return { icon: 'clear', text: 'No promises outstanding.' };
}

/* ---------------------------------------------------------------- spoken -- */

/**
 * A ~15-second script.
 *
 * Built as a list of sentences in priority order and then shortened until it
 * fits: first by naming fewer appointments, then by dropping whole trailing
 * sentences. An empty day still gets a real sentence rather than a paragraph
 * assembled out of missing values.
 */
export function composeSpoken(data: BriefingData): string {
  const timeline = briefingTimeline(data).filter((item) => item.endsAt > data.now);
  const due = spokenDueClause(data);
  const tail = [spokenStreakSentence(data), spokenPromiseSentence(data)].filter(
    (sentence): sentence is string => sentence !== null,
  );

  for (let take = Math.min(MAX_SPOKEN_ITEMS, timeline.length); take >= 0; take--) {
    const sentences = [spokenLead(data, timeline.slice(0, take), due), ...tail];
    while (sentences.length > 1 && wordCount(sentences.join(' ')) > SPOKEN_WORD_CAP) {
      sentences.pop();
    }
    const script = sentences.join(' ');
    if (wordCount(script) <= SPOKEN_WORD_CAP) return script;
  }

  // Only reachable when a single title is pathologically long; the cap is hard.
  return clampWords([spokenLead(data, [], due), ...tail].join(' '), SPOKEN_WORD_CAP);
}

function spokenLead(data: BriefingData, items: TimelineItem[], due: string | null): string {
  const greeting = `${greetingFor(data)}.`;
  const clauses = items.map((item) => `${spokenTitle(item.title)} ${spokenWhen(item.startsAt, data)}`);

  if (clauses.length > 0) {
    const all = due ? [...clauses, due] : clauses;
    return `${greeting} You have ${joinNatural(all)}.`;
  }
  if (due) return `${greeting} ${capitalise(due)}.`;

  const next = data.unlockedTasks[0];
  if (next) {
    return `${greeting} Nothing is scheduled ${SCOPE_WORD[data.scope]}, so the next step is ${spokenTitle(next.title)}.`;
  }
  return `${greeting} Nothing scheduled ${SCOPE_WORD[data.scope]} and nothing due — the day is yours.`;
}

/** "your Physics homework is due tomorrow" — the clause the lead sentence ends on. */
function spokenDueClause(data: BriefingData): string | null {
  const [overdue] = data.overdueTasks;
  if (overdue) return `${spokenTitle(overdue.title)} is overdue`;

  const due = data.dueTasks[0] ?? data.upcomingTasks[0];
  if (!due) return null;
  return `your ${spokenTitle(due.title)} is due ${dueMoment(due, data, { spoken: true })}`;
}

function spokenStreakSentence(data: BriefingData): string | null {
  const risky = data.streaksAtRisk[0];
  if (risky) {
    return `Your ${risky.streak}-day ${spokenTitle(risky.name)} streak needs today's entry.`;
  }
  const streak = data.streaks[0];
  if (!streak) return null;
  return `You're on a ${streak.streak}-day ${spokenTitle(streak.name)} streak.`;
}

function spokenPromiseSentence(data: BriefingData): string | null {
  const promise = data.commitments[0];
  if (!promise) return null;
  return promise.direction === 'i_owe'
    ? `Don't forget you owe ${spokenTitle(promise.personName)} ${spokenTitle(promise.text)}.`
    : `${spokenTitle(promise.personName)} still owes you ${spokenTitle(promise.text)}.`;
}

function greetingFor(data: BriefingData): string {
  const hour = epochToLocal(data.now, data.zone).hour;
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/* ---------------------------------------------------------------- shared -- */

/** Wall-clock phrasing for the card: "at 10:00", or with a weekday over a week. */
function pointInTime(epoch: number, data: BriefingData): string {
  if (data.scope !== 'week') return `at ${formatTime(epoch, data.zone)}`;
  return `${weekday(epoch, data)} at ${formatTime(epoch, data.zone)}`;
}

/** The spoken equivalent: "at 10 AM". */
function spokenWhen(epoch: number, data: BriefingData): string {
  if (data.scope !== 'week') return `at ${formatSpokenTime(epoch, data.zone)}`;
  return `${weekday(epoch, data)} at ${formatSpokenTime(epoch, data.zone)}`;
}

function weekday(epoch: number, data: BriefingData): string {
  const heading = formatDayHeading(epoch, data.zone, data.now);
  if (RELATIVE_DAYS.has(heading)) return heading.toLowerCase();
  return `on ${epochToLocal(epoch, data.zone).toFormat('cccc')}`;
}

function dayWord(epoch: number, data: BriefingData): string {
  const heading = formatDayHeading(epoch, data.zone, data.now);
  return RELATIVE_DAYS.has(heading) ? heading.toLowerCase() : `on ${heading}`;
}

function dueMoment(
  task: BriefingTask,
  data: BriefingData,
  options: { spoken?: boolean } = {},
): string {
  if (task.dueDate == null) return 'soon';
  const day = dayWord(task.dueDate, data);
  // A midnight due date is a date, not a deadline; reading "at 00:00" out loud
  // invents a precision the user never gave.
  const local = epochToLocal(task.dueDate, data.zone);
  if (local.hour === 0 && local.minute === 0) return day;
  const clock = options.spoken
    ? formatSpokenTime(task.dueDate, data.zone)
    : formatTime(task.dueDate, data.zone);
  return `${day} at ${clock}`;
}

const title = (text: string): string => truncate(text, CARD_TITLE_LIMIT);
const spokenTitle = (text: string): string => truncate(text, SPOKEN_TITLE_LIMIT);

function capitalise(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function clampWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= max) return text.trim();
  return `${words.slice(0, max).join(' ').replace(/[,.;:—-]+$/, '')}.`;
}
