/**
 * Micro-CRM: people, what was said to them, and what is still owed.
 *
 * Everything here is reached by *name*, spoken the way the user says it — never
 * by id — so name resolution is the whole game. A person is one row plus a JSON
 * bag of alternative spellings ("Vanya" for "Ivan"), and every lookup checks
 * both, case- and accent-insensitively.
 */
import { and, asc, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { now } from '@/core/clock';
import { normalise, resolveOne } from '@/core/match';
import { AppError, fail, ok, type Result } from '@/core/result';
import { newId } from '@/db/ids';
import type { RidikDatabase } from '@/db/migrator';
import {
  crmCommitments,
  crmEntities,
  crmInteractions,
  transactions,
  type CrmCommitment,
  type CrmEntity,
  type CrmInteraction,
  type Transaction,
} from '@/db/schema';

export type CommitmentDirection = 'i_owe' | 'they_owe';

export type AddCommitmentInput = {
  entityName: string;
  commitmentText: string;
  /** UTC epoch ms. */
  dueDate?: number | null;
  direction?: CommitmentDirection;
  relationshipContext?: string;
  taskId?: string | null;
  /** `crm_add_commitment.interaction_summary`: what was said that made the promise. */
  interactionSummary?: string;
};

export type LogInteractionInput = {
  entityName: string;
  summary: string;
  /** UTC epoch ms; defaults to now(). */
  occurredAt?: number;
  relationshipContext?: string;
};

export type CommitmentWithEntity = { commitment: CrmCommitment; entity: CrmEntity };

export type CrmEntityProfile = {
  entity: CrmEntity;
  aliases: string[];
  /** Most recent first. */
  interactions: CrmInteraction[];
  lastInteractionAt: number | null;
  openCommitments: CrmCommitment[];
  completedCommitments: CrmCommitment[];
  /** Most recent first; matched on name *and* aliases. */
  transactions: Transaction[];
  spentByCurrency: Record<string, number>;
  receivedByCurrency: Record<string, number>;
  /** received − spent, per currency. Positive: they gave more than they took. */
  netByCurrency: Record<string, number>;
};

export type CrmEntitySummary = {
  entity: CrmEntity;
  aliases: string[];
  openCommitments: number;
  interactionCount: number;
  lastInteractionAt: number | null;
};

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function toRecord(sums: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [currency, value] of sums) out[currency] = round(value);
  return out;
}

/** Tolerant on purpose: a hand-edited or truncated aliases blob must not hide a contact. */
export function parseAliases(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((a): a is string => typeof a === 'string' && a.trim().length > 0);
  } catch {
    return [];
  }
}

