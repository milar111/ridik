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
  briefingHour: define(z.number().int().min(0).max(23), () => 7),
  briefingEnabled: define(z.boolean(), () => true),
  ttsEnabled: define(z.boolean(), () => true),
  ttsRate: define(z.number().min(0.1).max(2), () => 1),
  primaryCurrency: define(z.string().regex(/^[A-Z]{3}$/), () => 'EUR'),
  googleCalendarId: define<string | null>(z.string().min(1).nullable(), () => null),
  googleAccountEmail: define<string | null>(z.string().min(1).nullable(), () => null),
  onboardingComplete: define(z.boolean(), () => false),
  weekStartsOn: define<0 | 1>(z.union([z.literal(0), z.literal(1)]), () => 1),
  whisperFallbackEnabled: define(z.boolean(), () => true),
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
