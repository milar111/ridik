/**
 * Which way this build reaches the assistant, and the keychain slots it reads.
 *
 * Deliberately a leaf: it imports the keychain and the build config and nothing
 * else. Settings has to ask "is there even a key field to show here?", and that
 * question must not drag in the speech recogniser — a screen that renders fine
 * on a device would otherwise be untestable, and unmountable anywhere the
 * native voice modules are absent.
 */
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

import { createLogger } from '@/core/logger';

const log = createLogger('assistant-mode');

export const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

/** The provider key, on builds that talk to a provider directly. */
export const LLM_API_KEY_STORE_KEY = 'ridik.llm.apiKey';

/** The transcription fallback's own key. */
export const WHISPER_API_KEY_STORE_KEY = 'ridik.whisper.apiKey';

/** AssemblyAI's, for the engine that can replace the recogniser outright. */
export const ASSEMBLYAI_API_KEY_STORE_KEY = 'ridik.assemblyai.apiKey';

/**
 * The session token a store build presents to your backend. Whatever issues
 * identity — RevenueCat, Supabase auth, your own sign-in — writes it here; the
 * app only reads it, and only over TLS to the URL baked into the build.
 */
export const ASSISTANT_TOKEN_STORE_KEY = 'ridik.assistant.token';

/**
 * Store a secret, and never let failing to do so break the caller.
 *
 * The one writer today is the billing provider, recording the identity a store
 * build presents to the backend. If the keychain refuses, the turn that needed
 * the token degrades to the offline matcher with a notice — a path the app
 * already has — which is strictly better than a crash on the way out of
 * `configure()`, before the UI has mounted.
 */
export async function writeSecret(key: string, value: string): Promise<boolean> {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    await SecureStore.setItemAsync(key, trimmed, SECURE_STORE_OPTIONS);
    return true;
  } catch (error) {
    log.warn('could not store a key', { key, error });
    return false;
  }
}

/** A keychain that will not open is a missing key, not a crash. */
export async function readSecret(key: string): Promise<string | null> {
  try {
    const value = await SecureStore.getItemAsync(key, SECURE_STORE_OPTIONS);
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  } catch (error) {
    log.warn('could not read a stored key', { key, error });
    return null;
  }
}

/** Set in store builds; empty in your own. See `app.config.ts`. */
export function assistantApiUrl(): string {
  const extra = (Constants.expoConfig?.extra ?? {}) as { assistantApiUrl?: string };
  return (extra.assistantApiUrl ?? '').trim();
}

export type AssistantMode = 'hosted' | 'personal-key' | 'offline';

export async function assistantMode(): Promise<AssistantMode> {
  if (assistantApiUrl()) return 'hosted';
  return (await readSecret(LLM_API_KEY_STORE_KEY)) ? 'personal-key' : 'offline';
}
