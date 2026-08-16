/**
 * The assistant's audit trail, for the one screen that reads it.
 *
 * Everything here is a plain query over `llm_interactions`. There is no
 * optimistic path and there deliberately is not one: this is the record of what
 * the user said, and a row that briefly disappears from a list before a delete
 * has actually happened would be the screen telling the same kind of lie the
 * screen exists to catch.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { getRepositories } from '@/repositories';
import type {
  Interaction,
  InteractionStats,
  InteractionStatus,
} from '@/repositories/llmInteractions';

import { invalidateKeys, qk } from './keys';

export type HistoryFilter = { limit?: number; status?: InteractionStatus };

/** Newest first. The default page is deep enough to scroll and cheap to hold. */
export function useInteractionHistory(filter: HistoryFilter = {}): UseQueryResult<Interaction[]> {
  const limit = filter.limit ?? 100;
  const status = filter.status ?? null;
  return useQuery({
    queryKey: qk.history.list(limit, status),
    queryFn: () =>
      getRepositories().llmInteractions.listRecent({
        limit,
        ...(status ? { status } : {}),
      }),
  });
}

/** One turn, in full. */
export function useInteraction(
  id: string | undefined,
  options: { enabled?: boolean } = {},
): UseQueryResult<Interaction | null> {
  return useQuery({
    queryKey: qk.history.detail(id ?? ''),
    queryFn: () => getRepositories().llmInteractions.getById(id!),
    enabled: (options.enabled ?? true) && Boolean(id),
  });
}

/** How the trail behaves as a whole: outcomes, latency percentiles, models. */
export function useInteractionStats(): UseQueryResult<InteractionStats> {
  return useQuery({
    queryKey: qk.history.stats(),
    queryFn: () => getRepositories().llmInteractions.stats(),
  });
}

export function useForgetInteraction(): UseMutationResult<boolean, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getRepositories().llmInteractions.remove(id),
    onSettled: () => invalidateKeys(client, [qk.history.all]),
  });
}

/**
 * Clears the whole trail, and resolves with how many turns went.
 *
 * The count is the receipt: "1,204 turns deleted" is the only evidence the user
 * gets that a button on a privacy screen did what it said.
 */
export function useClearInteractionHistory(): UseMutationResult<number, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => getRepositories().llmInteractions.clear(),
    onSettled: () => invalidateKeys(client, [qk.history.all]),
  });
}

export type { Interaction, InteractionStats, InteractionStatus };
