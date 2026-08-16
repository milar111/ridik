/**
 * What this install has spent of its free trial, and where that is kept.
 *
 * The trial is the only budget in the app that is *lifetime*: 25 requests, per
 * install, with nothing that refills them but a plan. That makes where the
 * counter lives part of the control rather than an implementation detail — a
 * lifetime budget stored somewhere the user can reset is a budget with a reset
 * button on it, and there were three of them.
 *
 * So the counters are kept twice:
 *
 *   `app_settings`   the working copy. Queryable, migrated, and what the
 *                    developer screen reads. Also what "Erase everything"
 *                    used to take with it, which is why `db/wipe.ts` now
 *                    preserves exactly these two rows.
 *   SecureStore      the durable copy. On iOS a Keychain item outlives the app
 *                    that wrote it by default, so uninstalling and reinstalling
 *                    no longer hands out a fresh trial.
 *
 * Reads take the **larger** of the two and heal the smaller, so neither store
 * can be lowered by clearing the other. Android is the honest gap: its keystore
 * entries go with the app's data, so Clear Data still works there, and the only
 * real anchor for that platform is a counter the operator's backend holds
 * against an account. That backend is what a store build talks to anyway — this
 * is the client-side half, and it is defence in depth rather than the last word.
 */
import * as SecureStore from 'expo-secure-store';

import { createLogger } from '@/core/logger';
import { getRepositories } from '@/repositories';

import type { TrialLedger } from './allowance';

const log = createLogger('billing/trial');

/** Matches the accessibility the rest of the app's secrets use. */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

const STORE_KEYS = {
  requestsUsed: 'ridik.trial.requestsUsed',
  tokensUsed: 'ridik.trial.tokensUsed',
} as const;

/** Nothing here may throw: it runs on the money path of every voice turn. */
async function readDurable(key: string): Promise<number> {
  try {
    const raw = await SecureStore.getItemAsync(key, OPTIONS);
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  } catch (error) {
    log.warn('could not read the durable trial counter', { key, error });
    return 0;
  }
}

async function writeDurable(key: string, value: number): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, String(Math.max(0, Math.trunc(value))), OPTIONS);
  } catch (error) {
    log.warn('could not mirror the trial counter', { key, error });
  }
}

/**
 * The trial's lifetime spend, in both units.
 *
 * An unreadable database is reported as `NaN` rather than as zero, because the
 * caller reads an unreadable counter as *spent* — the alternative is a way to
 * get another 25 requests by breaking SQLite, and the failure mode of guessing
 * wrong in that direction is one user losing a trial they might have had.
 */
export async function readTrialLedger(): Promise<TrialLedger> {
  const [durableRequests, durableTokens] = await Promise.all([
    readDurable(STORE_KEYS.requestsUsed),
    readDurable(STORE_KEYS.tokensUsed),
  ]);

  let storedRequests = Number.NaN;
  let storedTokens = Number.NaN;
  try {
    const settings = getRepositories().settings;
    [storedRequests, storedTokens] = await Promise.all([
      settings.get('llmTrialRequestsUsed'),
      settings.get('llmTrialTokensUsed'),
    ]);
  } catch (error) {
    log.warn('could not read the trial counters; treating the trial as spent', error);
    // The durable copy may still know better than "spent", so it is not
    // discarded — but a missing database cannot be healed from here.
    return {
      requestsUsed: durableRequests > 0 ? durableRequests : Number.NaN,
      tokensUsed: durableTokens > 0 ? durableTokens : Number.NaN,
    };
  }

  const requestsUsed = Math.max(storedRequests, durableRequests);
  const tokensUsed = Math.max(storedTokens, durableTokens);

  // One store having been cleared is exactly the case this exists for, so the
  // survivor is written back rather than merely preferred for this one read.
  await heal(storedRequests, storedTokens, requestsUsed, tokensUsed);

  return { requestsUsed, tokensUsed };
}

async function heal(
  storedRequests: number,
  storedTokens: number,
  requestsUsed: number,
  tokensUsed: number,
): Promise<void> {
  try {
    const settings = getRepositories().settings;
    if (requestsUsed > storedRequests) {
      await settings.set('llmTrialRequestsUsed', requestsUsed);
    }
    if (tokensUsed > storedTokens) await settings.set('llmTrialTokensUsed', tokensUsed);
  } catch (error) {
    log.warn('could not restore the trial counters from the durable copy', error);
  }
}

/**
 * Spends part of the trial. Never throws.
 *
 * `requests` is one per utterance — that is the unit the user was sold — and
 * `tokens` is everything the turn actually billed, summed across the repair
 * ladder, because that is the unit the operator is invoiced in and the only one
 * that can tell a "hello" from a pasted novel.
 *
 * The increment goes through `settings.bump`, which does the read and the write
 * inside one queued job. A plain get-then-set here was a lost update, and the
 * thing being lost was the count of how much of somebody else's money had been
 * spent: ten concurrent turns each read the same number and each wrote it back
 * plus one.
 */
export async function chargeTrial(draw: { requests: number; tokens: number }): Promise<void> {
  const requests = Math.max(0, Math.trunc(draw.requests));
  const tokens = Math.max(0, Math.trunc(draw.tokens));
  if (requests === 0 && tokens === 0) return;

  let totals: { requestsUsed: number; tokensUsed: number } | null = null;
  try {
    const settings = getRepositories().settings;
    const requestsUsed = await settings.bump('llmTrialRequestsUsed', requests);
    const tokensUsed = await settings.bump('llmTrialTokensUsed', tokens);
    totals = { requestsUsed, tokensUsed };
  } catch (error) {
    log.warn('could not record a trial request', error);
  }

  if (!totals) return;
  await Promise.all([
    writeDurable(STORE_KEYS.requestsUsed, totals.requestsUsed),
    writeDurable(STORE_KEYS.tokensUsed, totals.tokensUsed),
  ]);
}
