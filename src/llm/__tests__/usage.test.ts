import { createTestDatabase, type TestDatabase } from '@/db/testing';
import { freezeClock } from '@/core/clock';
import { localToEpoch, setZoneOverride } from '@/core/time';
import {
  UNLIMITED,
  createUsageMeter,
  developerCap,
  estimateCostMicros,
  formatCostMicros,
  limitOf,
  tighter,
  TYPICAL_TURN,
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

  it('treats a bare cap of zero as unlimited, the developer-settings convention', async () => {
    await spend(50);
    expect((await meter.check({ daily: 0, monthly: 0 })).ok).toBe(true);
    expect((await meter.check({ daily: developerCap(0), monthly: developerCap(0) })).ok).toBe(true);
  });

  /* `requests` is utterances, and a caller backfilling several says so
     explicitly. What must never quietly add to it is the repair ladder — see
     'turns against billable calls' below. */
  it('takes a caller’s word for how many utterances a row covers', async () => {
    await meter.record({
      model: 'gemini-flash-latest',
      inputTokens: 21_000,
      outputTokens: 900,
      requests: 3,
    });
    const snapshot = await meter.snapshot(CAPS);
    expect(snapshot.today.requests).toBe(3);
    expect(snapshot.remainingToday).toBe(0);
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

  /**
   * Everything below is the evidence a caching change would be judged on. A
   * cache hit changes neither the request count nor the input count, so if the
   * cached slice is not stored and not priced, "did caching work?" has no
   * answer and the receipt quietly bills free tokens at full price.
   */
  it('accumulates the cached slice of the input separately', async () => {
    await meter.record({
      model: 'gemini-flash-latest',
      inputTokens: 7_300,
      cachedTokens: 6_900,
      outputTokens: 90,
    });
    const snapshot = await meter.snapshot(CAPS);
    expect(snapshot.today.inputTokens).toBe(7_300);
    expect(snapshot.today.cachedTokens).toBe(6_900);
  });

  it('prices a cached token at a tenth of a fresh one', () => {
    const cold = estimateCostMicros('gemini-flash-latest', 7_300, 90);
    const warm = estimateCostMicros('gemini-flash-latest', 7_300, 90, 6_900);
    expect(warm).toBeLessThan(cold);
    // 400 fresh + 6,900 cached at 10% costs the same as 1,090 fresh tokens,
    // give or take the rounding to whole micro-units.
    const equivalent = estimateCostMicros('gemini-flash-latest', 1_090, 90);
    expect(Math.abs(warm - equivalent)).toBeLessThanOrEqual(1);
  });

  it('never lets a cached count exceed the input it is part of', async () => {
    // A provider that says 9,000 of 1,000 input tokens were cached is talking
    // nonsense; it must not produce a negative bill.
    await meter.record({
      model: 'gemini-flash-latest',
      inputTokens: 1_000,
      cachedTokens: 9_000,
      outputTokens: 10,
    });
    const snapshot = await meter.snapshot(CAPS);
    expect(snapshot.today.cachedTokens).toBe(1_000);
    expect(snapshot.today.costMicros).toBeGreaterThan(0);
  });

  it('bills a provider that reports no cached tokens exactly as before', () => {
    expect(estimateCostMicros('gemini-flash-latest', 2_500, 300)).toBe(
      estimateCostMicros('gemini-flash-latest', 2_500, 300, 0),
    );
  });

  /**
   * A cached token is cheaper, not free. The two units answer different
   * questions and a token ceiling must not quietly stop counting when a cache
   * warms up — otherwise a protective allowance grows itself.
   */
  it('counts a cached token against a token ceiling like any other', async () => {
    await meter.record({
      model: 'gemini-flash-latest',
      inputTokens: 9_000,
      cachedTokens: 8_500,
      outputTokens: 100,
    });
    const snapshot = await meter.snapshot(CAPS);
    expect(snapshot.today.inputTokens + snapshot.today.outputTokens).toBe(9_100);
    expect((await meter.check({ daily: { tokens: limitOf(9_500) }, monthly: 0 })).ok).toBe(false);
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

  /* ------------------------------------------------------------- caps ---- */

  describe('ceilings', () => {
    it('is unlimited only when it says so, never because a number is zero', () => {
      expect(developerCap(0)).toEqual(UNLIMITED);
      expect(developerCap(200)).toEqual({ kind: 'limit', value: 200 });
      expect(limitOf(0)).toEqual({ kind: 'limit', value: 0 });
      expect(tighter(UNLIMITED, limitOf(5))).toEqual({ kind: 'limit', value: 5 });
      expect(tighter(limitOf(3), limitOf(9))).toEqual({ kind: 'limit', value: 3 });
      expect(tighter(UNLIMITED, UNLIMITED)).toEqual(UNLIMITED);
    });

    it('refuses everything on an explicit ceiling of zero', async () => {
      // The whole reason `Cap` exists: 0 from an allowance must not read as
      // "uncapped" the way 0 in the developer slider does.
      const blocked = await meter.check({ daily: 0, monthly: { requests: limitOf(0) } });
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.error.code).toBe('rate_limited');
        expect(blocked.error.userMessage).toContain('pattern matching');
      }
    });
  });

  describe('token and cost ceilings', () => {
    // Each recorded turn in `spend` is 2,800 tokens and 1,075 micros.
    it('refuses the turn that would cross the monthly token ceiling', async () => {
      await spend(3); // 8,400 tokens used, and one more turn is projected at 2,800.
      const tight = await meter.check({ daily: 0, monthly: { tokens: limitOf(10_000) } });
      expect(tight.ok).toBe(false);
      if (!tight.ok) expect(tight.error.userMessage).toContain("this month's assistant allowance");

      const roomy = await meter.check({ daily: 0, monthly: { tokens: limitOf(12_000) } });
      expect(roomy.ok).toBe(true);
    });

    it('stops one huge call that a request cap would have waved through', async () => {
      // 50k tokens in a single turn: 1 request out of 200, and half a plan's
      // worth of tokens. This is the case the whole unit exists for.
      await meter.record({
        model: 'gemini-flash-latest',
        inputTokens: 50_000,
        outputTokens: 1_000,
      });
      expect((await meter.check({ daily: 200, monthly: 3_000 })).ok).toBe(true);

      const blocked = await meter.check({
        daily: 0,
        monthly: { requests: limitOf(200), tokens: limitOf(100_000) },
      });
      expect(blocked.ok).toBe(false);
    });

    it('refuses on money when the ceiling is money', async () => {
      await spend(5); // 5,375 micros.
      const blocked = await meter.check({ daily: 0, monthly: { costMicros: limitOf(6_000) } });
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.error.userMessage).toContain('budget');
      const roomy = await meter.check({ daily: 0, monthly: { costMicros: limitOf(9_000) } });
      expect(roomy.ok).toBe(true);
    });

    it('says midnight for a daily ceiling and not for a monthly one', async () => {
      await spend(3);
      const daily = await meter.check({ daily: { tokens: limitOf(9_000) }, monthly: 0 });
      expect(daily.ok).toBe(false);
      if (!daily.ok) expect(daily.error.userMessage).toContain('midnight');

      const monthly = await meter.check({ daily: 0, monthly: { tokens: limitOf(9_000) } });
      expect(monthly.ok).toBe(false);
      if (!monthly.ok) expect(monthly.error.userMessage).not.toContain('midnight');
    });

    it('estimates the first turn from the measured typical one', async () => {
      const typical = TYPICAL_TURN.inputTokens + TYPICAL_TURN.outputTokens;
      const snapshot = await meter.snapshot(CAPS);
      expect(snapshot.estimate.tokens).toBe(typical);

      // Nothing spent at all, but one turn does not fit.
      expect((await meter.check({ daily: 0, monthly: { tokens: limitOf(typical - 1) } })).ok).toBe(
        false,
      );
      const fits = await meter.check({ daily: 0, monthly: { tokens: limitOf(typical) } });
      expect(fits.ok).toBe(true);
    });

    it('learns the size of this user’s turns instead of trusting the constant', async () => {
      await spend(4); // 2,800 tokens each — far cheaper than the constant.
      const snapshot = await meter.snapshot(CAPS);
      expect(snapshot.estimate.tokens).toBe(2_800);
      expect(snapshot.estimate.costMicros).toBe(1_075);
    });

    it('lets the caller say this turn will be bigger than the average', async () => {
      const caps = { daily: 0, monthly: { tokens: limitOf(50_000) } };
      expect((await meter.check(caps)).ok).toBe(true);
      const huge = await meter.check(caps, { estimate: { tokens: 60_000 } });
      expect(huge.ok).toBe(false);
      if (!huge.ok) {
        const details = huge.error.details as { breach: { unit: string; projected: number } };
        expect(details.breach.unit).toBe('tokens');
        expect(details.breach.projected).toBe(60_000);
      }
    });

    it('still stops dead on a spent ceiling when the model has no price', async () => {
      await meter.record({ model: 'some-future-model', inputTokens: 5_000, outputTokens: 100 });
      // Cost estimate is 0 for an unpriced model, so the projection cannot grow
      // — the used total alone has to be enough to refuse.
      const blocked = await meter.check({ daily: 0, monthly: { costMicros: limitOf(0) } });
      expect(blocked.ok).toBe(false);
    });

    it('reports every ceiling it resolved, in every unit', async () => {
      const snapshot = await meter.snapshot({ daily: 0, monthly: { tokens: limitOf(500) } });
      expect(snapshot.limits.daily.requests).toEqual(UNLIMITED);
      expect(snapshot.limits.monthly.tokens).toEqual({ kind: 'limit', value: 500 });
      expect(snapshot.monthlyCap).toBe(0); // no request ceiling, as the UI reads it
    });
  });
  /**
   * Every ceiling in this file is keyed on a local date that comes from the
   * device clock, and Settings -> Date & time is not a privileged surface.
   * Rolling forward is indistinguishable from time passing and is left alone;
   * rolling *back* used to land the reader on an empty window, which reads as a
   * full allowance and made every monthly cap in the app a suggestion.
   */
  describe('a clock the user can set', () => {
    it('does not hand out a fresh day for a clock rolled backwards', async () => {
      await spend(CAPS.daily);
      expect((await meter.check(CAPS)).ok).toBe(false);

      at('2026-07-04T09:00');

      expect((await meter.check(CAPS)).ok).toBe(false);
    });

    it('does not hand out a fresh month either', async () => {
      const caps = { daily: 0, monthly: 2 };
      await spend(2);
      expect((await meter.check(caps)).ok).toBe(false);

      at('2026-06-01T09:00');

      expect((await meter.check(caps)).ok).toBe(false);
    });

    /* And a turn taken while the clock is wound back still counts, rather than
       being filed on a date nothing will ever read. */
    it('files a rolled-back turn where the meter will still see it', async () => {
      await spend(1);
      at('2025-01-01T09:00');
      await spend(1);
      at('2026-08-11T09:00');

      const snapshot = await meter.snapshot(CAPS);
      expect(snapshot.today.requests).toBe(2);
    });

    /* Going forward is honest time as far as anything here can tell, and the
       high-water mark it leaves is what makes coming back pointless. */
    it('still opens a new window when the clock moves forward', async () => {
      await spend(CAPS.daily);
      at('2026-08-12T09:00');
      expect((await meter.check(CAPS)).ok).toBe(true);
    });
  });

  /**
   * One utterance can cost the provider more than one call — a transport retry,
   * or a reply the schema rejected and the model was asked to repair. Adding
   * those to `requests` billed the user for the app's own retries: a Light
   * subscriber sold "300 requests a month" was cut off after ~150 things they
   * actually said, and the turns that cost them most were the ones that worked
   * worst.
   */
  describe('turns against billable calls', () => {
    it('counts one utterance as one request however often it was repaired', async () => {
      await meter.record({
        model: 'gemini-flash-latest',
        inputTokens: 21_000,
        outputTokens: 400,
        requests: 1,
        calls: 3,
      });

      const snapshot = await meter.snapshot(CAPS);
      expect(snapshot.today.requests).toBe(1);
      expect(snapshot.today.calls).toBe(3);
    });

    it('still prices the repairs, because the tokens were real', async () => {
      await meter.record({
        model: 'gemini-flash-latest',
        inputTokens: 21_000,
        outputTokens: 400,
        calls: 3,
      });
      const snapshot = await meter.snapshot(CAPS);
      expect(snapshot.today.costMicros).toBe(
        estimateCostMicros('gemini-flash-latest', 21_000, 400),
      );
    });

    it('never reports fewer calls than requests', async () => {
      await meter.record({ model: 'gemini-flash-latest', requests: 2, calls: 1 });
      const snapshot = await meter.snapshot(CAPS);
      expect(snapshot.today.calls).toBe(2);
    });
  });

  /* The pre-flight estimate is a floor over the rolling average, not a
     replacement for it: a caller that can see the transcript knows this turn is
     huge, but a user whose turns really do cost more must keep the higher
     number. */
  describe('projecting the next turn', () => {
    it('takes the caller’s estimate when it is larger than the history', async () => {
      const caps = { daily: 0, monthly: { tokens: limitOf(50_000) } };
      const huge = await meter.check(caps, { estimate: { tokens: 60_000 } });
      expect(huge.ok).toBe(false);
    });

    it('keeps the history when the caller under-estimates', async () => {
      // Three enormous turns, then a caller claiming the next one is tiny.
      for (let i = 0; i < 3; i++) {
        await meter.record({ model: 'gemini-flash-latest', inputTokens: 40_000, outputTokens: 500 });
      }
      const caps = { daily: 0, monthly: { tokens: limitOf(130_000) } };
      const blocked = await meter.check(caps, { estimate: { tokens: 1 } });
      expect(blocked.ok).toBe(false);
    });
  });
});
