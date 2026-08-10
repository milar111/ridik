import { freezeClock } from '@/core/clock';
import { dayRange, localToEpoch, setZoneOverride } from '@/core/time';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import { createLedgerRepository, type LedgerRepository } from '@/repositories/ledger';

const SOFIA = 'Europe/Sofia';

describe('ledger repository', () => {
  let t: TestDatabase;
  let repo: LedgerRepository;
  let restoreClock: () => void;

  /** Freezes the clock at a wall-clock instant in `zone` and pins the app zone to it. */
  function pin(local: string, zone: string): number {
    restoreClock();
    setZoneOverride(zone);
    const epoch = localToEpoch(local, zone);
    restoreClock = freezeClock(epoch);
    return epoch;
  }

  beforeEach(() => {
    t = createTestDatabase();
    repo = createLedgerRepository(t.db);
    restoreClock = freezeClock(localToEpoch('2026-03-15T12:00', SOFIA));
    setZoneOverride(SOFIA);
  });

  afterEach(() => {
    restoreClock();
    setZoneOverride(null);
    t.close();
  });

  it('stores amounts positive and lets direction carry the sign', async () => {
    const spent = await repo.addTransaction({ amount: 12.5, currency: 'euros', category: 'Coffee' });
    expect(spent.amount).toBe(12.5);
    expect(spent.currency).toBe('EUR');
    expect(spent.direction).toBe('expense');
    expect(spent.localDate).toBe('2026-03-15');
    expect(spent.createdAt).toBe(localToEpoch('2026-03-15T12:00', SOFIA));

    const earned = await repo.addTransaction({
      amount: -30,
      currency: '$',
      category: 'Tutoring',
      direction: 'income',
      entityName: '  Ivan  ',
    });
    expect(earned.amount).toBe(30);
    expect(earned.currency).toBe('USD');
    expect(earned.entityName).toBe('Ivan');
  });

  it('rejects a zero or non-finite amount', async () => {
    await expect(repo.addTransaction({ amount: 0, category: 'Coffee' })).rejects.toThrow(
      /non-zero amount/,
    );
    await expect(repo.addTransaction({ amount: 5, category: '   ' })).rejects.toThrow(/category/);
  });

  it('never merges currencies into one total', async () => {
    await repo.addTransaction({ amount: 10.1, currency: 'EUR', category: 'Coffee' });
    await repo.addTransaction({ amount: 20.2, currency: 'EUR', category: 'Coffee' });
    await repo.addTransaction({ amount: 5, currency: 'EUR', category: 'Coffee' });
    await repo.addTransaction({ amount: 40, currency: 'USD', category: 'Coffee' });
    await repo.addTransaction({ amount: 2, currency: 'USD', category: 'Coffee' });

    const result = await repo.query({ period: 'month' });
    expect(result.count).toBe(5);
    expect(result.totalsByCurrency).toEqual({ EUR: 35.3, USD: 42 });
    // The one number the speech layer reads must be a single currency's number.
    expect(result.primaryCurrency).toBe('EUR');
    expect(result.total).toBe(35.3);
    expect(Object.values(result.totalsByCurrency)).not.toContain(77.3);
  });

  it('keeps currencies apart inside groups too', async () => {
    await repo.addTransaction({ amount: 10, currency: 'EUR', category: 'Hardware' });
    await repo.addTransaction({ amount: 60, currency: 'USD', category: 'Hardware' });
    await repo.addTransaction({ amount: 4, currency: 'EUR', category: 'Coffee' });

    const result = await repo.query({ period: 'month', group_by: 'category' });
    const hardware = result.groups.find((g) => g.key === 'Hardware');
    expect(hardware?.totalsByCurrency).toEqual({ EUR: 10, USD: 60 });
    expect(hardware?.count).toBe(2);
    // Group totals are quoted in the result's primary currency, never a blend.
    expect(result.primaryCurrency).toBe('EUR');
    expect(hardware?.total).toBe(10);
  });

  it('takes day boundaries from the user zone, not UTC', async () => {
    const nowEpoch = pin('2026-03-15T11:00', 'Asia/Tokyo');

    // 01:00 in Tokyo is still the 14th in UTC — it must count as "today".
    await repo.addTransaction({
      amount: 9,
      category: 'Breakfast',
      at: localToEpoch('2026-03-15T01:00', 'Asia/Tokyo'),
    });
    await repo.addTransaction({
      amount: 99,
      category: 'Dinner',
      at: localToEpoch('2026-03-14T23:00', 'Asia/Tokyo'),
    });

    const today = await repo.query({ period: 'today' });
    expect(today.count).toBe(1);
    expect(today.total).toBe(9);
    expect(today.from).toBe(dayRange('2026-03-15', 'Asia/Tokyo').start);
    expect(today.to).toBe(dayRange('2026-03-15', 'Asia/Tokyo').end);
    expect(today.from).toBeLessThan(nowEpoch);
  });

  it('takes month boundaries from the user zone, not UTC', async () => {
    pin('2026-03-01T20:00', 'America/New_York');

    // 23:30 on 28 Feb in New York is already 1 March in UTC.
    await repo.addTransaction({
      amount: 40,
      category: 'Groceries',
      at: localToEpoch('2026-02-28T23:30', 'America/New_York'),
    });
    await repo.addTransaction({
      amount: 7,
      category: 'Groceries',
      at: localToEpoch('2026-03-01T00:30', 'America/New_York'),
    });

    const march = await repo.query({ period: 'month' });
    expect(march.count).toBe(1);
    expect(march.total).toBe(7);
    expect(march.from).toBe(localToEpoch('2026-03-01T00:00', 'America/New_York'));
    expect(march.to).toBe(localToEpoch('2026-04-01T00:00', 'America/New_York'));
  });

  it('expands a spoken category to every category that matches it', async () => {
    await repo.addTransaction({ amount: 100, category: 'Hardware' });
    await repo.addTransaction({ amount: 50, category: 'hardware parts' });
    await repo.addTransaction({ amount: 30, category: 'Groceries' });

    const result = await repo.query({ period: 'all', category: 'hardware' });
    expect(result.count).toBe(2);
    expect(result.total).toBe(150);

    const grouped = await repo.query({ period: 'all', category: 'hardware', group_by: 'category' });
    expect(grouped.groups.map((g) => g.key).sort()).toEqual(['Hardware', 'hardware parts']);

    const unknown = await repo.query({ period: 'all', category: 'kayaking' });
    expect(unknown.count).toBe(0);
    expect(unknown.total).toBe(0);
    expect(unknown.groups).toEqual([]);
  });

  it('never sweeps an unrelated category into a total on a buried substring', async () => {
    await repo.addTransaction({ amount: 100, category: 'Hardware' });
    await repo.addTransaction({ amount: 50, category: 'War' });

    // "war" lives inside "hardware", which scores as a strong match. Counting it
    // would answer 150 to "how much on hardware" — a wrong number, silently.
    const hardware = await repo.query({ period: 'all', category: 'hardware' });
    expect(hardware.count).toBe(1);
    expect(hardware.total).toBe(100);

    const war = await repo.query({ period: 'all', category: 'war' });
    expect(war.count).toBe(1);
    expect(war.total).toBe(50);

    // The same gate applies to the entity filter and to the entity ledger.
    await repo.addTransaction({ amount: 8, category: 'Coffee', entityName: 'Hardware Store' });
    await repo.addTransaction({ amount: 9, category: 'Coffee', entityName: 'War Museum' });
    expect(await repo.listForEntity('hardware')).toHaveLength(1);
    const byEntity = await repo.query({ period: 'all', entity_name: 'war' });
    expect(byEntity.total).toBe(9);
  });

  it('never stores a blank currency', async () => {
    const row = await repo.addTransaction({ amount: 5, currency: '  ', category: 'Coffee' });
    expect(row.currency).toBe('EUR');

    const patched = await repo.updateTransaction(row.id, { currency: '' });
    if (!patched.ok) throw patched.error;
    // A blank patch keeps the currency already on the row instead of erasing it.
    expect(patched.value.currency).toBe('EUR');

    const result = await repo.query({ period: 'all' });
    expect(Object.keys(result.totalsByCurrency)).toEqual(['EUR']);
  });

  it('reports a malformed custom date as invalid input rather than a raw crash', async () => {
    await expect(repo.query({ period: 'custom', from: 'last tuesday' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('folds casing when grouping by category', async () => {
    await repo.addTransaction({ amount: 3, category: 'Coffee' });
    await repo.addTransaction({ amount: 4, category: 'Coffee' });
    await repo.addTransaction({ amount: 5, category: 'coffee' });

    const result = await repo.query({ period: 'all', group_by: 'category' });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ key: 'Coffee', count: 3, total: 12 });
  });

  it('groups by day in ascending order and by entity with a bucket for nobody', async () => {
    await repo.addTransaction({
      amount: 5,
      category: 'Coffee',
      entityName: 'Lidl',
      at: localToEpoch('2026-03-14T09:00', SOFIA),
    });
    await repo.addTransaction({
      amount: 6,
      category: 'Coffee',
      at: localToEpoch('2026-03-15T09:00', SOFIA),
    });

    const byDay = await repo.query({ period: 'month', groupBy: 'day' });
    expect(byDay.groups.map((g) => g.key)).toEqual(['2026-03-14', '2026-03-15']);

    const byEntity = await repo.query({ period: 'month', groupBy: 'entity' });
    expect(byEntity.groups.map((g) => g.key).sort()).toEqual(['(none)', 'Lidl']);
  });

  it('treats a custom period as inclusive of the closing day', async () => {
    for (const day of ['2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12']) {
      await repo.addTransaction({
        amount: 1,
        category: 'Bus',
        at: localToEpoch(`${day}T23:45`, SOFIA),
      });
    }

    const result = await repo.query({ period: 'custom', from: '2026-03-10', to: '2026-03-11' });
    expect(result.count).toBe(2);
    expect(result.from).toBe(localToEpoch('2026-03-10T00:00', SOFIA));
    expect(result.to).toBe(localToEpoch('2026-03-12T00:00', SOFIA));

    const openEnded = await repo.query({ period: 'custom', from: '2026-03-11' });
    expect(openEnded.count).toBe(2);
    expect(openEnded.to).toBeNull();
  });

  it('reports net per currency when both directions are asked for', async () => {
    await repo.addTransaction({ amount: 100, currency: 'EUR', category: 'Tutoring', direction: 'income' });
    await repo.addTransaction({ amount: 30, currency: 'EUR', category: 'Coffee' });
    await repo.addTransaction({ amount: 5, currency: 'USD', category: 'Coffee' });

    const both = await repo.query({ period: 'month', direction: 'both' });
    expect(both.count).toBe(3);
    expect(both.netByCurrency).toEqual({ EUR: 70, USD: -5 });
    expect(both.totalsByCurrency).toEqual({ EUR: 70, USD: -5 });
    expect(both.expenseByCurrency).toEqual({ EUR: 30, USD: 5 });
    expect(both.incomeByCurrency).toEqual({ EUR: 100 });

    const income = await repo.query({ period: 'month', direction: 'income' });
    expect(income.count).toBe(1);
    expect(income.totalsByCurrency).toEqual({ EUR: 100 });
  });

  it('lists the most recent transactions first', async () => {
    for (const day of ['2026-03-11', '2026-03-13', '2026-03-12']) {
      await repo.addTransaction({
        amount: 1,
        category: day,
        at: localToEpoch(`${day}T10:00`, SOFIA),
      });
    }
    const recent = await repo.listRecent(2);
    expect(recent.map((r) => r.category)).toEqual(['2026-03-13', '2026-03-12']);
  });

  it('finds an entity ledger by an approximate name', async () => {
    await repo.addTransaction({ amount: 12, category: 'Groceries', entityName: 'Lidl' });
    await repo.addTransaction({ amount: 3, category: 'Coffee', entityName: 'Costa Coffee' });

    expect(await repo.listForEntity('lidl')).toHaveLength(1);
    expect(await repo.listForEntity('costa')).toHaveLength(1);
    expect(await repo.listForEntity('nobody at all')).toEqual([]);
  });

  it('filters a query by entity name', async () => {
    await repo.addTransaction({ amount: 12, category: 'Groceries', entityName: 'Lidl' });
    await repo.addTransaction({ amount: 8, category: 'Groceries', entityName: 'Lidl' });
    await repo.addTransaction({ amount: 3, category: 'Coffee', entityName: 'Costa Coffee' });

    const result = await repo.query({ period: 'all', category: undefined, entity_name: 'lidl' });
    expect(result.count).toBe(2);
    expect(result.total).toBe(20);
  });

  it('updates a transaction and recomputes its local date', async () => {
    const row = await repo.addTransaction({ amount: 10, category: 'Coffee' });

    const updated = await repo.updateTransaction(row.id, {
      amount: -22,
      currency: 'quid',
      category: 'Books',
      at: localToEpoch('2026-01-02T08:00', SOFIA),
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw updated.error;
    expect(updated.value.amount).toBe(22);
    expect(updated.value.currency).toBe('GBP');
    expect(updated.value.localDate).toBe('2026-01-02');

    const reread = await repo.listRecent(1);
    expect(reread[0]).toMatchObject({ amount: 22, currency: 'GBP', category: 'Books' });

    const missing = await repo.updateTransaction('nope', { amount: 1 });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('expected a failure');
    expect(missing.error.code).toBe('not_found');
  });

  it('deletes a transaction and reports a missing one', async () => {
    const row = await repo.addTransaction({ amount: 10, category: 'Coffee' });
    const deleted = await repo.deleteTransaction(row.id);
    expect(deleted.ok).toBe(true);
    expect(await repo.listRecent()).toEqual([]);

    const again = await repo.deleteTransaction(row.id);
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error('expected a failure');
    expect(again.error.code).toBe('not_found');
  });

  it('lists distinct categories busiest first, folded by case', async () => {
    await repo.addTransaction({ amount: 1, category: 'Coffee' });
    await repo.addTransaction({ amount: 1, category: 'coffee' });
    await repo.addTransaction({ amount: 1, category: 'Coffee' });
    await repo.addTransaction({ amount: 1, category: 'Books' });

    expect(await repo.distinctCategories()).toEqual(['Coffee', 'Books']);
  });

  it('builds monthly chart buckets including empty months', async () => {
    await repo.addTransaction({
      amount: 20,
      currency: 'EUR',
      category: 'Coffee',
      at: localToEpoch('2026-01-10T10:00', SOFIA),
    });
    await repo.addTransaction({
      amount: 15,
      currency: 'USD',
      category: 'Coffee',
      at: localToEpoch('2026-03-02T10:00', SOFIA),
    });
    await repo.addTransaction({
      amount: 500,
      currency: 'EUR',
      category: 'Tutoring',
      direction: 'income',
      at: localToEpoch('2026-03-03T10:00', SOFIA),
    });
    // Outside the window entirely.
    await repo.addTransaction({
      amount: 999,
      category: 'Old',
      at: localToEpoch('2025-11-01T10:00', SOFIA),
    });

    const buckets = await repo.monthlyTotals(3);
    expect(buckets.map((b) => b.month)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(buckets[0]).toMatchObject({ count: 1, expense: { EUR: 20 }, income: {} });
    expect(buckets[1]).toMatchObject({ count: 0, expense: {}, income: {} });
    expect(buckets[2]).toMatchObject({ count: 2, expense: { USD: 15 }, income: { EUR: 500 } });
    expect(buckets[2]!.start).toBe(localToEpoch('2026-03-01T00:00', SOFIA));
  });
});
