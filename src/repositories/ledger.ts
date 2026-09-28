/**
 * Micro-financial ledger.
 *
 * Two rules shape everything below:
 *  - amounts are stored positive and `direction` carries the sign, so any signed
 *    number is an explicit decision here rather than an accident of storage;
 *  - totals are never summed across currencies. "You spent 240" that quietly
 *    added USD onto EUR is worse than no answer at all, so every total is
 *    reported per ISO code and `total`/`primaryCurrency` is only the convenience
 *    the speech layer reads out loud.
 */
import { and, asc, desc, eq, gte, inArray, lt, type SQL } from 'drizzle-orm';
import { now } from '@/core/clock';
import { editDistance, normalise, rank, resolveOne, tokenize, type Candidate } from '@/core/match';
import { AppError, fail, ok, type Result } from '@/core/result';
import {
  currentZone,
  dayRange,
  epochToLocal,
  localDateOf,
  monthRange,
  weekRange,
} from '@/core/time';
import { newId } from '@/db/ids';
import type { RidikDatabase } from '@/db/migrator';
import { transactions, type Transaction } from '@/db/schema';
import { normaliseCurrency } from '@/llm/contract';

export type LedgerDirection = 'expense' | 'income';
export type LedgerDirectionFilter = LedgerDirection | 'both';
export type LedgerPeriod = 'today' | 'week' | 'month' | 'year' | 'all' | 'custom';
export type LedgerGroupBy = 'none' | 'category' | 'entity' | 'day';

/** Per-currency sums, keyed by ISO-4217 code. */
export type CurrencyTotals = Record<string, number>;

export type AddTransactionInput = {
  amount: number;
  currency?: string;
  category: string;
  entityName?: string | null;
  description?: string | null;
  direction?: LedgerDirection;
  /** UTC epoch ms. The executor resolves the model's wall-clock string first. */
  at?: number;
  projectId?: string | null;
  zone?: string;
};

export type TransactionPatch = {
  amount?: number;
  currency?: string;
  category?: string;
  entityName?: string | null;
  description?: string | null;
  direction?: LedgerDirection;
  at?: number;
  projectId?: string | null;
  zone?: string;
};

/**
 * The `ledger_query` contract shape. Snake-case aliases are accepted because the
 * executor forwards the model's validated parameters verbatim.
 */
export type LedgerQuerySpec = {
  category?: string;
  entityName?: string;
  entity_name?: string;
  direction?: LedgerDirectionFilter;
  period?: LedgerPeriod;
  from?: string;
  to?: string;
  groupBy?: LedgerGroupBy;
  group_by?: LedgerGroupBy;
  zone?: string;
};

export type LedgerGroup = {
  key: string;
  /** In `primaryCurrency` — see `LedgerQueryResult.total`. */
  total: number;
  count: number;
  totalsByCurrency: CurrencyTotals;
  expenseByCurrency: CurrencyTotals;
  incomeByCurrency: CurrencyTotals;
};

export type LedgerQueryResult = {
  /**
   * The headline number, in `primaryCurrency` only. Cross-currency answers live
   * in `totalsByCurrency`, which is the authoritative result.
   */
  total: number;
  count: number;
  /** Inclusive start / exclusive end, UTC epoch ms. `null` = unbounded. */
  from: number | null;
  to: number | null;
  primaryCurrency: string | null;
  /** Magnitudes for a single direction; net (income − expense) for 'both'. */
  totalsByCurrency: CurrencyTotals;
  expenseByCurrency: CurrencyTotals;
  incomeByCurrency: CurrencyTotals;
  netByCurrency: CurrencyTotals;
  groups: LedgerGroup[];
};

export type MonthlyTotal = {
  /** `YYYY-MM` in the requested zone. */
  month: string;
  start: number;
  end: number;
  count: number;
  expense: CurrencyTotals;
  income: CurrencyTotals;
};

type Bounds = { start: number | null; end: number | null };

/**
 * How close a stored category has to be to the spoken one to be swept in.
 * Above `resolveOne`'s default because this expands a *set*: a loose match here
 * silently inflates a total rather than asking a question.
 */
const EXPANSION_THRESHOLD = 0.5;

