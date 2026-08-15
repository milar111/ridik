import { useMutation, useQuery, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';

import {
  availablePlans,
  currentEntitlement,
  purchasePlan,
  restorePurchases,
  type Entitlement,
  type Plan,
  type PlanId,
} from '@/services/billing/entitlement';
import { invalidateKeys, qk } from './keys';
import { useQueryClient } from '@tanstack/react-query';

/**
 * What the user is entitled to.
 *
 * Refetched on focus because the answer changes outside the app — a purchase
 * completed in the store, a card that stopped working, a cancellation made from
 * the phone's own subscription screen.
 */
export function useEntitlement(): UseQueryResult<Entitlement> {
  return useQuery({
    queryKey: qk.billing.entitlement(),
    queryFn: () => currentEntitlement(),
    staleTime: 60_000,
  });
}

export function usePurchasePlan(): UseMutationResult<Entitlement, Error, PlanId> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (plan: PlanId) => purchasePlan(plan),
    onSettled: () => invalidateKeys(client, [qk.billing.all]),
  });
}

/** What is for sale, priced by the store in the buyer's own currency. */
export function usePlans(): UseQueryResult<Plan[]> {
  return useQuery({
    queryKey: qk.billing.plans(),
    queryFn: () => availablePlans(),
    staleTime: 5 * 60_000,
  });
}

/**
 * Both stores require this: a paying user who reinstalls, or signs in on a
 * second device, must be able to get their plan back without paying again.
 */
export function useRestorePurchases(): UseMutationResult<Entitlement, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => restorePurchases(),
    onSettled: () => invalidateKeys(client, [qk.billing.all]),
  });
}
