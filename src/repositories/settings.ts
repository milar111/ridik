/**
 * Typed key-value store over `app_settings`.
 *
 * Every key declares its validator and its default in one place, so reads are
 * total: a missing row, hand-edited JSON or a value left behind by an older
 * build all degrade to the default instead of crashing the screen that asked.
 *
 * Secrets never live here — `llmApiKeyPresent` is a flag, the key itself is in
 * SecureStore.
 */
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import { now } from '@/core/clock';
import type { Logger } from '@/core/logger';
import { AppError } from '@/core/result';
import { currentZone } from '@/core/time';
import type { RidikDatabase } from '@/db/migrator';
import { appSettings } from '@/db/schema';

// Tokens, not components: `@/ui/theme` is a constants module with no react and
// no react-native in it, which the `logic` test project already proves by
// loading it under plain Node. Naming the embers here as well would put the one
// list this app has of them in two places.
import { DEFAULT_EMBER, EMBER_NAMES, type EmberName } from '@/ui/theme';

import { serialised, transactional } from './transaction';

type SettingDefinition<T> = {
  schema: z.ZodType<T>;
  /** A thunk because some defaults (the timezone) are read from the device. */
  fallback: () => T;
};

const define = <T>(schema: z.ZodType<T>, fallback: () => T): SettingDefinition<T> => ({
  schema,
  fallback,
});

export const DEFAULT_LLM_MODEL = 'claude-opus-5';

export const SETTINGS = {
  timezone: define(z.string().min(1), () => currentZone()),
  llmModel: define(z.string().min(1).max(120), () => DEFAULT_LLM_MODEL),
  /** Informational only: the key itself lives in SecureStore, never in SQLite. */
  llmApiKeyPresent: define(z.boolean(), () => false),
  voiceConfidenceThreshold: define(z.number().min(0).max(1), () => 0.7),
  silenceTimeoutMs: define(z.number().int().min(200).max(10_000), () => 1500),
  defaultBufferMinutes: define(z.number().int().min(0).max(240), () => 20),
  /**
   * The local date the briefing was last put in front of the user, or null.
   *
   * Replaced `briefingHour` and `briefingEnabled`. The briefing is no longer a
   * scheduled notification you configure — it is shown once, on the first time
   * you open the app on a given day — so what the app needs to remember is not
   * when to send it but whether today's has already been seen.
   */
  lastBriefingShown: define<string | null>(z.string().min(1).nullable(), () => null),
  /**
   * Off by default. A device's default voice is its lowest-quality one, and
   * having it read back every confirmation makes the app feel worse than
   * silence does. `src/voice/tts.ts` now asks for the best installed voice,
   * which helps, but the good ones are a download the user has to make — so
   * this stays something they turn on once they have heard it.
   */
  ttsEnabled: define(z.boolean(), () => false),
  ttsRate: define(z.number().min(0.1).max(2), () => 1),
  primaryCurrency: define(z.string().regex(/^[A-Z]{3}$/), () => 'EUR'),
  /**
   * Which ember the app and its home-screen widgets are drawn in.
   *
   * A closed set, so a hand-edited row or one written by a build that shipped a
   * fourth ember decodes to the default rather than to a colour nothing can
   * resolve. The palettes themselves live in `@/ui/theme`.
   */
  ember: define<EmberName>(z.enum(EMBER_NAMES as [EmberName, ...EmberName[]]), () => DEFAULT_EMBER),
  googleCalendarId: define<string | null>(z.string().min(1).nullable(), () => null),
  googleAccountEmail: define<string | null>(z.string().min(1).nullable(), () => null),
  onboardingComplete: define(z.boolean(), () => false),
  weekStartsOn: define<0 | 1>(z.union([z.literal(0), z.literal(1)]), () => 1),
  whisperFallbackEnabled: define(z.boolean(), () => true),

  /**
   * The app's own spend ceiling, counted in assistant requests rather than
   * money: a request is something a person can reason about, and it holds even
   * if the provider changes its prices. 0 means unlimited. Past the cap, voice
   * still works — it falls back to offline pattern matching.
   */
  llmDailyRequestCap: define(z.number().int().min(0).max(100_000), () => 200),
  llmMonthlyRequestCap: define(z.number().int().min(0).max(1_000_000), () => 3_000),

  /**
   * Reveals the engineering surface — model override, thresholds, spend caps,
   * the diagnostics log. Off by default and unlocked by tapping the version
   * row, because every one of those knobs can make the app worse and none of
   * them belongs in front of someone who just wants to talk to their phone.
   */
  developerMode: define(z.boolean(), () => false),
  /**
   * The development billing provider's whole state, as JSON, on builds with no
   * real store compiled in. Null everywhere else — the App Store and Play own
   * this fact and the app only ever reads it back from them.
   */
  sandboxSubscription: define<string | null>(z.string().min(1).nullable(), () => null),
};

