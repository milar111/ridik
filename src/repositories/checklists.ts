/**
 * Checklists — transient micro-inventories ("shopping", "packing for Vienna").
 *
 * Kept apart from notes on purpose: these rows are throwaway, ordered, and
 * mutated by voice, so the only reference the caller ever has is the words the
 * user said. Every toggle therefore goes through fuzzy resolution and reports
 * ambiguity instead of picking a row.
 */
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { now } from '@/core/clock';
import { normalise, resolveOne, type Candidate } from '@/core/match';
import { AppError, fail, ok, type Result } from '@/core/result';
import { newId } from '@/db/ids';
import type { RidikDatabase } from '@/db/migrator';
import { checklists, type ChecklistItem } from '@/db/schema';

export type ChecklistItemInput = string | { text: string; quantity?: string };

export type AddItemsResult = {
  added: ChecklistItem[];
  /** Items that were ticked off and have been put back on the list. */
  reopened: ChecklistItem[];
  /** Items already open on the list; only their quantity may have changed. */
  duplicates: ChecklistItem[];
};

export type ChecklistListSummary = { name: string; open: number; total: number };

export type ChecklistToggleInput = {
  listName?: string;
  itemQuery: string;
  completed?: boolean;
};

export type ChecklistItemPatch = {
  itemText?: string;
  quantity?: string | null;
};

/**
 * `list_name` has no unique index, so NOCASE is what keeps one list one list.
 * Trimming here rather than at each call site: names arrive from a transcript,
 * and " shopping" silently matching nothing is worse than matching loosely.
 */
const sameList = (listName: string): SQL =>
  sql`${checklists.listName} = ${listName.trim()} COLLATE NOCASE`;

// `is_completed` is nullable in the DDL; coalesce so legacy nulls read as open.
const IS_OPEN = sql`coalesce(${checklists.isCompleted}, 0) = 0`;
const IS_DONE = sql`coalesce(${checklists.isCompleted}, 0) = 1`;

function toInput(item: ChecklistItemInput): { text: string; quantity: string | null } {
  if (typeof item === 'string') return { text: item.trim(), quantity: null };
  return { text: item.text.trim(), quantity: item.quantity?.trim() || null };
}

/** Drizzle's sync-mode `transaction()` cannot wrap awaited builders. */
async function inTransaction<T>(db: RidikDatabase, fn: () => Promise<T>): Promise<T> {
  db.$client.execSync('BEGIN');
  try {
    const value = await fn();
    db.$client.execSync('COMMIT');
    return value;
  } catch (error) {
    db.$client.execSync('ROLLBACK');
    throw error;
  }
}

