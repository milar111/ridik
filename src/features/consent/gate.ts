/**
 * The gate the voice pipeline asks before it may spend a request on a model.
 *
 * Deliberately free of React and of every native module, for the same reason
 * `@/features/voice/mode` is: it sits on the money path of every turn, it has
 * to be readable under plain Node, and the pipeline must be able to import it
 * without dragging a screen in. `./index` re-exports it alongside the UI; the
 * pipeline imports *this file*, not the barrel.
 *
 * There is one rule in here and it is the whole point of the feature: an answer
 * this module is not sure about is not permission. A database that will not
 * open, a row holding something no schema recognises, a key that has never been
 * written — all three come back `unset`, and `unset` does not reach a provider.
 * Failing the other way would mean a device with a broken SQLite file sending a
 * stranger's speech to Google on the strength of not having been able to check,
 * which is precisely the thing the screen exists to promise never happens.
 */
import { now } from '@/core/clock';
import { createLogger } from '@/core/logger';
import {
  DEFAULT_ASSISTANT_CONSENT,
  mayReachProvider,
  type AssistantConsent,
} from '@/llm/consent';
import { getRepositories } from '@/repositories';
import type { SettingsValues } from '@/repositories/settings';

const log = createLogger('consent');

/** Anything that is not one of the three known answers is "never asked". */
function normalise(value: unknown): AssistantConsent {
  return value === 'granted' || value === 'declined' ? value : DEFAULT_ASSISTANT_CONSENT;
}

/**
 * What this install has decided, or `unset` if it has not — or if we could not
 * find out, which counts as the same thing. Never throws.
 */
export async function readAssistantConsent(): Promise<AssistantConsent> {
  try {
    return normalise(await getRepositories().settings.get('assistantConsent'));
  } catch (error) {
    // Not an error the user sees. The turn it belongs to still gets answered,
    // offline, with a notice saying so.
    log.warn('could not read the assistant consent; treating it as not given', error);
    return DEFAULT_ASSISTANT_CONSENT;
  }
}

/** The one question the pipeline actually asks. */
export async function assistantMayReachProvider(): Promise<boolean> {
  return mayReachProvider(await readAssistantConsent());
}

/**
 * Everything a decision writes, as one patch.
 *
 * Three rows, and they go together or not at all — `setMany` is transactional,
 * so there is no state where the decision landed and the timestamp did not.
 *
 * `onboardingComplete` is set by *either* answer, and that is not a shortcut:
 * a first run in this app is one question, and someone who declined has
 * finished it just as completely as someone who agreed. It stays true if they
 * later revoke, because the screen has still been seen.
 */
export function consentPatch(
  decision: Exclude<AssistantConsent, 'unset'>,
  at: number = now(),
): Partial<SettingsValues> {
  return {
    assistantConsent: decision,
    assistantConsentAt: at,
    onboardingComplete: true,
  };
}
