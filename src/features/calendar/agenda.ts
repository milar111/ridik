/**
 * One day, assembled.
 *
 * The agenda has to read as a single schedule, so three sources are folded into
 * one ordered list here: one-off events, the travel/prep buffers that belong to
 * them, and the weekly timetable. Keeping it pure means the "does the buffer
 * hang off the right meeting?" question is answerable without a renderer.
 */
import { epochToLocal, localToEpoch, luxonWeekdayToSchema, type LocalDate } from '@/core/time';
import type { CalendarEvent, CurriculumEntry } from '@/db/schema';

export type ClassSlot = {
  entry: CurriculumEntry;
  startsAt: number;
  endsAt: number;
};

export type AgendaItem =
  | {
      type: 'event';
      key: string;
      startsAt: number;
      endsAt: number;
      allDay: boolean;
      event: CalendarEvent;
      /** Rendered attached to the event, not as a row of its own. */
      buffer: CalendarEvent | null;
    }
  | {
      type: 'class';
      key: string;
      startsAt: number;
      endsAt: number;
      allDay: false;
      slot: ClassSlot;
    };

const DAY_MS = 86_400_000;

/** Where the item begins visually — a buffer extends its event upwards. */
export function visualStartOf(item: AgendaItem): number {
  return item.type === 'event' && item.buffer
    ? Math.min(item.buffer.startsAt, item.startsAt)
    : item.startsAt;
}

export function isBuffer(event: CalendarEvent): boolean {
  return event.kind === 'buffer' || event.bufferForId !== null;
}

/**
 * Timetable slots that land on `date`, as instants.
 *
 * Bi-weekly programmes are filtered by ISO week parity here rather than in the
 * query, because the parity of a *displayed* day is a property of the day.
 */
export function classesOnDate(
  entries: readonly CurriculumEntry[],
  date: LocalDate,
  zone: string,
): ClassSlot[] {
  const dayStart = localToEpoch(date, zone);
  const local = epochToLocal(dayStart, zone);
  const schemaDay = luxonWeekdayToSchema(local.weekday);
  const odd = local.weekNumber % 2 === 1;

  return entries
    .filter((entry) => entry.isActive && entry.dayOfWeek === schemaDay)
    .filter((entry) =>
      entry.weekParity === 'every' ? true : entry.weekParity === (odd ? 'odd' : 'even'),
    )
    .map((entry) => {
      const startsAt = localToEpoch(`${date}T${entry.startTime}`, zone);
      const rawEnd = localToEpoch(`${date}T${entry.endTime}`, zone);
      // A 23:00–00:30 slot finishes on the next calendar day.
      return { entry, startsAt, endsAt: rawEnd <= startsAt ? rawEnd + DAY_MS : rawEnd };
    })
    .sort((a, b) => a.startsAt - b.startsAt);
}

/**
 * Folds events, their buffers and the day's classes into one ordered agenda.
 *
 * A buffer is only attached when its parent is on this day too; the orphan left
 * behind by an event that moved still has to be visible, so it falls back to a
 * row of its own rather than vanishing.
 */
export function buildAgenda(
  events: readonly CalendarEvent[],
  classes: readonly ClassSlot[],
): AgendaItem[] {
  const visible = events.filter((event) => event.deletedAt === null);
  const byId = new Map(visible.map((event) => [event.id, event]));

  const buffersByParent = new Map<string, CalendarEvent[]>();
  const standalone: CalendarEvent[] = [];
  for (const event of visible) {
    const parentId = event.bufferForId;
    if (parentId && byId.has(parentId)) {
      const bucket = buffersByParent.get(parentId);
      if (bucket) bucket.push(event);
      else buffersByParent.set(parentId, [event]);
      continue;
    }
    standalone.push(event);
  }

  const attached = new Map<string, CalendarEvent>();
  for (const [parentId, bucket] of buffersByParent) {
    const sorted = [...bucket].sort((a, b) => a.startsAt - b.startsAt);
    // The earliest buffer is the one the user has to act on; any extra left by
    // a reschedule stays in the list as an ordinary row so it can be deleted.
    attached.set(parentId, sorted[0]!);
    standalone.push(...sorted.slice(1));
  }

  const items: AgendaItem[] = standalone.map((event) => ({
    type: 'event',
    key: event.id,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    allDay: event.allDay,
    event,
    buffer: attached.get(event.id) ?? null,
  }));

  for (const slot of classes) {
    items.push({
      type: 'class',
      // Slots repeat weekly, so the instant is part of the identity.
      key: `class:${slot.entry.id}:${slot.startsAt}`,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      allDay: false,
      slot,
    });
  }

  return items.sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    const byStart = visualStartOf(a) - visualStartOf(b);
    if (byStart !== 0) return byStart;
    return titleOf(a).localeCompare(titleOf(b));
  });
}

export function titleOf(item: AgendaItem): string {
  return item.type === 'event' ? item.event.title : item.slot.entry.subjectName;
}

export function locationOf(item: AgendaItem): string | null {
  return item.type === 'event' ? item.event.location : item.slot.entry.location;
}

/** Minutes, floored at zero — a zero-length event still renders a row. */
export function durationMinutes(startsAt: number, endsAt: number): number {
  return Math.max(0, Math.round((endsAt - startsAt) / 60_000));
}

/* ------------------------------------------------------------------- density */

/**
 * Events per local date, for the week strip's dots. Buffers are derived rows,
 * so counting them would make a single meeting look like two.
 */
export function countByDate(
  events: readonly CalendarEvent[],
  zone: string,
): Map<LocalDate, number> {
  const counts = new Map<LocalDate, number>();
  for (const event of events) {
    if (event.deletedAt !== null || isBuffer(event)) continue;
    const date = epochToLocal(event.startsAt, zone).toISODate();
    if (!date) continue;
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return counts;
}

/** Dots are a density hint, not a count: three is "busy" and that is enough. */
export const MAX_DENSITY_DOTS = 3;

export function densityDots(count: number): number {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 4) return 2;
  return MAX_DENSITY_DOTS;
}

/* ---------------------------------------------------------------------- sync */

export type SyncTone = 'success' | 'warning' | 'danger' | 'neutral';

export type SyncPresentation = {
  label: string;
  detail: string | null;
  tone: SyncTone;
  /** A literal union so this module stays free of the icon package. */
  icon: 'cloud-done-outline' | 'cloud-upload-outline' | 'alert-circle-outline' | 'phone-portrait-outline';
};

/**
 * What the sheet says about where this event lives.
 *
 * "Syncing…" is a promise, so it is only made when there is an account to sync
 * to: with Google disconnected a pending row is simply local, and saying
 * otherwise would leave the user waiting for a push that can never happen.
 */
export function describeSync(
  event: Pick<CalendarEvent, 'syncStatus' | 'syncError'>,
  options: { googleConnected: boolean },
): SyncPresentation {
  if (event.syncStatus === 'failed') {
    return {
      label: 'Sync failed',
      detail: event.syncError,
      tone: 'danger',
      icon: 'alert-circle-outline',
    };
  }
  if (event.syncStatus === 'synced') {
    return { label: 'Synced to Google', detail: null, tone: 'success', icon: 'cloud-done-outline' };
  }
  if (event.syncStatus === 'pending' && options.googleConnected) {
    return { label: 'Syncing…', detail: null, tone: 'warning', icon: 'cloud-upload-outline' };
  }
  return {
    label: 'On this device only',
    detail: options.googleConnected ? null : 'Connect Google Calendar in Settings.',
    tone: 'neutral',
    icon: 'phone-portrait-outline',
  };
}
