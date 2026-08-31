/**
 * Calendar events and timetable classes, merged into the one list the day
 * actually happens in.
 *
 * Pure and native-free — "now" and the window are parameters, and nothing here
 * touches a theme or a repository — so the ordering, the de-duplication and the
 * position of the now-rule are testable under plain Node.
 */
import type { CalendarEvent } from '@/db/schema';
import type { ClassOccurrence } from '@/repositories/curriculum';

export type AgendaKind = 'event' | 'class' | 'buffer';

export type AgendaItem = {
  key: string;
  kind: AgendaKind;
  title: string;
  startsAt: number;
  endsAt: number;
  location: string | null;
  /** A timetable colour the user chose; the row falls back to `colorForTag`. */
  color: string | null;
  /** Title of the appointment a travel/prep block precedes, when it is in view. */
  bufferFor: string | null;
};

export type Agenda = {
  /** No start time, so they head the list rather than sorting to midnight. */
  allDay: AgendaItem[];
  timed: AgendaItem[];
  /**
   * Where the now-rule goes: everything before this index has already started.
   * Equal to `timed.length` once the last thing of the day is behind us.
   */
  nowIndex: number;
};

export type BuildAgendaInput = {
  events: readonly CalendarEvent[];
  classes: readonly ClassOccurrence[];
  /** Half-open `[start, end)` — the local day the snapshot is showing. */
  window: { start: number; end: number };
  now: number;
};

export function buildAgenda({ events, classes, window, now }: BuildAgendaInput): Agenda {
  const titleById = new Map(events.map((event) => [event.id, event.title] as const));

  const allDay: AgendaItem[] = [];
  const timed: AgendaItem[] = [];
  const seen = new Set<string>();

  const push = (item: AgendaItem, bucket: AgendaItem[]): void => {
    // A timetable slot that was also mirrored onto the calendar is one thing
    // that happens once; listing it twice makes the day look busier than it is.
    // Buffers are exempt: two appointments can each earn their own travel block
    // at the same minute.
    if (item.kind !== 'buffer') {
      const key = `${item.startsAt}|${item.title.trim().toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
    }
    bucket.push(item);
  };

  for (const event of events) {
    const isBuffer = event.kind === 'buffer';
    const item: AgendaItem = {
      key: event.id,
      kind: isBuffer ? 'buffer' : 'event',
      title: event.title,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      location: event.location,
      color: null,
      bufferFor: event.bufferForId ? (titleById.get(event.bufferForId) ?? null) : null,
    };
    push(item, event.allDay && !isBuffer ? allDay : timed);
  }

  for (const occurrence of classes) {
    // `upcomingOccurrences` rolls forward from the start of the day and can
    // hand back next week's slot for a subject that does not meet today.
    if (occurrence.startsAt < window.start || occurrence.startsAt >= window.end) continue;
    push(
      {
        key: `class:${occurrence.entry.id}:${occurrence.startsAt}`,
        kind: 'class',
        title: occurrence.entry.subjectName,
        startsAt: occurrence.startsAt,
        endsAt: occurrence.endsAt,
        location: occurrence.entry.location,
        color: occurrence.entry.color,
        bufferFor: null,
      },
      timed,
    );
  }

  timed.sort(byStart);
  allDay.sort((a, b) => a.title.localeCompare(b.title));

  let nowIndex = 0;
  while (nowIndex < timed.length && timed[nowIndex]!.startsAt <= now) nowIndex++;

  return { allDay, timed, nowIndex };
}

/** A buffer and the thing it precedes can share a minute; the buffer goes first. */
function byStart(a: AgendaItem, b: AgendaItem): number {
  if (a.startsAt !== b.startsAt) return a.startsAt - b.startsAt;
  if (a.kind !== b.kind) return a.kind === 'buffer' ? -1 : b.kind === 'buffer' ? 1 : 0;
  return a.endsAt - b.endsAt || a.title.localeCompare(b.title);
}

export function isAgendaEmpty(agenda: Agenda): boolean {
  return agenda.allDay.length === 0 && agenda.timed.length === 0;
}

/**
 * The keys of every timed item that overlaps another one.
 *
 * A double-booking is the one thing a chronological list actively hides: two
 * rows an hour apart on screen can be the same hour of the day, and the reader
 * has to subtract end times in their head to notice. The app already treats
 * double-booking as worth interrupting a voice turn for — `alwaysAsks` in
 * `confirm.ts` exists for it — so the day it produced should not be the one
 * place it goes unmarked.
 *
 * Two rules, both deliberate:
 *
 *  - **Half-open comparison.** Back-to-back is not a clash: an event ending at
 *    14:00 and one starting at 14:00 is a normal timetable, and flagging it
 *    would put a badge on most school days and teach the user to ignore it.
 *  - **Buffers never clash.** A travel or prep block exists precisely to sit
 *    against the appointment it precedes, and `bufferFor` is drawn on the row
 *    already. Two appointments may each earn their own buffer at the same
 *    minute, which is why `buildAgenda` exempts them from de-duplication too.
 *  - **Nothing without a duration clashes.** A reminder is a point in time, not
 *    a claim on the calendar: "bring calipers at 17:00" during a lab that runs
 *    16:00–18:00 is the *intended* arrangement, not a conflict. Keyed on the
 *    span being empty rather than on `kind`, because that is the property that
 *    actually makes it un-bookable — a zero-length row cannot be given to two
 *    things at once.
 *
 * `O(n²)` on purpose: `n` is one local day's worth of rows, the list is already
 * sorted so most pairs exit on the first comparison, and an interval tree here
 * would be a data structure nobody could check by reading.
 */
export function clashingKeys(agenda: Agenda): ReadonlySet<string> {
  const clashing = new Set<string>();
  const items = agenda.timed.filter(
    (item) => item.kind !== 'buffer' && item.endsAt > item.startsAt,
  );
  for (let i = 0; i < items.length; i += 1) {
    const a = items[i]!;
    for (let j = i + 1; j < items.length; j += 1) {
      const b = items[j]!;
      // Sorted by start, so once one starts at or after `a` ends, so does the
      // rest of the list and this row has no further overlaps to find.
      if (b.startsAt >= a.endsAt) break;
      if (a.startsAt < b.endsAt) {
        clashing.add(a.key);
        clashing.add(b.key);
      }
    }
  }
  return clashing;
}