export type SettingsValues = {
  [K in keyof typeof SETTINGS]: (typeof SETTINGS)[K] extends SettingDefinition<infer T> ? T : never;
};

export type SettingKey = keyof SettingsValues;

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS, key);
}

export function defaultSettings(): SettingsValues {
  const out = {} as SettingsValues;
  for (const key of SETTING_KEYS) {
    (out as Record<string, unknown>)[key] = SETTINGS[key].fallback();
  }
  return out;
}

export type SettingsRepositoryOptions = {
  /** Injected rather than imported: repositories stay loadable under plain Node. */
  logger?: Pick<Logger, 'warn'>;
};

export function createSettingsRepository(
  db: RidikDatabase,
  options: SettingsRepositoryOptions = {},
) {
  const logger = options.logger;

  function decode<K extends SettingKey>(key: K, raw: string | undefined): SettingsValues[K] {
    const definition = SETTINGS[key] as SettingDefinition<SettingsValues[K]>;
    if (raw === undefined) return definition.fallback();

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger?.warn(`Setting "${key}" holds unparseable JSON; using the default.`, { raw });
      return definition.fallback();
    }

    const result = definition.schema.safeParse(parsed);
    if (!result.success) {
      logger?.warn(`Setting "${key}" failed validation; using the default.`, {
        issues: result.error.issues,
      });
      return definition.fallback();
    }
    return result.data;
  }

  function encode<K extends SettingKey>(key: K, value: SettingsValues[K]): string {
    const definition = SETTINGS[key] as SettingDefinition<SettingsValues[K]>;
    const result = definition.schema.safeParse(value);
    if (!result.success) {
      throw new AppError('invalid_input', `That is not a valid value for "${key}".`, {
        details: result.error.issues,
      });
    }
    return JSON.stringify(result.data ?? null);
  }

  async function getAll(): Promise<SettingsValues> {
    const rows = await db.select().from(appSettings);
    const stored = new Map(rows.map((row) => [row.key, row.value]));
    const out = {} as SettingsValues;
    for (const key of SETTING_KEYS) {
      (out as Record<string, unknown>)[key] = decode(key, stored.get(key));
    }
    return out;
  }

  async function writeMany(entries: Array<{ key: SettingKey; value: string }>): Promise<void> {
    const at = now();
    for (const entry of entries) {
      await db
        .insert(appSettings)
        .values({ key: entry.key, value: entry.value, updatedAt: at })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value: entry.value, updatedAt: at },
        });
    }
  }

  return {
    getAll,

    async get<K extends SettingKey>(key: K): Promise<SettingsValues[K]> {
      const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key));
      return decode(key, row?.value);
    },

    async set<K extends SettingKey>(key: K, value: SettingsValues[K]): Promise<SettingsValues[K]> {
      const encoded = encode(key, value);
      await serialised(db, () => writeMany([{ key, value: encoded }]));
      return decode(key, encoded);
    },

    async setMany(patch: Partial<SettingsValues>): Promise<SettingsValues> {
      const entries = (Object.keys(patch) as SettingKey[])
        .filter((key) => isSettingKey(key) && patch[key] !== undefined)
        .map((key) => ({
          key,
          value: encode(key, patch[key] as SettingsValues[typeof key]),
        }));

      await transactional(db, () => writeMany(entries));
      return getAll();
    },

    async reset<K extends SettingKey>(key: K): Promise<SettingsValues[K]> {
      await serialised(db, async () => {
        await db.delete(appSettings).where(eq(appSettings.key, key));
      });
      return SETTINGS[key].fallback() as SettingsValues[K];
    },

    /** Only clears keys we own, so an unrelated row survives a settings reset. */
    async resetAll(): Promise<SettingsValues> {
      await serialised(db, async () => {
        await db.delete(appSettings).where(inArray(appSettings.key, SETTING_KEYS));
      });
      return defaultSettings();
    },

    /** Escape hatch for diagnostics: the raw JSON exactly as stored. */
    async getRaw(key: SettingKey): Promise<string | null> {
      const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key));
      return row?.value ?? null;
    },
  };
}

export type SettingsRepository = ReturnType<typeof createSettingsRepository>;
