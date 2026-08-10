/**
 * The micro-financial ledger.
 *
 * A transaction can name a person and a project, and both of those screens show
 * money totals of their own — so a single "I spent 12 euros on coffee with Ivo"
 * invalidates three domains, not one.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { unwrap } from '@/core/result';
import { currentZone } from '@/core/time';
import type { Transaction } from '@/db/schema';
import { getRepositories } from '@/repositories';
import type {
  AddTransactionInput,
  LedgerQueryResult,
  LedgerQuerySpec,
  MonthlyTotal,
  TransactionPatch,
} from '@/repositories/ledger';

import { invalidateKeys, qk } from './keys';

/** Entity profiles and project overviews both sum the rows this touches. */
const LEDGER_WRITE_KEYS = [qk.ledger.all, qk.crm.all, qk.projects.all] as const;

/* ------------------------------------------------------------------- reads */

export function useLedgerQuery(spec: LedgerQuerySpec = {}): UseQueryResult<LedgerQueryResult> {
  return useQuery({
    queryKey: qk.ledger.query(spec),
    queryFn: () => getRepositories().ledger.query(spec),
  });
}

export function useRecentTransactions(limit = 50): UseQueryResult<Transaction[]> {
  return useQuery({
    queryKey: qk.ledger.recent(limit),
    queryFn: () => getRepositories().ledger.listRecent(limit),
  });
}

export function useTransactionsForEntity(
  name: string | undefined,
  options: { limit?: number; enabled?: boolean } = {},
): UseQueryResult<Transaction[]> {
  const limit = options.limit ?? 200;
  return useQuery({
    queryKey: qk.ledger.forEntity(name ?? '', limit),
    queryFn: () => getRepositories().ledger.listForEntity(name!, limit),
    enabled: (options.enabled ?? true) && Boolean(name),
  });
}

export function useLedgerCategories(): UseQueryResult<string[]> {
  return useQuery({
    queryKey: qk.ledger.categories(),
    queryFn: () => getRepositories().ledger.distinctCategories(),
  });
}

export function useMonthlyTotals(
  months = 6,
  options: { zone?: string } = {},
): UseQueryResult<MonthlyTotal[]> {
  const zone = options.zone ?? currentZone();
  return useQuery({
    queryKey: qk.ledger.monthly(months, zone),
    queryFn: () => getRepositories().ledger.monthlyTotals(months, { zone }),
  });
}

/* ------------------------------------------------------------------ writes */

export function useAddTransaction(): UseMutationResult<Transaction, Error, AddTransactionInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: AddTransactionInput) => getRepositories().ledger.addTransaction(input),
    onSettled: () => invalidateKeys(client, LEDGER_WRITE_KEYS),
  });
}

export function useUpdateTransaction(): UseMutationResult<
  Transaction,
  Error,
  { id: string; patch: TransactionPatch }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; patch: TransactionPatch }) =>
      unwrap(await getRepositories().ledger.updateTransaction(input.id, input.patch)),
    onSettled: () => invalidateKeys(client, LEDGER_WRITE_KEYS),
  });
}

export function useDeleteTransaction(): UseMutationResult<Transaction, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await getRepositories().ledger.deleteTransaction(id)),
    onSettled: () => invalidateKeys(client, LEDGER_WRITE_KEYS),
  });
}