export function createCrmRepository(db: RidikDatabase) {
  async function allEntities(): Promise<CrmEntity[]> {
    return db.select().from(crmEntities).orderBy(asc(crmEntities.name));
  }

  async function findEntityById(id: string): Promise<CrmEntity | null> {
    const rows = await db.select().from(crmEntities).where(eq(crmEntities.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async function findByNameOrAlias(name: string): Promise<CrmEntity | null> {
    const target = normalise(name);
    if (!target) return null;
    const entities = await allEntities();
    // Real names win over someone else's nickname, so they get their own pass.
    for (const entity of entities) {
      if (normalise(entity.name) === target) return entity;
    }
    for (const entity of entities) {
      if (parseAliases(entity.aliases).some((alias) => normalise(alias) === target)) return entity;
    }
    return null;
  }

  async function getOrCreateEntity(
    name: string,
    options: { relationshipContext?: string } = {},
  ): Promise<CrmEntity> {
    const trimmed = name.trim();
    if (!trimmed) throw new AppError('invalid_input', 'A contact needs a name.');

    const at = now();
    const context = options.relationshipContext?.trim();
    const existing = await findByNameOrAlias(trimmed);

    if (existing) {
      // Fill a gap the user has not filled themselves; never overwrite curated context.
      if (context && !existing.relationshipContext) {
        await db
          .update(crmEntities)
          .set({ relationshipContext: context, updatedAt: at })
          .where(eq(crmEntities.id, existing.id));
        return { ...existing, relationshipContext: context, updatedAt: at };
      }
      return existing;
    }

    const row: CrmEntity = {
      id: newId(),
      name: trimmed,
      relationshipContext: context || null,
      aliases: null,
      createdAt: at,
      updatedAt: at,
    };
    await db.insert(crmEntities).values(row);
    return row;
  }

  async function addAlias(entityId: string, alias: string): Promise<Result<CrmEntity>> {
    const trimmed = alias.trim();
    if (!trimmed) return fail('invalid_input', 'That alias is empty.');
    const entity = await findEntityById(entityId);
    if (!entity) return fail('not_found', 'I could not find that contact.');

    const aliases = parseAliases(entity.aliases);
    const target = normalise(trimmed);
    if (normalise(entity.name) === target || aliases.some((a) => normalise(a) === target)) {
      return ok(entity);
    }

    const at = now();
    const next = JSON.stringify([...aliases, trimmed]);
    await db
      .update(crmEntities)
      .set({ aliases: next, updatedAt: at })
      .where(eq(crmEntities.id, entityId));
    return ok({ ...entity, aliases: next, updatedAt: at });
  }

  async function resolveEntity(query: string): Promise<Result<CrmEntity>> {
    const trimmed = query.trim();
    if (!trimmed) return fail('invalid_input', 'I did not catch who you meant.');

    const exact = await findByNameOrAlias(trimmed);
    if (exact) return ok(exact);

    const entities = await allEntities();
    const outcome = resolveOne(
      trimmed,
      entities.map((entity) => ({
        item: entity,
        text: entity.name,
        aux: parseAliases(entity.aliases),
      })),
    );
    if (outcome.kind === 'unique') return ok(outcome.match.item);
    if (outcome.kind === 'none') return fail('not_found', `I have no contact called "${trimmed}".`);
    return fail('ambiguous', `Did you mean ${outcome.matches.map((m) => m.text).join(' or ')}?`, {
      details: outcome.matches.map((m) => ({ id: m.item.id, name: m.item.name, score: m.score })),
    });
  }

  async function addCommitment(
    input: AddCommitmentInput,
  ): Promise<{ entity: CrmEntity; commitment: CrmCommitment; interaction?: CrmInteraction }> {
    const text = input.commitmentText.trim();
    if (!text) throw new AppError('invalid_input', 'A commitment needs some words.');

    const at = now();
    // One user intent: never leave a bare contact behind if the commitment fails.
    db.$client.execSync('BEGIN');
    try {
      const entity = await getOrCreateEntity(input.entityName, {
        relationshipContext: input.relationshipContext,
      });
      const commitment: CrmCommitment = {
        id: newId(),
        entityId: entity.id,
        commitmentText: text,
        dueDate: input.dueDate ?? null,
        isCompleted: false,
        createdAt: at,
        direction: input.direction ?? 'i_owe',
        taskId: input.taskId ?? null,
        completedAt: null,
      };
      await db.insert(crmCommitments).values(commitment);

      // One utterance can carry both the promise and the conversation that
      // produced it, so the interaction belongs to this transaction too.
      const summary = input.interactionSummary?.trim();
      let interaction: CrmInteraction | undefined;
      if (summary) {
        interaction = { id: newId(), entityId: entity.id, summary, occurredAt: at, createdAt: at };
        await db.insert(crmInteractions).values(interaction);
      }

      db.$client.execSync('COMMIT');
      return { entity, commitment, interaction };
    } catch (error) {
      db.$client.execSync('ROLLBACK');
      throw error;
    }
  }

  /**
   * Points a commitment at the task that carries it.
   *
   * Separate from `addCommitment` because the task lives in another repository
   * and the two cannot share a transaction; writing the commitment first and
   * linking after means a failure costs the cross-reference, never the promise.
   */
  async function linkCommitmentTask(commitmentId: string, taskId: string): Promise<void> {
    await db
      .update(crmCommitments)
      .set({ taskId })
      .where(eq(crmCommitments.id, commitmentId));
  }

  async function logInteraction(
    input: LogInteractionInput,
  ): Promise<{ entity: CrmEntity; interaction: CrmInteraction }> {
    const summary = input.summary.trim();
    if (!summary) throw new AppError('invalid_input', 'An interaction needs a summary.');

    const at = now();
    db.$client.execSync('BEGIN');
    try {
      const entity = await getOrCreateEntity(input.entityName, {
        relationshipContext: input.relationshipContext,
      });
      const interaction: CrmInteraction = {
        id: newId(),
        entityId: entity.id,
        summary,
        occurredAt: input.occurredAt ?? at,
        createdAt: at,
      };
      await db.insert(crmInteractions).values(interaction);
      db.$client.execSync('COMMIT');
      return { entity, interaction };
    } catch (error) {
      db.$client.execSync('ROLLBACK');
      throw error;
    }
  }

  async function completeCommitment(
    id: string,
    completed = true,
  ): Promise<Result<CrmCommitment>> {
    const rows = await db.select().from(crmCommitments).where(eq(crmCommitments.id, id)).limit(1);
    const existing = rows[0];
    if (!existing) return fail('not_found', 'I could not find that commitment.');

    const completedAt = completed ? now() : null;
    await db
      .update(crmCommitments)
      .set({ isCompleted: completed, completedAt })
      .where(eq(crmCommitments.id, id));
    return ok({ ...existing, isCompleted: completed, completedAt });
  }

  // `is_completed` is nullable in the DDL, so NULL has to read as "open".
  const openClause = sql`coalesce(${crmCommitments.isCompleted}, 0) = 0`;

  async function listOpenCommitments(
    options: { dueBefore?: number } = {},
  ): Promise<CommitmentWithEntity[]> {
    const clauses: SQL[] = [openClause];
    // `lt` drops NULL due dates on its own: an undated promise is not overdue.
    if (options.dueBefore !== undefined) {
      clauses.push(lt(crmCommitments.dueDate, options.dueBefore));
    }
    return db
      .select({ commitment: crmCommitments, entity: crmEntities })
      .from(crmCommitments)
      .innerJoin(crmEntities, eq(crmEntities.id, crmCommitments.entityId))
      .where(and(...clauses))
      .orderBy(
        sql`${crmCommitments.dueDate} IS NULL`,
        asc(crmCommitments.dueDate),
        asc(crmCommitments.createdAt),
      );
  }

  async function listCommitmentsFor(entityId: string): Promise<CrmCommitment[]> {
    return db
      .select()
      .from(crmCommitments)
      .where(eq(crmCommitments.entityId, entityId))
      .orderBy(
        sql`coalesce(${crmCommitments.isCompleted}, 0)`,
        sql`${crmCommitments.dueDate} IS NULL`,
        asc(crmCommitments.dueDate),
        desc(crmCommitments.createdAt),
      );
  }

  async function transactionsFor(entity: CrmEntity, aliases: string[]): Promise<Transaction[]> {
    const names = [entity.name, ...aliases].map((n) => n.toLowerCase());
    if (names.length === 0) return [];
    return db
      .select()
      .from(transactions)
      .where(inArray(sql`lower(${transactions.entityName})`, names))
      .orderBy(desc(transactions.createdAt), desc(transactions.id));
  }

  async function getEntityProfile(entityId: string): Promise<Result<CrmEntityProfile>> {
    const entity = await findEntityById(entityId);
    if (!entity) return fail('not_found', 'I could not find that contact.');

    const aliases = parseAliases(entity.aliases);
    const interactions = await db
      .select()
      .from(crmInteractions)
      .where(eq(crmInteractions.entityId, entityId))
      .orderBy(desc(crmInteractions.occurredAt), desc(crmInteractions.id));
    const commitments = await listCommitmentsFor(entityId);
    const rows = await transactionsFor(entity, aliases);

    const spent = new Map<string, number>();
    const received = new Map<string, number>();
    for (const row of rows) {
      const sums = row.direction === 'income' ? received : spent;
      sums.set(row.currency, (sums.get(row.currency) ?? 0) + row.amount);
    }
    const net = new Map<string, number>();
    for (const [currency, value] of received) net.set(currency, (net.get(currency) ?? 0) + value);
    for (const [currency, value] of spent) net.set(currency, (net.get(currency) ?? 0) - value);

    return ok({
      entity,
      aliases,
      interactions,
      lastInteractionAt: interactions[0]?.occurredAt ?? null,
      openCommitments: commitments.filter((c) => !c.isCompleted),
      completedCommitments: commitments.filter((c) => Boolean(c.isCompleted)),
      transactions: rows,
      spentByCurrency: toRecord(spent),
      receivedByCurrency: toRecord(received),
      netByCurrency: toRecord(net),
    });
  }

  async function listEntities(): Promise<CrmEntitySummary[]> {
    const entities = await allEntities();
    const openCounts = await db
      .select({
        entityId: crmCommitments.entityId,
        count: sql<number>`count(*)`.mapWith(Number),
      })
      .from(crmCommitments)
      .where(openClause)
      .groupBy(crmCommitments.entityId);
    const interactionStats = await db
      .select({
        entityId: crmInteractions.entityId,
        count: sql<number>`count(*)`.mapWith(Number),
        last: sql<number>`max(${crmInteractions.occurredAt})`.mapWith(Number),
      })
      .from(crmInteractions)
      .groupBy(crmInteractions.entityId);

    const open = new Map(openCounts.map((r) => [r.entityId, r.count]));
    const seen = new Map(interactionStats.map((r) => [r.entityId, r]));

    return entities
      .map((entity) => {
        const stats = seen.get(entity.id);
        return {
          entity,
          aliases: parseAliases(entity.aliases),
          openCommitments: open.get(entity.id) ?? 0,
          interactionCount: stats?.count ?? 0,
          lastInteractionAt: stats?.last ?? null,
        };
      })
      .sort(
        (a, b) =>
          (b.lastInteractionAt ?? -1) - (a.lastInteractionAt ?? -1) ||
          b.entity.updatedAt - a.entity.updatedAt ||
          a.entity.name.localeCompare(b.entity.name),
      );
  }

  return {
    getOrCreateEntity,
    addAlias,
    resolveEntity,
    addCommitment,
    linkCommitmentTask,
    logInteraction,
    completeCommitment,
    listOpenCommitments,
    listCommitmentsFor,
    getEntityProfile,
    listEntities,
  };
}

export type CrmRepository = ReturnType<typeof createCrmRepository>;
