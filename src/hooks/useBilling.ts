import { useMutation, useQuery, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';

import {
  billingIsConfigured,
  currentEntitlement,
  purchasePlan,
  restorePurchases,
  type Entitlement,
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

/** False in a build with no store SDK compiled in; the profile hides the plan. */
export function useBillingAvailable(): boolean {
  return billingIsConfigured();
}

export function usePurchasePlan(): UseMutationResult<Entitlement, Error, Exclude<PlanId, 'free'>> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (plan: Exclude<PlanId, 'free'>) => purchasePlan(plan),
    onSettled: () => invalidateKeys(client, [qk.billing.all]),
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