/** REAL columns accumulate binary noise across a sum; money is answered to the cent. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function toRecord(sums: Map<string, number>): CurrencyTotals {
  const out: CurrencyTotals = {};
  for (const [currency, value] of sums) out[currency] = round(value);
  return out;
}

function add(sums: Map<string, number>, currency: string, amount: number): void {
  sums.set(currency, (sums.get(currency) ?? 0) + amount);
}

/** Picks the most-used spelling of a case-folded label, ties broken alphabetically. */
function bestLabel(labels: Map<string, number>): string {
  let best = '';
  let bestCount = -1;
  for (const [label, count] of labels) {
    if (count > bestCount || (count === bestCount && label < best)) {
      best = label;
      bestCount = count;
    }
  }
  return best;
}

/**
 * `scoreText` scores a bare substring hit highly, so "war" reads as a strong
 * match for "hardware". Resolving a single row that way is fine — a near tie
 * becomes a question — but expanding a *set* that way folds an unrelated
 * category into a money total and asks nothing, which is the one answer this
 * file must never give. So a swept-in value also has to share a whole word.
 */
function sharesWord(query: string, value: string): boolean {
  const queryWords = tokenize(query);
  const valueWords = tokenize(value);
  if (queryWords.length === 0 || valueWords.length === 0) {
    return normalise(query) === normalise(value);
  }
  return queryWords.some((q) =>
    valueWords.some((v) => {
      if (q === v) return true;
      // Same slip tolerance `scoreText` uses, but against whole words rather
      // than against anything buried inside one.
      const longest = Math.max(q.length, v.length);
      if (longest < 4) return false;
      return v.startsWith(q) || q.startsWith(v) || editDistance(q, v, 2) <= 2;
    }),
  );
}

function expand(query: string, values: string[]): string[] {
  const candidates = values.map((value) => ({ item: value, text: value }));
  return rank(query, candidates, { threshold: EXPANSION_THRESHOLD })
    .map((s) => s.item)
    .filter((value) => sharesWord(query, value));
}

/**
 * How far back a spoken "delete that" can reach.
 *
 * Not unbounded, and not a day. A correction follows its mistake within a
 * sentence or two, so a wide window buys nothing and costs the case this must
 * never get wrong: "delete the coffee" finding a coffee from March. Fifty rows
 * is weeks for most people and still bounded on the phone of somebody who logs
 * every bus fare.
 */
const RESOLVE_WINDOW = 50;

/** `normaliseCurrency('')` returns '', which would open a nameless currency bucket. */
function currencyOf(input: string | undefined, fallback = 'EUR'): string {
  return normaliseCurrency(input?.trim() || fallback) || fallback;
}

/** `dayRange` throws a bare Error on a bad date; anything the user reaches speaks an AppError. */
function customBound(date: string | undefined, zone: string, edge: 'start' | 'end'): number | null {
  if (!date) return null;
  try {
    return dayRange(date, zone)[edge];
  } catch {
    throw new AppError('invalid_input', `I did not understand the date "${date}".`);
  }
}

