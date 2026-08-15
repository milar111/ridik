/**
 * The micro-CRM: people, what was said, and what is still owed.
 *
 * Open commitments are one of the things Today lists, so completing one has to
 * refresh the home screen as well as the person's page.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { unwrap } from '@/core/result';
import type { CrmCommitment, CrmEntity, CrmInteraction } from '@/db/schema';
import { getRepositories } from '@/repositories';
import type {
  AddCommitmentInput,
  CommitmentWithEntity,
  CrmEntityProfile,
  CrmEntitySummary,
  EntityDeletion,
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
 * Corrections the voice path never makes: `getOrCreateEntity` only ever fills a
 * blank context, and aliases only ever grow. A person's detail screen is where
 * a mistake gets fixed by hand.
 */

export function useUpdateEntityContext(): UseMutationResult<
  CrmEntity,
  Error,
  { entityId: string; relationshipContext: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { entityId: string; relationshipContext: string }) =>
      unwrap(
        await getRepositories().crm.setRelationshipContext(
          input.entityId,
          input.relationshipContext,
        ),
      ),
    onSettled: () => invalidateKeys(client, [qk.crm.all]),
  });
}

export function useRemoveEntityAlias(): UseMutationResult<
  CrmEntity,
  Error,
  { entityId: string; alias: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { entityId: string; alias: string }) =>
      unwrap(await getRepositories().crm.removeAlias(input.entityId, input.alias)),
    onSettled: () => invalidateKeys(client, [qk.crm.all]),
  });
}

/* ----------------------------------------------------------------- deletes */

/**
 * `confirmed` is not a formality: the repository refuses without it, because
 * everything here can be created by a mis-heard sentence and none of it comes
 * back. The screen that asks the question is the one that sets the flag.
 */
export function useDeleteEntity(): UseMutationResult<
  EntityDeletion,
  Error,
  { entityId: string; confirmed?: boolean }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { entityId: string; confirmed?: boolean }) =>
      unwrap(
        await getRepositories().crm.deleteEntity(input.entityId, {
          confirmed: input.confirmed ?? false,
        }),
      ),
    onSettled: () => invalidateKeys(client, CRM_WRITE_KEYS),
  });
}

export function useRemoveInteraction(): UseMutationResult<CrmInteraction, Error, { id: string }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string }) =>
      unwrap(await getRepositories().crm.removeInteraction(input.id)),
    onSettled: () => invalidateKeys(client, [qk.crm.all]),
  });
}

export function useRemoveCommitment(): UseMutationResult<CrmCommitment, Error, { id: string }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string }) =>
      unwrap(await getRepositories().crm.removeCommitment(input.id)),
    onSettled: () => invalidateKeys(client, CRM_WRITE_KEYS),
  });
}
