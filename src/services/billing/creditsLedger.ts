/**
 * How many bought requests this install has spent.
 *
 * The counterpart to `trialLedger.ts`, and deliberately half of it: the trial
 * stores both halves of its budget here, because both the allowance and the
 * spend are this app's to know. A top-up's *allowance* is not — RevenueCat
 * knows how many consumables were bought and this app only ever asks. So the
 * only number kept locally is `used`, and it is kept the same way for the same
 * reason: it is a lifetime counter, and a lifetime counter somewhere the user
 * can clear is a counter with a refund button on it.
 *
 * Both copies are read and the **larger** wins, so clearing either one cannot
 * hand back requests that were already spent. Android's keystore goes with the
 * app's data, so Clear Data still resets it there — the same honest gap the
 * trial has, and the same answer: the operator's backend is the real anchor on
 * the build where that matters.
 */
import * as SecureStore from 'expo-secure-store';

import { createLogger } from '@/core/logger';
import { getRepositories } from '@/repositories';

const log = createLogger('billing/credits');

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

const STORE_KEY = 'ridik.credits.used';

async function readDurable(): Promise<number> {
  try {
    const raw = await SecureStore.getItemAsync(STORE_KEY, OPTIONS);
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  } catch (error) {
    log.warn('could not read the durable credit counter', error);
    return 0;
  }
}

async function writeDurable(value: number): Promise<void> {
  try {
    await SecureStore.setItemAsync(STORE_KEY, String(Math.max(0, Math.trunc(value))), OPTIONS);
  } catch (error) {
    log.warn('could not mirror the credit counter', error);
  }
}

/**
 * Bought requests already spent.
 *
 * `NaN` when the database could not be read — which `creditsRemaining()` reads
 * as "no credits", not as "none spent". Guessing generously here would make a
 * broken database a source of free requests on somebody else's key; guessing
 * strictly costs a user a balance the store can still prove they own.
 */
export async function readCreditsUsed(): Promise<number> {
  const durable = await readDurable();

  let stored = Number.NaN;
  try {
    stored = await getRepositories().settings.get('llmCreditsUsed');
  } catch (error) {
    log.warn('could not read the credit counter', error);
    return durable > 0 ? durable : Number.NaN;
  }

  const used = Math.max(stored, durable);
  // One store having been cleared is the case this exists for, so the survivor
  // is written back rather than merely preferred for this one read.
  if (used > stored) {
    try {
      await getRepositories().settings.set('llmCreditsUsed', used);
    } catch (error) {
      log.warn('could not restore the credit counter from the durable copy', error);
    }
  }
  return used;
}

/**
 * Spends bought requests. Never throws.
 *
 * One per utterance, the unit they were sold in — repairs are the app's own
 * retries and are not charged to somebody's balance, exactly as they are not
 * charged to the trial's `requests`.
 *
 * Through `settings.bump`, which reads and writes inside one queued job: a
 * plain get-then-set is a lost update, and what is lost is the record of how
 * much of a purchase has been consumed.
 */
export async function chargeCredits(requests: number): Promise<void> {
  const draw = Math.max(0, Math.trunc(requests));
  if (draw === 0) return;

  let used: number | null = null;
  try {
    used = await getRepositories().settings.bump('llmCreditsUsed', draw);
  } catch (error) {
    log.warn('could not record a credit request', error);
  }
  if (used == null) return;
  await writeDurable(used);
}
