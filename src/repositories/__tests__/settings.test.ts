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
        developerMode: false,
        voiceConfidenceThreshold: 0.7,
        silenceTimeoutMs: 1500,
        defaultBufferMinutes: 20,
        lastBriefingShown: null,
        ttsEnabled: true,
        ttsRate: 1,
        primaryCurrency: 'EUR',
        googleCalendarId: null,
        googleAccountEmail: null,
        onboardingComplete: false,
        weekStartsOn: 1,
        whisperFallbackEnabled: true,
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
