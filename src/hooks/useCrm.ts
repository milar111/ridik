/**
 * The micro-CRM: people, what was said, and what is still owed.
 *
 * Open commitments are one of the things Today lists, so completing one has to
 * refresh the home screen as well as the person's page.
 */
import { eq } from 'drizzle-orm';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { now } from '@/core/clock';
import { normalise } from '@/core/match';
import { AppError, unwrap } from '@/core/result';
import { crmEntities } from '@/db/schema';
import type { CrmCommitment, CrmEntity, CrmInteraction } from '@/db/schema';
import { getRepositories } from '@/repositories';
import { parseAliases } from '@/repositories/crm';
import type {
  AddCommitmentInput,
  CommitmentWithEntity,
  CrmEntityProfile,
  CrmEntitySummary,
  LogInteractionInput,
} from '@/repositories/crm';

import { invalidateKeys, qk } from './keys';

/** Commitments due today are on the home screen. */
const CRM_WRITE_KEYS = [qk.crm.all, qk.today.all] as const;

/* ------------------------------------------------------------------- reads */

export function useCrmEntities(): UseQueryResult<CrmEntitySummary[]> {
  return useQuery({
    queryKey: qk.crm.entities(),
    queryFn: () => getRepositories().crm.listEntities(),
  });
}

export function useCrmProfile(
  entityId: string | undefined,
  options: { enabled?: boolean } = {},
): UseQueryResult<CrmEntityProfile> {
  return useQuery({
    queryKey: qk.crm.profile(entityId ?? ''),
    queryFn: async () => unwrap(await getRepositories().crm.getEntityProfile(entityId!)),
    enabled: (options.enabled ?? true) && Boolean(entityId),
  });
}

/** `dueBefore` drops undated promises: an open-ended favour is never overdue. */
export function useOpenCommitments(
  options: { dueBefore?: number } = {},
): UseQueryResult<CommitmentWithEntity[]> {
  return useQuery({
    queryKey: qk.crm.openCommitments(options.dueBefore ?? null),
    queryFn: () => getRepositories().crm.listOpenCommitments(options),
  });
}

export function useCommitmentsFor(
  entityId: string | undefined,
  options: { enabled?: boolean } = {},
): UseQueryResult<CrmCommitment[]> {
  return useQuery({
    queryKey: qk.crm.commitmentsFor(entityId ?? ''),
    queryFn: () => getRepositories().crm.listCommitmentsFor(entityId!),
    enabled: (options.enabled ?? true) && Boolean(entityId),
  });
}

/* ------------------------------------------------------------------ writes */

export function useAddCommitment(): UseMutationResult<
  { entity: CrmEntity; commitment: CrmCommitment; interaction?: CrmInteraction },
  Error,
  AddCommitmentInput
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: AddCommitmentInput) => getRepositories().crm.addCommitment(input),
    onSettled: () => invalidateKeys(client, CRM_WRITE_KEYS),
  });
}

export function useCompleteCommitment(): UseMutationResult<
  CrmCommitment,
  Error,
  { id: string; completed?: boolean }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; completed?: boolean }) =>
      unwrap(await getRepositories().crm.completeCommitment(input.id, input.completed ?? true)),
    onSettled: () => invalidateKeys(client, CRM_WRITE_KEYS),
  });
}

export function useLogInteraction(): UseMutationResult<
  { entity: CrmEntity; interaction: CrmInteraction },
  Error,
  LogInteractionInput
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: LogInteractionInput) => getRepositories().crm.logInteraction(input),
    onSettled: () => invalidateKeys(client, CRM_WRITE_KEYS),
  });
}

export function useGetOrCreateEntity(): UseMutationResult<
  CrmEntity,
  Error,
  { name: string; relationshipContext?: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; relationshipContext?: string }) =>
      getRepositories().crm.getOrCreateEntity(input.name, {
        relationshipContext: input.relationshipContext,
      }),
    onSettled: () => invalidateKeys(client, CRM_WRITE_KEYS),
  });
}

export function useAddEntityAlias(): UseMutationResult<
  CrmEntity,
  Error,
  { entityId: string; alias: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { entityId: string; alias: string }) =>
      unwrap(await getRepositories().crm.addAlias(input.entityId, input.alias)),
    onSettled: () => invalidateKeys(client, [qk.crm.all]),
  });
}

export function useResolveEntity(): UseMutationResult<CrmEntity, Error, string> {
  return useMutation({
    mutationFn: async (query: string) =>
      unwrap(await getRepositories().crm.resolveEntity(query)),
  });
}

/* ------------------------------------------------------- hand edits (screen) */

/**
 * The two writes below have no repository method behind them because the voice
 * path never needs them: `getOrCreateEntity` only ever *fills* a blank
 * relationship context and aliases only ever grow. A person's detail screen is
 * where a mistake gets corrected by hand, so both go straight at the row.
 */

export function useUpdateEntityContext(): UseMutationResult<
  void,
  Error,
  { entityId: string; relationshipContext: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { entityId: string; relationshipContext: string }) => {
      const trimmed = input.relationshipContext.trim();
      await getRepositories()
        .db.update(crmEntities)
        // Empty clears the field rather than storing "": a blank context is a
        // missing one everywhere else in the app.
        .set({ relationshipContext: trimmed || null, updatedAt: now() })
        .where(eq(crmEntities.id, input.entityId));
    },
    onSettled: () => invalidateKeys(client, [qk.crm.all]),
  });
}

export function useRemoveEntityAlias(): UseMutationResult<
  void,
  Error,
  { entityId: string; alias: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { entityId: string; alias: string }) => {
      const db = getRepositories().db;
      const rows = await db
        .select()
        .from(crmEntities)
        .where(eq(crmEntities.id, input.entityId))
        .limit(1);
      const entity = rows[0];
      if (!entity) throw new AppError('not_found', 'I could not find that contact.');

      const target = normalise(input.alias);
      const next = parseAliases(entity.aliases).filter((a) => normalise(a) !== target);
      await db
        .update(crmEntities)
        .set({ aliases: next.length > 0 ? JSON.stringify(next) : null, updatedAt: now() })
        .where(eq(crmEntities.id, input.entityId));
    },
    onSettled: () => invalidateKeys(client, [qk.crm.all]),
  });
}
