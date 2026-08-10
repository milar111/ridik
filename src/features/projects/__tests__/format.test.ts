/**
 * The presentation maths behind the project screens: a deadline's colour and a
 * project's money total are both things a wrong answer would quietly mislead
 * the user about.
 */
import { AppError } from '@/core/result';
import { localToEpoch, setZoneOverride } from '@/core/time';
import type { Transaction } from '@/db/schema';

import { currencyTotals, deadlineOf, errorMessage, swapped } from '../format';

const ZONE = 'Europe/Sofia';
const NOW = localToEpoch('2026-08-11T09:00', ZONE);

beforeAll(() => setZoneOverride(ZONE));
afterAll(() => setZoneOverride(null));

function tx(patch: Partial<Transaction>): Transaction {
  return {
    id: 't1',
    amount: 10,
    currency: 'EUR',
    category: 'food',
    entityName: null,
    description: null,
    createdAt: NOW,
    direction: 'expense',
    projectId: 'p1',
    localDate: '2026-08-11',
    ...patch,
  };
}

describe('deadlineOf', () => {
  it('names today and tomorrow without a redundant countdown', () => {
    expect(deadlineOf(localToEpoch('2026-08-11T18:00', ZONE), NOW).label).toBe('Today');
    expect(deadlineOf(localToEpoch('2026-08-12T09:00', ZONE), NOW).label).toBe('Tomorrow');
  });

  it('adds the countdown once the date stops being obvious', () => {
    const deadline = deadlineOf(localToEpoch('2026-08-23T09:00', ZONE), NOW);
    expect(deadline.days).toBe(12);
    expect(deadline.label).toMatch(/^Sunday 23 August · in 12 days$/);
  });

  it('escalates the tone as the target approaches and passes', () => {
    expect(deadlineOf(localToEpoch('2026-09-30T09:00', ZONE), NOW).tone).toBe('tertiary');
    expect(deadlineOf(localToEpoch('2026-08-15T09:00', ZONE), NOW).tone).toBe('warning');
    expect(deadlineOf(localToEpoch('2026-08-10T09:00', ZONE), NOW).tone).toBe('danger');
  });
});

describe('currencyTotals', () => {
  it('keeps currencies apart and signs the net', () => {
    const totals = currencyTotals([
      tx({ id: 'a', amount: 120, currency: 'EUR' }),
      tx({ id: 'b', amount: 30, currency: 'EUR', direction: 'income' }),
      tx({ id: 'c', amount: 40, currency: 'USD' }),
    ]);

    expect(totals).toHaveLength(2);
    expect(totals[0]).toMatchObject({ currency: 'EUR', spent: 120, received: 30, net: -90 });
    expect(totals[0]!.formattedNet).toBe('−€90.00');
    expect(totals[1]).toMatchObject({ currency: 'USD', spent: 40, net: -40 });
  });

  it('has nothing to say about no transactions', () => {
    expect(currencyTotals([])).toEqual([]);
  });
});

describe('swapped', () => {
  it('swaps two positions', () => {
    expect(swapped(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
  });

  it('leaves the order alone when the move runs off either end', () => {
    expect(swapped(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(swapped(['a', 'b'], 1, 2)).toEqual(['a', 'b']);
    expect(swapped(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });
});

describe('errorMessage', () => {
  it('prefers the sentence written for the user', () => {
    expect(errorMessage(new AppError('conflict', 'You already have a project called "Kitchen".'))).toBe(
      'You already have a project called "Kitchen".',
    );
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage(null)).toBe('Something went wrong.');
  });
});
