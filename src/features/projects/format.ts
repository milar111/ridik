/**
 * Presentation maths for the projects screens.
 *
 * Kept pure and out of the components so a deadline's colour is decided once,
 * the same way, on the list card and in the detail header.
 */
import { now } from '@/core/clock';
import { formatMoney } from '@/core/format';
import { AppError } from '@/core/result';
import { calendarDaysBetween, currentZone, formatDayHeading, formatRelative } from '@/core/time';
import type { Transaction } from '@/db/schema';

/** The sentence to show the user, never the `code: message` debug string. */
export function errorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  if (error instanceof AppError) return error.userMessage;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export type DeadlineTone = 'tertiary' | 'warning' | 'danger';

export type Deadline = {
  /** "Tomorrow" / "Saturday 12 September · in 12 days" */
  label: string;
  tone: DeadlineTone;
  /** Whole calendar days from now; negative once the target has passed. */
  days: number;
};

/**
 * A target date is only ever interesting relative to today, so the countdown is
 * part of the label rather than a second field the caller has to remember to
 * render. Inside a day either way `formatDayHeading` already says "Today" or
 * "Tomorrow" and the relative phrase would just repeat it.
 *
 * "Now" comes from the injectable clock, never `Date.now()`: a frozen clock in a
 * test has to move this label too, or the countdown is untestable.
 */
export function deadlineOf(targetDate: number, at = now()): Deadline {
  const zone = currentZone();
  const days = calendarDaysBetween(at, targetDate, zone);
  const heading = formatDayHeading(targetDate, zone, at);
  const label = Math.abs(days) > 1 ? `${heading} · ${formatRelative(targetDate, at)}` : heading;
  const tone: DeadlineTone = days < 0 ? 'danger' : days <= 7 ? 'warning' : 'tertiary';
  return { label, tone, days };
}

export type CurrencyTotal = {
  currency: string;
  spent: number;
  received: number;
  /** Received minus spent — negative is the normal case for a trip. */
  net: number;
  formattedNet: string;
};

/**
 * Never one number across currencies: a summed EUR+USD total is a lie that
 * reads like a fact (the same rule the ledger export follows).
 */
export function currencyTotals(rows: readonly Transaction[]): CurrencyTotal[] {
  const byCurrency = new Map<string, { spent: number; received: number }>();
  for (const row of rows) {
    const bucket = byCurrency.get(row.currency) ?? { spent: 0, received: 0 };
    if (row.direction === 'income') bucket.received += row.amount;
    else bucket.spent += row.amount;
    byCurrency.set(row.currency, bucket);
  }
  return [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, bucket]) => {
      const net = bucket.received - bucket.spent;
      return {
        currency,
        spent: bucket.spent,
        received: bucket.received,
        net,
        // `formatMoney` folds the sign into the symbol ("€-190"); a total reads
        // better with the sign in front of it.
        formattedNet:
          net < 0 ? `−${formatMoney(-net, currency)}` : formatMoney(net, currency),
      };
    });
}