export function createChecklistsRepository(db: RidikDatabase) {
  async function itemById(id: string): Promise<ChecklistItem | null> {
    const [row] = await db.select().from(checklists).where(eq(checklists.id, id));
    return row ?? null;
  }

  async function addItems(
    listName: string,
    items: readonly ChecklistItemInput[],
    projectId?: string,
  ): Promise<AddItemsResult> {
    const name = listName.trim();
    if (!name) throw new AppError('invalid_input', 'A checklist needs a name.');

    const inputs = items.map(toInput).filter((i) => i.text.length > 0);
    if (inputs.length === 0) throw new AppError('invalid_input', 'There was nothing to add.');

    return inTransaction(db, async () => {
      const existing = await db.select().from(checklists).where(sameList(name));

      const byText = new Map<string, ChecklistItem>();
      for (const row of existing) {
        const key = normalise(row.itemText);
        const seen = byText.get(key);
        // An open row always wins the key: saying "milk" again should be a no-op
        // rather than resurrect an older, already-crossed-off duplicate.
        if (!seen || (seen.isCompleted && !row.isCompleted)) byText.set(key, row);
      }

      let nextOrder = existing.reduce((max, row) => Math.max(max, row.orderIndex), -1) + 1;
      const at = now();
      const result: AddItemsResult = { added: [], reopened: [], duplicates: [] };

      for (const input of inputs) {
        const key = normalise(input.text);
        if (!key) continue;

        const match = byText.get(key);
        if (match) {
          const quantity = input.quantity ?? match.quantity;
          if (match.isCompleted) {
            const [row] = await db
              .update(checklists)
              .set({ isCompleted: false, completedAt: null, quantity })
              .where(eq(checklists.id, match.id))
              .returning();
            byText.set(key, row!);
            result.reopened.push(row!);
          } else if (quantity !== match.quantity) {
            const [row] = await db
              .update(checklists)
              .set({ quantity })
              .where(eq(checklists.id, match.id))
              .returning();
            byText.set(key, row!);
            result.duplicates.push(row!);
          } else {
            result.duplicates.push(match);
          }
          continue;
        }

        const [row] = await db
          .insert(checklists)
          .values({
            id: newId(),
            listName: name,
            itemText: input.text,
            quantity: input.quantity,
            projectId: projectId ?? null,
            isCompleted: false,
            orderIndex: nextOrder++,
            createdAt: at,
          })
          .returning();
        byText.set(key, row!);
        result.added.push(row!);
      }

      return result;
    });
  }

  async function toggle(input: ChecklistToggleInput): Promise<Result<ChecklistItem>> {
    const completed = input.completed ?? true;
    const query = input.itemQuery.trim();
    if (!query) throw new AppError('invalid_input', 'No item was named.');

    const scope = input.listName?.trim();
    const rows = scope
      ? await db.select().from(checklists).where(sameList(scope))
      : await db.select().from(checklists);

    if (rows.length === 0) {
      return fail(
        'not_found',
        scope ? `There is nothing on the ${scope} list.` : 'You have no checklists yet.',
      );
    }

    const candidates: Candidate<ChecklistItem>[] = rows.map((row) => ({
      item: row,
      text: row.itemText,
      // Across lists the list name is worth matching ("milk on the shopping
      // list") but only at the discount `rank` already applies to aux text.
      aux: scope ? undefined : [`${row.itemText} ${row.listName}`],
      // Nudge towards rows the request would actually change, so "tick off
      // bread" prefers the open loaf over the one bought last week.
      boost: Boolean(row.isCompleted) === completed ? 0 : 1,
    }));

    const outcome = resolveOne(query, candidates);
    if (outcome.kind === 'none') {
      return fail('not_found', `I could not find "${query}" on your lists.`);
    }
    if (outcome.kind === 'ambiguous') {
      return fail('ambiguous', `"${query}" could mean more than one thing.`, {
        details: {
          matches: outcome.matches.map((m) => ({
            id: m.item.id,
            itemText: m.item.itemText,
            listName: m.item.listName,
            score: m.score,
          })),
        },
      });
    }

    const row = outcome.match.item;
    if (Boolean(row.isCompleted) === completed) return ok(row);

    const [updated] = await db
      .update(checklists)
      .set({ isCompleted: completed, completedAt: completed ? now() : null })
      .where(eq(checklists.id, row.id))
      .returning();
    return ok(updated!);
  }

  async function listNames(): Promise<ChecklistListSummary[]> {
    const rows = await db
      .select({
        name: sql<string>`min(${checklists.listName})`,
        open: sql<number>`sum(case when coalesce(${checklists.isCompleted}, 0) = 0 then 1 else 0 end)`,
        total: sql<number>`count(*)`,
      })
      .from(checklists)
      .groupBy(sql`${checklists.listName} COLLATE NOCASE`)
      .orderBy(sql`${checklists.listName} COLLATE NOCASE`);

    return rows.map((row) => ({
      name: row.name,
      open: Number(row.open),
      total: Number(row.total),
    }));
  }

  async function itemsForList(
    listName: string,
    options: { includeCompleted?: boolean } = {},
  ): Promise<ChecklistItem[]> {
    const includeCompleted = options.includeCompleted ?? true;
    const where = includeCompleted
      ? sameList(listName)
      : and(sameList(listName), IS_OPEN);

    return db
      .select()
      .from(checklists)
      .where(where)
      .orderBy(
        sql`coalesce(${checklists.isCompleted}, 0)`,
        asc(checklists.orderIndex),
        asc(checklists.createdAt),
      );
  }

  async function clearCompleted(listName: string): Promise<number> {
    const rows = await db
      .delete(checklists)
      .where(and(sameList(listName), IS_DONE))
      .returning({ id: checklists.id });
    return rows.length;
  }

  async function removeItem(id: string): Promise<boolean> {
    const rows = await db
      .delete(checklists)
      .where(eq(checklists.id, id))
      .returning({ id: checklists.id });
    return rows.length > 0;
  }

  async function renameList(from: string, to: string): Promise<number> {
    const source = from.trim();
    const target = to.trim();
    if (!target) throw new AppError('invalid_input', 'A checklist needs a name.');

    // Pure re-casing: nothing moves, so leave the order indexes alone.
    if (source.toLowerCase() === target.toLowerCase()) {
      const rows = await db
        .update(checklists)
        .set({ listName: target })
        .where(sameList(source))
        .returning({ id: checklists.id });
      return rows.length;
    }

    return inTransaction(db, async () => {
      const [head] = await db
        .select({ max: sql<number | null>`max(${checklists.orderIndex})` })
        .from(checklists)
        .where(sameList(target));
      // Merging into an existing list: shift the incoming rows past its tail so
      // the two sets do not interleave on identical order indexes.
      const offset = (head?.max ?? -1) + 1;

      const rows = await db
        .update(checklists)
        .set({ listName: target, orderIndex: sql`${checklists.orderIndex} + ${offset}` })
        .where(sameList(source))
        .returning({ id: checklists.id });
      return rows.length;
    });
  }

  async function updateItem(id: string, patch: ChecklistItemPatch): Promise<ChecklistItem | null> {
    const set: Partial<typeof checklists.$inferInsert> = {};

    if (patch.itemText !== undefined) {
      const text = patch.itemText.trim();
      if (!text) throw new AppError('invalid_input', 'An item needs some text.');
      set.itemText = text;
    }
    if (patch.quantity !== undefined) {
      set.quantity = patch.quantity === null ? null : patch.quantity.trim() || null;
    }
    if (Object.keys(set).length === 0) return itemById(id);

    const [row] = await db
      .update(checklists)
      .set(set)
      .where(eq(checklists.id, id))
      .returning();
    return row ?? null;
  }

  return {
    addItems,
    toggle,
    listNames,
    itemsForList,
    clearCompleted,
    removeItem,
    renameList,
    updateItem,
    itemById,
  };
}

export type ChecklistsRepository = ReturnType<typeof createChecklistsRepository>;
