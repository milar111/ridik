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
import { DEFAULT_CONFIRM_MODE } from '@/llm/confirm';
import type { ConfirmMode } from '@/llm/confirm';

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
  /**
   * How much the assistant shows you before it writes.
   *
   * Speaking is fast because you do not have to look, which is exactly what
   * makes a mis-heard word dangerous: "James" and "Jason" are one phoneme
   * apart and the wrong one lands silently. The receipt catches that
   * afterwards for anything undoable; `src/llm/confirm.ts` covers what the
   * receipt cannot, and this is the dial on it.
   *
   * `irreversible` by default — a question in front of every write would sit
   * in front of the fastest thing about the app, and a prompt shown every time
   * is a prompt nobody reads. A closed set for the same reason `ember` is one:
   * a hand-edited row decodes to the default instead of to a policy nothing
   * can resolve.
   */
  confirmMode: define<ConfirmMode>(
    z.enum(['never', 'irreversible', 'always']),
    () => DEFAULT_CONFIRM_MODE,
  ),
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
   * How many of the free trial's requests this install has already spent, for
   * the whole life of the install.
   *
   * A counter, not a budget: the budget is `TRIAL_TOTAL_REQUESTS` in
   * `src/services/billing/allowance.ts`, a compile-time constant, because a
   * number that decides whether the operator pays for a stranger's traffic must
   * not be editable by the stranger. This only ever goes up, and nothing resets
   * it on a date — waiting out a month is precisely what it must not allow.
   * Untouched on a build with no store in it, where there is no trial.
   */
  llmTrialRequestsUsed: define(z.number().int().min(0).max(1_000_000), () => 0),
  /**
   * The same counter in the unit the provider actually bills in.
   *
   * A request is a poor proxy for spend — one turn dragging a huge pasted
   * context, or repaired twice so it billed three times, costs many times an
   * ordinary one and still moves the counter above by exactly one. This is the
   * ceiling that catches that, and it has to be a lifetime figure for the same
   * reason: `llm_usage` measures a day and a calendar month, both of which are
   * windows on a clock the user can set, and neither of which knows whether the
   * traffic in it was paid for.
   */
  llmTrialTokensUsed: define(z.number().int().min(0).max(1_000_000_000), () => 0),
  /**
   * Pretend a store is compiled in, so the free-tier lock can be walked through
   * on a simulator that has no RevenueCat keys. Developer screen only, and the
   * worst it can do is lock the assistant on a personal build — which the same
   * screen can undo, and which never touches the offline path.
   */
  simulateStoreBuild: define(z.boolean(), () => false),

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

    /**
     * Adds to a numeric setting, atomically against every other write on this
     * connection.
     *
     * `get` then `set` is a lost update, and the one counter written this way
     * is the free trial's. Nothing serialises a caller's read against its own
     * later write — `set` only serialises the write — so ten taps on Send in
     * one second ran ten turns that each read the same number and each wrote
     * that number plus one. Ten billable calls, one request spent, and the same
     * race let a spent trial be walked straight past. Doing the read *inside*
     * the queued job is what makes the pair whole.
     *
     * Clamped to the key's own schema rather than allowed to throw: this runs
     * after the model has already answered, and losing the count is better than
     * losing the turn.
     */
    async bump<K extends SettingKey>(
      key: SettingsValues[K] extends number ? K : never,
      by: number,
    ): Promise<number> {
      return serialised(db, async () => {
        const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key));
        const current = decode(key, row?.value) as number;
        const next = Math.max(0, Math.trunc(current) + Math.max(0, Math.trunc(by)));
        const definition = SETTINGS[key] as SettingDefinition<number>;
        // A counter that has run past its own ceiling stays at the ceiling; it
        // is a gate, and everything above the top of it means the same thing.
        const safe = definition.schema.safeParse(next);
        const value = safe.success ? next : current;
        await writeMany([{ key, value: JSON.stringify(value) }]);
        return value;
      });
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
