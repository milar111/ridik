/**
 * A month laid out as a grid, computed without a renderer.
 *
 * The agenda answers "what is next"; a grid answers "where in the month was
 * that", and they are different questions. This is the second one, kept pure
 * for the same reason `agenda.ts` is: which day a 23:00–01:00 event belongs to
 * is answerable without a screen, and a block landing on the wrong day should
 * be a failing test rather than a screenshot.
 *
 * It used to carry the week grid's layout too — `slice`, `lanesFor`,
 * `hourWindow`, `allDayOn` — and lost all of it when the Week view was removed.
 * Three views were three answers to "what does my time look like" and the middle
 * one was the least distinct: Day says what is next, Month says where in the
 * month, and Week said a bit of both at a size that could show neither well.
 */
import { localToEpoch, type LocalDate } from '@/core/time';

import { visualStartOf, type AgendaItem } from './agenda';

function dayBounds(date: LocalDate, zone: string): { start: number; end: number } {
  const start = localToEpoch(`${date}T00:00`, zone);
  // Not `start + 86_400_000`: a DST day is 23 or 25 hours long, and adding a
  // fixed day to a spring-forward midnight lands an hour inside the next day.
  const end = localToEpoch(`${nextDate(date)}T00:00`, zone);
  return { start, end };
}

function nextDate(date: LocalDate): LocalDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(
    next.getUTCDate(),
  ).padStart(2, '0')}` as LocalDate;
}

export function monthCell(
  items: readonly AgendaItem[],
  date: LocalDate,
  zone: string,
): AgendaItem[] {
  const { start, end } = dayBounds(date, zone);
  return items
    .filter((item) => item.endsAt > start && visualStartOf(item) < end)
    .sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return visualStartOf(a) - visualStartOf(b);
    });
}

export function titleOf(item: AgendaItem): string {
  return item.type === 'class' ? item.slot.entry.subjectName : item.event.title;
}
