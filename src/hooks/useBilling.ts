import { useMutation, useQuery, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';

import {
  availablePlans,
  planMarketing,
  currentEntitlement,
  purchasePlan,
  purchaseTopUp,
  restorePurchases,
  topUpProduct,
  topUpsPurchased,
  type TopUpProduct,
  type Entitlement,
  type Marketing,
  type Plan,
} from '@/services/billing/entitlement';
import { purchasedFrom, type CreditLedger } from '@/services/billing/credits';
import { readCreditsUsed } from '@/services/billing/creditsLedger';
import { readTrialLedger } from '@/services/billing/trialLedger';
import { mergeTrial, type TrialLedger } from '@/services/billing/allowance';
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

export function usePurchasePlan(): UseMutationResult<Entitlement, Error, Plan> {
  const client = useQueryClient();
  return useMutation({
    // The whole Plan, not its id: two products can share a billing period and
    // differ only in the allowance, so the id alone does not identify one.
    mutationFn: (plan: Plan) => purchasePlan(plan.id, plan.tier),
    onSettled: () => invalidateKeys(client, [qk.billing.all]),
  });
}

/**
 * The top-up balance: bought, minus spent.
 *
 * Two halves from two places on purpose — the store owns what was purchased and
 * the device owns what has been used — so this is the one reader that puts them
 * together. See `credits.ts` for why neither half may answer the other's
 * question.
 */
export function useCredits(): UseQueryResult<CreditLedger> {
  return useQuery({
    queryKey: qk.billing.credits,
    queryFn: async (): Promise<CreditLedger> => ({
      // `topUpsPurchased()` counts *transactions*; the ledger is denominated in
      // requests. Storing the count raw made a $3 purchase worth one request.
      purchased: purchasedFrom(await topUpsPurchased()),
      used: await readCreditsUsed(),
    }),
  });
}

/**
 * The trial's lifetime spend, from BOTH stores.
 *
 * Every screen that shows "N of 25 free requests left" was reading
 * `llmTrialRequestsUsed` straight out of `app_settings` — which is only half
 * the ledger. `trialLedger.ts` keeps a durable mirror in the keychain precisely
 * because SQLite does not survive a reinstall and, on iOS, the keychain does.
 *
 * So: spend all 25, delete the app, reinstall. The mirror survives and the
 * database does not, the settings row falls back to 0, and both the consent
 * screen and the Plan row announced a full trial. The user made a decision
 * about sending their data on the strength of that, and the first voice turn —
 * the only caller of `readTrialLedger()` — refused with "that is all 25 of your
 * free assistant requests".
 *
 * Reading through the ledger also *heals* the settings rows upward as a side
 * effect, which is safe outside a voice turn because it can only ever raise a
 * counter that is monotonic by design.
 */
export function useTrialLedger(): UseQueryResult<TrialLedger> {
  return useQuery({ queryKey: qk.billing.trial, queryFn: () => readTrialLedger() });
}


/** What a top-up costs, in the buyer's own currency. Null when unavailable. */
export function useTopUpPrice(): UseQueryResult<TopUpProduct | null> {
  return useQuery({ queryKey: qk.billing.topUp, queryFn: () => topUpProduct() });
}

/** Buys one top-up. Invalidates the balance, which is the point of buying it. */
export function usePurchaseTopUp(): UseMutationResult<number, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => purchaseTopUp(),
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

/** Paywall copy from the store's dashboard, or null to use the app's own. */
export function usePlanMarketing(): UseQueryResult<Marketing | null> {
  return useQuery({
    queryKey: qk.billing.marketing(),
    queryFn: () => planMarketing(),
    staleTime: 30 * 60_000,
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

/** Re-exported so a screen needs one import for the trial read-out. */
export { mergeTrial };
