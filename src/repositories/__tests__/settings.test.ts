import { freezeClock } from '@/core/clock';
import { setZoneOverride } from '@/core/time';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import {
  DEFAULT_LLM_MODEL,
  SETTING_KEYS,
  createSettingsRepository,
  defaultSettings,
  isSettingKey,
  type SettingsRepository,
} from '@/repositories/settings';
import { createSyncQueueRepository } from '@/repositories/syncQueue';

const NOW = 1_780_000_000_000;
const ZONE = 'Europe/Sofia';

describe('settings repository', () => {
  let t: TestDatabase;
  let repo: SettingsRepository;
  let restoreClock: () => void;
  let warn: jest.Mock;

  beforeEach(() => {
    setZoneOverride(ZONE);
    restoreClock = freezeClock(NOW);
    t = createTestDatabase();
    warn = jest.fn();
    repo = createSettingsRepository(t.db, { logger: { warn } });
  });

  afterEach(() => {
    restoreClock();
    setZoneOverride(null);
    t.close();
  });

  const writeRaw = (key: string, value: string) =>
    t.client.runSync('INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?,?,?)', [
      key,
      value,
      NOW,
    ]);

  describe('defaults', () => {
    it('returns the documented default for every key on a fresh database', async () => {
      const all = await repo.getAll();
      expect(all).toEqual({
        timezone: ZONE,
        llmModel: DEFAULT_LLM_MODEL,
        llmApiKeyPresent: false,
        llmDailyRequestCap: 200,
        llmMonthlyRequestCap: 3_000,
        llmTrialRequestsUsed: 0,
        llmTrialTokensUsed: 0,
        simulateStoreBuild: false,
        developerMode: false,
        sandboxSubscription: null,
        voiceConfidenceThreshold: 0.7,
        silenceTimeoutMs: 1500,
        defaultBufferMinutes: 20,
        lastBriefingShown: null,
        ttsEnabled: false,
        ttsRate: 1,
        primaryCurrency: 'EUR',
        googleCalendarId: null,
        googleAccountEmail: null,
        onboardingComplete: false,
        // Silence is not a decision. `false` would be, and the pipeline would
        // then have to tell "declined" from "never asked" by looking at
        // `onboardingComplete`, which is exactly the collapse this avoids.
        assistantConsent: 'unset',
        assistantConsentAt: null,
        weekStartsOn: 1,
        whisperFallbackEnabled: true,
        ember: 'ember',
        confirmMode: 'irreversible',
        llmSchemaRung: 1,
      });
    });

    it('takes the timezone default from the device zone', async () => {
      setZoneOverride('America/New_York');
      expect(await repo.get('timezone')).toBe('America/New_York');
    });

    it('exposes the key list and a defaults snapshot', () => {
      expect(SETTING_KEYS).toContain('whisperFallbackEnabled');
      expect(isSettingKey('silenceTimeoutMs')).toBe(true);
      expect(isSettingKey('nonsense')).toBe(false);
      expect(defaultSettings().primaryCurrency).toBe('EUR');
    });
  });

  describe('set / get', () => {
    it('round-trips each value type', async () => {
      await repo.set('silenceTimeoutMs', 600);
      await repo.set('ttsEnabled', false);
      await repo.set('voiceConfidenceThreshold', 0.42);
      await repo.set('googleCalendarId', 'primary');
      await repo.set('weekStartsOn', 0);

      expect(await repo.get('silenceTimeoutMs')).toBe(600);
      expect(await repo.get('ttsEnabled')).toBe(false);
      expect(await repo.get('voiceConfidenceThreshold')).toBe(0.42);
      expect(await repo.get('googleCalendarId')).toBe('primary');
      expect(await repo.get('weekStartsOn')).toBe(0);
    });

    /* The colour the app is drawn in. It has to come back after a restart —
       which for a repository means: written to the row, read by a repository
       built fresh over the same database, exactly as the app does on launch. */
    it('keeps a chosen ember across a restart', async () => {
      await repo.set('ember', 'rust');

      const afterRestart = createSettingsRepository(t.db, { logger: { warn } });
      expect(await afterRestart.get('ember')).toBe('rust');
      expect((await afterRestart.getAll()).ember).toBe('rust');
    });

    /* A colour nothing can resolve would leave every screen with no palette.
       A closed set is what makes "set this to the worst value you can" safe. */
    it('refuses an ember that does not exist, and forgets one that stops existing', async () => {
      await expect(repo.set('ember', 'teal' as never)).rejects.toThrow(/not a valid value/i);

      writeRaw('ember', JSON.stringify('teal'));
      expect(await repo.get('ember')).toBe('ember');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ember'), expect.anything());
    });

    /* The free trial's counter is the only setting whose worst value costs the
       operator money: a negative one would read as credit and hand out a fresh
       trial to anyone who could write the row. It is refused on the way in and
       ignored on the way out. */
    it('will not accept a trial counter that reads as credit', async () => {
      await expect(repo.set('llmTrialRequestsUsed', -10)).rejects.toThrow(/not a valid value/i);

      writeRaw('llmTrialRequestsUsed', JSON.stringify(-10));
      expect(await repo.get('llmTrialRequestsUsed')).toBe(0);

      await repo.set('llmTrialRequestsUsed', 26);
      expect(await repo.get('llmTrialRequestsUsed')).toBe(26);
    });

    it('stores null distinctly from absent', async () => {
      await repo.set('googleAccountEmail', 'me@example.com');
      expect(await repo.get('googleAccountEmail')).toBe('me@example.com');

      await repo.set('googleAccountEmail', null);
      expect(await repo.getRaw('googleAccountEmail')).toBe('null');
      expect(await repo.get('googleAccountEmail')).toBeNull();
    });

    it('overwrites rather than duplicating a key', async () => {
      await repo.set('llmModel', 'model-a');
      await repo.set('llmModel', 'model-b');
      const rows = t.client.getAllSync<{ n: number }>(
        'SELECT COUNT(*) AS n FROM app_settings WHERE key = ?',
        ['llmModel'],
      );
      expect(rows[0]!.n).toBe(1);
      expect(await repo.get('llmModel')).toBe('model-b');
    });

    it('rejects a value that fails its validator', async () => {
      await expect(repo.set('silenceTimeoutMs', 99)).rejects.toThrow(/not a valid value/i);
      await expect(repo.set('voiceConfidenceThreshold', 1.5)).rejects.toThrow(/not a valid value/i);
      await expect(repo.set('primaryCurrency', 'euro')).rejects.toThrow(/not a valid value/i);
      expect(await repo.get('silenceTimeoutMs')).toBe(1500);
    });

    it('writes several keys atomically', async () => {
      const after = await repo.setMany({
        onboardingComplete: true,
        primaryCurrency: 'BGN',
        silenceTimeoutMs: 800,
      });
      expect(after.onboardingComplete).toBe(true);
      expect(after.primaryCurrency).toBe('BGN');
      expect(after.silenceTimeoutMs).toBe(800);
      expect(after.ttsRate).toBe(1);
    });

    it('does not collide with another repository writing at the same time', async () => {
      // Different repositories, one SQLite connection: two transactions opened
      // at once means a second BEGIN inside the first, which throws.
      const queue = createSyncQueueRepository(t.db);
      await queue.enqueue({
        operation: 'calendar.update',
        entityTable: 'calendar_events',
        entityId: 'evt-1',
        payload: { title: 'Dentist' },
      });

      const [after, claimed] = await Promise.all([
        repo.setMany({ silenceTimeoutMs: 900, onboardingComplete: true }),
        queue.claimReady(NOW, 10),
      ]);

      expect(after!.silenceTimeoutMs).toBe(900);
      expect(claimed).toHaveLength(1);
      expect(await repo.get('onboardingComplete')).toBe(true);
    });

    it('leaves everything untouched when one value in a batch is invalid', async () => {
      await expect(
        repo.setMany({ onboardingComplete: true, silenceTimeoutMs: 99 }),
      ).rejects.toThrow(/not a valid value/i);
      expect(await repo.get('onboardingComplete')).toBe(false);
    });
  });

  describe('corrupt storage', () => {
    it('falls back and logs when the stored JSON does not parse', async () => {
      writeRaw('silenceTimeoutMs', '{not json');

      expect(await repo.get('silenceTimeoutMs')).toBe(1500);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatch(/unparseable JSON/i);
    });

    it('falls back and logs when the stored value fails validation', async () => {
      writeRaw('silenceTimeoutMs', '"seven"');
      writeRaw('weekStartsOn', '5');

      expect(await repo.get('silenceTimeoutMs')).toBe(1500);
      expect(await repo.get('weekStartsOn')).toBe(1);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0]![0]).toMatch(/failed validation/i);
    });

    it('keeps getAll total when one row is corrupt', async () => {
      writeRaw('ttsRate', 'NaN');
      await repo.set('silenceTimeoutMs', 900);

      const all = await repo.getAll();
      expect(all.ttsRate).toBe(1);
      expect(all.silenceTimeoutMs).toBe(900);
      expect(warn).toHaveBeenCalled();
    });

    it('ignores rows for keys the app no longer knows about', async () => {
      writeRaw('legacyThing', '"whatever"');
      const all = await repo.getAll();
      expect(Object.keys(all)).toEqual(SETTING_KEYS);
      expect(warn).not.toHaveBeenCalled();
    });

    it('never throws without a logger attached', async () => {
      const quiet = createSettingsRepository(t.db);
      writeRaw('silenceTimeoutMs', 'not-json');
      expect(await quiet.get('silenceTimeoutMs')).toBe(1500);
    });
  });

  /**
   * The free trial's counter is a lifetime budget on somebody else's invoice,
   * and it used to be moved with a `get` followed by a `set`.
   *
   * Nothing serialises that pair — `set` only serialises its own write — so
   * concurrent turns each read the same number and each wrote it back plus one.
   * Ten taps on Send in a second bought ten billable calls for one request off
   * the counter, and the same race walked straight past a counter that was
   * already spent.
   */
  describe('bump', () => {
    it('loses nothing when every increment races', async () => {
      await Promise.all(Array.from({ length: 20 }, () => repo.bump('llmTrialRequestsUsed', 1)));

      expect(await repo.get('llmTrialRequestsUsed')).toBe(20);
    });

    it('races safely against an unrelated write on the same connection', async () => {
      await Promise.all([
        repo.bump('llmTrialTokensUsed', 7_500),
        repo.set('ttsEnabled', true),
        repo.bump('llmTrialTokensUsed', 7_500),
        repo.set('llmModel', 'gemini-3-flash'),
      ]);

      expect(await repo.get('llmTrialTokensUsed')).toBe(15_000);
      expect(await repo.get('ttsEnabled')).toBe(true);
      expect(await repo.get('llmModel')).toBe('gemini-3-flash');
    });

    it('starts from the stored value rather than from the default', async () => {
      await repo.set('llmTrialRequestsUsed', 24);
      expect(await repo.bump('llmTrialRequestsUsed', 1)).toBe(25);
    });

    /* It runs after the model has already answered, so it may not throw: losing
       the count is bad, losing the user's turn on top of it is worse. */
    it('never goes backwards or below zero', async () => {
      await repo.set('llmTrialRequestsUsed', 5);
      expect(await repo.bump('llmTrialRequestsUsed', -100)).toBe(5);
    });

    it('stops at the key’s own ceiling instead of failing validation', async () => {
      await repo.set('llmTrialRequestsUsed', 1_000_000);
      expect(await repo.bump('llmTrialRequestsUsed', 1)).toBe(1_000_000);
    });
  });

  describe('reset', () => {
    it('drops a single key back to its default', async () => {
      await repo.set('silenceTimeoutMs', 500);
      expect(await repo.reset('silenceTimeoutMs')).toBe(1500);
      expect(await repo.get('silenceTimeoutMs')).toBe(1500);
      expect(await repo.getRaw('silenceTimeoutMs')).toBeNull();
    });

    it('drops every known key but leaves foreign rows alone', async () => {
      await repo.set('silenceTimeoutMs', 500);
      await repo.set('onboardingComplete', true);
      writeRaw('someOtherFeature', '"keep me"');

      const after = await repo.resetAll();
      expect(after.silenceTimeoutMs).toBe(1500);
      expect(after.onboardingComplete).toBe(false);
      expect(await repo.getAll()).toEqual(defaultSettings());

      const remaining = t.client.getAllSync<{ key: string }>('SELECT key FROM app_settings', []);
      expect(remaining.map((row) => row.key)).toEqual(['someOtherFeature']);
    });
  });
});