export function createLedgerRepository(db: RidikDatabase) {
  async function findById(id: string): Promise<Transaction | null> {
    const rows = await db.select().from(transactions).where(eq(transactions.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async function categoryValues(): Promise<string[]> {
    const rows = await db.selectDistinct({ value: transactions.category }).from(transactions);
    return rows.map((r) => r.value);
  }

  async function entityValues(): Promise<string[]> {
    const rows = await db.selectDistinct({ value: transactions.entityName }).from(transactions);
    return rows.map((r) => r.value).filter((v): v is string => v !== null && v.length > 0);
  }

  function periodBounds(spec: LedgerQuerySpec, zone: string): Bounds {
    const at = now();
    switch (spec.period ?? 'month') {
      case 'today':
        return dayRange(localDateOf(at, zone), zone);
      case 'week':
        return weekRange(at, zone);
      case 'month':
        return monthRange(at, zone);
      case 'year': {
        const start = epochToLocal(at, zone).startOf('year');
        return { start: start.toMillis(), end: start.plus({ years: 1 }).toMillis() };
      }
      case 'custom':
        // Half-open ranges are normal from speech ("since the first"), so a
        // missing edge means unbounded rather than an error. `to` is inclusive.
        return {
          start: customBound(spec.from, zone, 'start'),
          end: customBound(spec.to, zone, 'end'),
        };
      default:
        return { start: null, end: null };
    }
  }

  function groupKeyOf(row: Transaction, groupBy: LedgerGroupBy, zone: string): string {
    if (groupBy === 'category') return row.category;
    if (groupBy === 'entity') return row.entityName ?? '(none)';
    // Derived rather than read from `local_date` so day buckets and period
    // boundaries are always computed in the same zone.
    return localDateOf(row.createdAt, zone);
  }

  function summarise(
    rows: Transaction[],
    bounds: Bounds,
    direction: LedgerDirectionFilter,
    groupBy: LedgerGroupBy,
    zone: string,
  ): LedgerQueryResult {
    const expense = new Map<string, number>();
    const income = new Map<string, number>();
    const rowsPerCurrency = new Map<string, number>();

    type Acc = {
      labels: Map<string, number>;
      count: number;
      expense: Map<string, number>;
      income: Map<string, number>;
    };
    const accs = new Map<string, Acc>();

    for (const row of rows) {
      const currency = row.currency;
      add(row.direction === 'income' ? income : expense, currency, row.amount);
      rowsPerCurrency.set(currency, (rowsPerCurrency.get(currency) ?? 0) + 1);

      if (groupBy === 'none') continue;
      const label = groupKeyOf(row, groupBy, zone);
      const key = normalise(label) || label;
      let acc = accs.get(key);
      if (!acc) {
        acc = { labels: new Map(), count: 0, expense: new Map(), income: new Map() };
        accs.set(key, acc);
      }
      acc.labels.set(label, (acc.labels.get(label) ?? 0) + 1);
      acc.count += 1;
      add(row.direction === 'income' ? acc.income : acc.expense, currency, row.amount);
    }

    const headline = (exp: Map<string, number>, inc: Map<string, number>): CurrencyTotals => {
      if (direction === 'expense') return toRecord(exp);
      if (direction === 'income') return toRecord(inc);
      const net = new Map<string, number>();
      for (const [currency, value] of inc) add(net, currency, value);
      for (const [currency, value] of exp) add(net, currency, -value);
      return toRecord(net);
    };

    const netByCurrency = new Map<string, number>();
    for (const [currency, value] of income) add(netByCurrency, currency, value);
    for (const [currency, value] of expense) add(netByCurrency, currency, -value);

    const totalsByCurrency = headline(expense, income);
    const primaryCurrency = bestLabel(rowsPerCurrency) || null;

    const groups: LedgerGroup[] = [...accs.values()].map((acc) => {
      const totals = headline(acc.expense, acc.income);
      return {
        key: bestLabel(acc.labels),
        total: primaryCurrency ? (totals[primaryCurrency] ?? 0) : 0,
        count: acc.count,
        totalsByCurrency: totals,
        expenseByCurrency: toRecord(acc.expense),
        incomeByCurrency: toRecord(acc.income),
      };
    });

    // Days read as a timeline; everything else reads as a ranking.
    groups.sort((a, b) =>
      groupBy === 'day'
        ? a.key.localeCompare(b.key)
        : Math.abs(b.total) - Math.abs(a.total) || a.key.localeCompare(b.key),
    );

    return {
      total: primaryCurrency ? (totalsByCurrency[primaryCurrency] ?? 0) : 0,
      count: rows.length,
      from: bounds.start,
      to: bounds.end,
      primaryCurrency,
      totalsByCurrency,
      expenseByCurrency: toRecord(expense),
      incomeByCurrency: toRecord(income),
      netByCurrency: toRecord(netByCurrency),
      groups,
    };
  }

  async function addTransaction(input: AddTransactionInput): Promise<Transaction> {
    const amount = Math.abs(input.amount);
    if (!Number.isFinite(amount) || amount === 0) {
      throw new AppError('invalid_input', 'A transaction needs a non-zero amount.');
    }
    const category = input.category.trim();
    if (!category) throw new AppError('invalid_input', 'A transaction needs a category.');

    const zone = input.zone ?? currentZone();
    const at = input.at ?? now();
    const row: Transaction = {
      id: newId(),
      amount,
      // Defensive: the contract normalises, but direct callers and old rows do not.
      currency: currencyOf(input.currency),
      category,
      entityName: input.entityName?.trim() || null,
      description: input.description?.trim() || null,
      createdAt: at,
      direction: input.direction ?? 'expense',
      projectId: input.projectId ?? null,
      localDate: localDateOf(at, zone),
    };
    await db.insert(transactions).values(row);
    return row;
  }

  async function query(spec: LedgerQuerySpec = {}): Promise<LedgerQueryResult> {
    const zone = spec.zone ?? currentZone();
    const direction = spec.direction ?? 'expense';
    const groupBy = spec.groupBy ?? spec.group_by ?? 'none';
    const entityName = spec.entityName ?? spec.entity_name;
    const bounds = periodBounds(spec, zone);

    const clauses: SQL[] = [];
    if (bounds.start !== null) clauses.push(gte(transactions.createdAt, bounds.start));
    if (bounds.end !== null) clauses.push(lt(transactions.createdAt, bounds.end));
    if (direction !== 'both') clauses.push(eq(transactions.direction, direction));

    const empty = () => summarise([], bounds, direction, groupBy, zone);

    const wantedCategory = spec.category?.trim();
    if (wantedCategory) {
      const matched = expand(wantedCategory, await categoryValues());
      if (matched.length === 0) return empty();
      clauses.push(inArray(transactions.category, matched));
    }

    const wantedEntity = entityName?.trim();
    if (wantedEntity) {
      const matched = expand(wantedEntity, await entityValues());
      if (matched.length === 0) return empty();
      clauses.push(inArray(transactions.entityName, matched));
    }

    // Aggregated in JS rather than SQL: per-currency grouping needs a second
    // dimension on every bucket, and a personal ledger is small enough that one
    // scan beats three GROUP BY round-trips.
    const rows = await db
      .select()
      .from(transactions)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(asc(transactions.createdAt));

    return summarise(rows, bounds, direction, groupBy, zone);
  }

  async function listRecent(limit = 50): Promise<Transaction[]> {
    return db
      .select()
      .from(transactions)
      .orderBy(desc(transactions.createdAt), desc(transactions.id))
      .limit(Math.max(1, Math.floor(limit)));
  }

  async function listForEntity(name: string, limit = 200): Promise<Transaction[]> {
    const matched = expand(name.trim(), await entityValues());
    if (matched.length === 0) return [];
    return db
      .select()
      .from(transactions)
      .where(inArray(transactions.entityName, matched))
      .orderBy(desc(transactions.createdAt), desc(transactions.id))
      .limit(Math.max(1, Math.floor(limit)));
  }

  /**
   * The transaction the user just referred to, or a question.
   *
   * The window matters more than the scoring here. What follows a wrong amount
   * is "no, delete that", said seconds later, so an empty query means the most
   * recent row rather than a search over everything — and a search over
   * everything is what would make "delete the coffee" reach a coffee from
   * March. `RESOLVE_WINDOW` is the recent past this looks over; older rows are
   * corrected on the Spending screen, where they can be seen.
   *
   * `amount` filters before the words score, never after: a user who says the
   * number is telling us which of two identical-sounding rows they mean, and
   * letting words outrank it would delete the one they were happy with.
   */
  async function resolveTransaction(
    input: { query?: string; amount?: number } = {},
  ): Promise<Result<Transaction>> {
    const recent = await listRecent(RESOLVE_WINDOW);
    if (recent.length === 0) return fail('not_found', 'You have not recorded any spending yet.');

    const pool =
      input.amount === undefined
        ? recent
        : recent.filter((row) => Math.abs(row.amount - input.amount!) < 0.005);
    if (pool.length === 0) {
      return fail('not_found', `I could not find a recent entry for ${input.amount}.`);
    }

    const query = input.query?.trim();
    // No words at all is not a failed match — it is "that one", and the last
    // thing recorded is the only thing it can mean.
    if (!query) return ok(pool[0]!);

    const candidates: Candidate<Transaction>[] = pool.map((row) => ({
      item: row,
      text: row.category,
      aux: [row.description, row.entityName].filter((v): v is string => Boolean(v)),
    }));

    const outcome = resolveOne(query, candidates);
    if (outcome.kind === 'none') {
      return fail('not_found', `I could not find a recent entry for "${query}".`);
    }
    if (outcome.kind === 'ambiguous') {
      return fail('ambiguous', `"${query}" matches more than one entry.`, {
        details: {
          matches: outcome.matches.map((m) => ({
            id: m.item.id,
            label: `${m.item.amount} ${m.item.currency} — ${m.item.category}`,
            score: m.score,
          })),
        },
      });
    }
    return ok(outcome.match.item);
  }

  async function deleteTransaction(id: string): Promise<Result<Transaction>> {
    const existing = await findById(id);
    if (!existing) return fail('not_found', 'I could not find that transaction.');
    await db.delete(transactions).where(eq(transactions.id, id));
    return ok(existing);
  }

  async function updateTransaction(
    id: string,
    patch: TransactionPatch,
  ): Promise<Result<Transaction>> {
    const existing = await findById(id);
    if (!existing) return fail('not_found', 'I could not find that transaction.');

    const zone = patch.zone ?? currentZone();
    const next: Partial<Transaction> = {};

    if (patch.amount !== undefined) {
      const amount = Math.abs(patch.amount);
      if (!Number.isFinite(amount) || amount === 0) {
        return fail('invalid_input', 'A transaction needs a non-zero amount.');
      }
      next.amount = amount;
    }
    // A blank currency keeps the one already on the row rather than erasing it.
    if (patch.currency !== undefined) next.currency = currencyOf(patch.currency, existing.currency);
    if (patch.category !== undefined) {
      const category = patch.category.trim();
      if (!category) return fail('invalid_input', 'A transaction needs a category.');
      next.category = category;
    }
    if (patch.entityName !== undefined) next.entityName = patch.entityName?.trim() || null;
    if (patch.description !== undefined) next.description = patch.description?.trim() || null;
    if (patch.direction !== undefined) next.direction = patch.direction;
    if (patch.projectId !== undefined) next.projectId = patch.projectId ?? null;
    if (patch.at !== undefined) {
      next.createdAt = patch.at;
      next.localDate = localDateOf(patch.at, zone);
    }

    if (Object.keys(next).length === 0) return ok(existing);
    await db.update(transactions).set(next).where(eq(transactions.id, id));
    return ok({ ...existing, ...next });
  }

  /** Distinct categories, case-folded to their most-used spelling, busiest first. */
  async function distinctCategories(): Promise<string[]> {
    const rows = await db.select({ category: transactions.category }).from(transactions);
    const folded = new Map<string, { labels: Map<string, number>; count: number }>();
    for (const { category } of rows) {
      const key = normalise(category) || category;
      let entry = folded.get(key);
      if (!entry) {
        entry = { labels: new Map(), count: 0 };
        folded.set(key, entry);
      }
      entry.labels.set(category, (entry.labels.get(category) ?? 0) + 1);
      entry.count += 1;
    }
    return [...folded.values()]
      .map((entry) => ({ label: bestLabel(entry.labels), count: entry.count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      .map((entry) => entry.label);
  }

  /** `months` calendar buckets ending with the current month, oldest first. */
  async function monthlyTotals(
    months = 6,
    options: { zone?: string } = {},
  ): Promise<MonthlyTotal[]> {
    const zone = options.zone ?? currentZone();
    const span = Math.max(1, Math.floor(months));
    const currentStart = epochToLocal(now(), zone).startOf('month');
    const firstStart = currentStart.minus({ months: span - 1 });
    const end = currentStart.plus({ months: 1 }).toMillis();

    const buckets: MonthlyTotal[] = [];
    const byKey = new Map<string, { expense: Map<string, number>; income: Map<string, number> }>();
    for (let i = 0; i < span; i++) {
      const start = firstStart.plus({ months: i });
      const key = start.toFormat('yyyy-LL');
      byKey.set(key, { expense: new Map(), income: new Map() });
      buckets.push({
        month: key,
        start: start.toMillis(),
        end: start.plus({ months: 1 }).toMillis(),
        count: 0,
        expense: {},
        income: {},
      });
    }

    const rows = await db
      .select()
      .from(transactions)
      .where(
        and(gte(transactions.createdAt, firstStart.toMillis()), lt(transactions.createdAt, end)),
      )
      .orderBy(asc(transactions.createdAt));

    for (const row of rows) {
      const key = epochToLocal(row.createdAt, zone).toFormat('yyyy-LL');
      const sums = byKey.get(key);
      const bucket = buckets.find((b) => b.month === key);
      if (!sums || !bucket) continue;
      add(row.direction === 'income' ? sums.income : sums.expense, row.currency, row.amount);
      bucket.count += 1;
    }

    for (const bucket of buckets) {
      const sums = byKey.get(bucket.month)!;
      bucket.expense = toRecord(sums.expense);
      bucket.income = toRecord(sums.income);
    }
    return buckets;
  }

  return {
    addTransaction,
    query,
    listRecent,
    listForEntity,
    resolveTransaction,
    deleteTransaction,
    updateTransaction,
    distinctCategories,
    monthlyTotals,
  };
}

export type LedgerRepository = ReturnType<typeof createLedgerRepository>;
