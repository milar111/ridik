import { createTestDatabase, type TestDatabase } from '@/db/testing';
import { freezeClock } from '@/core/clock';
import { localToEpoch, setZoneOverride } from '@/core/time';
import {
  createUsageMeter,
  estimateCostMicros,
  formatCostMicros,
  type UsageMeter,
} from '@/llm/usage';

const ZONE = 'Europe/Sofia';
const CAPS = { daily: 3, monthly: 5 };

describe('assistant spend meter', () => {
  let t: TestDatabase;
  let meter: UsageMeter;
  let restore: () => void;

  const at = (iso: string) => {
    restore?.();
    restore = freezeClock(localToEpoch(iso, ZONE));
  };

  beforeEach(() => {
    setZoneOverride(ZONE);
    restore = freezeClock(localToEpoch('2026-08-11T09:00', ZONE));
    t = createTestDatabase();
    meter = createUsageMeter(t.db);
  });

  afterEach(() => {
    restore();
    setZoneOverride(null);
    t.close();
  });

  const spend = (n: number) =>
    Promise.all(
      Array.from({ length: n }, () =>
        meter.record({ model: 'gemini-flash-latest', inputTokens: 2_500, outputTokens: 300 }),
      ),
    );

  it('lets requests through until the daily cap, then refuses', async () => {
    for (let i = 0; i < CAPS.daily; i++) {
      const verdict = await meter.check(CAPS);
      expect(verdict.ok).toBe(true);
      await spend(1);
    }
    const blocked = await meter.check(CAPS);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error.code).toBe('rate_limited');
      expect(blocked.error.userMessage).toContain('today');
    }
  });

  it('resets at the local midnight boundary, not 24 hours later', async () => {
    at('2026-08-11T23:30');
    await spend(CAPS.daily);
    expect((await meter.check(CAPS)).ok).toBe(false);

    at('2026-08-12T00:05');
    // 35 minutes later, but a new local day.
    expect((await meter.check(CAPS)).ok).toBe(true);
  });

  it('still refuses once the month is spent, even on a fresh day', async () => {
    at('2026-08-11T10:00');
    await spend(3);
    at('2026-08-12T10:00');
    await spend(2);
    // Day is clean, month is not.
    const snapshot = await meter.snapshot(CAPS);
    expect(snapshot.today.requests).toBe(2);
    expect(snapshot.month.requests).toBe(5);

    const blocked = await meter.check(CAPS);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.userMessage).toContain('month');
  });

  it('does not carry last month into this one', async () => {
    at('2026-07-31T22:00');
    await spend(5);
    at('2026-08-01T09:00');
    const snapshot = await meter.snapshot(CAPS);
    expect(snapshot.month.requests).toBe(0);
    expect((await meter.check(CAPS)).ok).toBe(true);
  });

  it('treats a cap of zero as unlimited', async () => {
    await spend(50);
    expect((await meter.check({ daily: 0, monthly: 0 })).ok).toBe(true);
  });

  it('accumulates tokens and cost onto one row per day', async () => {
    await spend(4);
    const snapshot = await meter.snapshot(CAPS);
    expect(snapshot.today.requests).toBe(4);
    expect(snapshot.today.inputTokens).toBe(10_000);
    expect(snapshot.today.outputTokens).toBe(1_200);
    // 4 × (2500 in + 300 out) at $0.25/$1.50 per million.
    expect(snapshot.today.costMicros).toBe(4 * estimateCostMicros('gemini-flash-latest', 2_500, 300));
  });

  it('reports no cost for a model it does not have a price for', () => {
    expect(estimateCostMicros('some-future-model', 10_000, 10_000)).toBe(0);
  });

  it('prices a realistic utterance at a fraction of a cent', () => {
    // The whole point of the default model choice: this must be negligible.
    const micros = estimateCostMicros('gemini-flash-latest', 2_500, 300);
    expect(micros).toBeGreaterThan(0);
    expect(micros).toBeLessThan(2_000); // under $0.002
    expect(formatCostMicros(micros)).toMatch(/^\$0\.00/);
  });

  it('survives a request the provider reported no token counts for', async () => {
    await meter.record({ model: 'gemini-flash-latest' });
    const snapshot = await meter.snapshot(CAPS);
    // The request still counts against the cap; only the cost is unknown.
    expect(snapshot.today.requests).toBe(1);
    expect(snapshot.today.costMicros).toBe(0);
  });
});
