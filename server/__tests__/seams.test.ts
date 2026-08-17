/**
 * The two seams: who the caller is, and what they have already spent.
 *
 * Both have edge cases that cost money in one direction and lock out paying
 * customers in the other, and every one of them is a single boolean somewhere.
 */
import { createRevenueCatVerifier } from '../revenuecat';
import { createMemoryQuota, createPostgresQuota, createRedisQuota, utcDay } from '../quota';

const SECRET = 'sk_secret_never_in_the_client';

function rcResponse(entitlements: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify({ subscriber: { entitlements } }), { status });
}

function verifier(fetchImpl: jest.Mock) {
  return createRevenueCatVerifier({
    secretKey: SECRET,
    entitlementId: 'pro',
    dailyLimits: { ridik_monthly: 25, pro_monthly: 100 },
    fallbackDailyLimit: 25,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

/* Long enough to pass the token guard, which exists because the token is
   interpolated into a URL path. A one-character id is not a real one. */
const USER = 'rc-user-0123456789';

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

describe('verifying a caller against RevenueCat', () => {
  it('reads the daily limit from the product they actually bought', async () => {
    const fetchImpl = jest.fn(async () =>
      rcResponse({ pro: { expires_date: FUTURE, product_identifier: 'pro_monthly' } }),
    );
    expect(await verifier(fetchImpl)('user-abc-123')).toEqual({
      userId: 'user-abc-123',
      subscriptionActive: true,
      dailyLimit: 100,
    });
  });

  /**
   * `expires_date: null` is a LIFETIME grant, not a missing one. Reading a null
   * as expired locks out whoever paid the most, which is the worst possible
   * group to break.
   */
  it('treats a null expiry as a lifetime entitlement', async () => {
    const fetchImpl = jest.fn(async () =>
      rcResponse({ pro: { expires_date: null, product_identifier: 'pro_yearly' } }),
    );
    expect((await verifier(fetchImpl)(USER))?.subscriptionActive).toBe(true);
  });

  it('treats a past expiry as lapsed', async () => {
    const fetchImpl = jest.fn(async () =>
      rcResponse({ pro: { expires_date: PAST, product_identifier: 'pro_monthly' } }),
    );
    const caller = await verifier(fetchImpl)(USER);
    expect(caller).toEqual({ userId: USER, subscriptionActive: false, dailyLimit: 0 });
  });

  it('treats an unrelated entitlement as no entitlement', async () => {
    const fetchImpl = jest.fn(async () =>
      rcResponse({ something_else: { expires_date: FUTURE } }),
    );
    expect((await verifier(fetchImpl)(USER))?.subscriptionActive).toBe(false);
  });

  /**
   * An active entitlement on a product nobody has priced yet still works, at the
   * conservative tier. A new product id shipping to a `?? 0` would refuse the
   * customers of whatever was just launched.
   */
  it('falls back to a conservative limit for an unknown product', async () => {
    const fetchImpl = jest.fn(async () =>
      rcResponse({ pro: { expires_date: FUTURE, product_identifier: 'ridik_quarterly_2027' } }),
    );
    expect((await verifier(fetchImpl)(USER))?.dailyLimit).toBe(25);
  });

  /**
   * An outage is not a licence. Refusing degrades the app to the offline matcher
   * with a notice — a path it already has — whereas trusting the client would
   * hand out free requests to anyone who could make RevenueCat time out.
   */
  it.each([500, 502, 401, 404])('refuses when RevenueCat answers %i', async (status) => {
    const fetchImpl = jest.fn(async () => rcResponse({}, status));
    expect(await verifier(fetchImpl)(USER)).toBeNull();
  });

  it('sends the secret key and never puts it in the url', async () => {
    const fetchImpl = jest.fn(async () =>
      rcResponse({ pro: { expires_date: FUTURE, product_identifier: 'pro_monthly' } }),
    );
    await verifier(fetchImpl)(USER);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain(SECRET);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`);
  });

  /**
   * The token is interpolated into a URL path, so a token containing path syntax
   * would address a different endpoint. Rejected before any request goes out.
   */
  it.each([
    ['a traversal', '../../keys/leak'],
    ['a newline', 'abc\ndef'],
    ['a slash', 'abc/def'],
    ['something far too short', 'abc'],
    ['nothing at all', ''],
  ])('refuses %s without calling out', async (_label, token) => {
    const fetchImpl = jest.fn(async () => rcResponse({}));
    expect(await verifier(fetchImpl)(token)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /* RevenueCat's own anonymous ids contain `$` and `:`, so the guard above must
     not reject the commonest real token there is. */
  it('accepts a RevenueCat anonymous id', async () => {
    const fetchImpl = jest.fn(async () =>
      rcResponse({ pro: { expires_date: FUTURE, product_identifier: 'pro_monthly' } }),
    );
    const id = '$RCAnonymousID:9f2c4b1ea7d84f0e8b3c5d6a7e8f9012';
    expect((await verifier(fetchImpl)(id))?.userId).toBe(id);
  });
});

describe('the counter', () => {
  it('partitions by UTC day, not by local day', () => {
    /* 23:30 UTC on the 17th is already the 18th in Sofia. A local-day window
       would let the same person spend a fresh allowance half an hour early, and
       the device clock is theirs to set. */
    expect(utcDay(new Date('2026-08-17T23:30:00Z'))).toBe('2026-08-17');
    expect(utcDay(new Date('2026-08-18T00:30:00Z'))).toBe('2026-08-18');
  });

  it('counts requests and tokens separately in memory', async () => {
    const quota = createMemoryQuota();
    await quota.increment('u', { input: 10, output: 5 });
    await quota.increment('u', { input: 20, output: 1 });
    expect(await quota.used('u')).toBe(2);
    expect(quota.tokens('u')).toEqual({ input: 30, output: 6 });
  });

  it('keeps callers apart', async () => {
    const quota = createMemoryQuota();
    await quota.increment('a', { input: 1, output: 1 });
    expect(await quota.used('a')).toBe(1);
    expect(await quota.used('b')).toBe(0);
  });

  it('starts a fresh window when the UTC day rolls over', async () => {
    let now = new Date('2026-08-17T23:59:00Z');
    const quota = createMemoryQuota(() => now);
    await quota.increment('u', { input: 1, output: 1 });
    expect(await quota.used('u')).toBe(1);
    now = new Date('2026-08-18T00:01:00Z');
    expect(await quota.used('u')).toBe(0);
  });

  /**
   * The property that matters, and the reason this is Postgres' job rather than
   * ours: the increment happens inside one statement, so two concurrent requests
   * cannot read the same value and both write value+1.
   */
  it('increments in a single atomic statement on postgres', async () => {
    const sql = jest.fn(async () => [] as never[]);
    const quota = createPostgresQuota(sql as never);
    await quota.increment('u', { input: 7, output: 3 });

    expect(sql).toHaveBeenCalledTimes(1);
    const [text, values] = sql.mock.calls[0] as unknown as [string, unknown[]];
    expect(text).toMatch(/on conflict \(user_id, day\) do update/i);
    expect(text).toMatch(/requests\s*=\s*assistant_usage\.requests \+ 1/i);
    /* Tokens accumulate from the row being inserted, not from a value we read
       first — same reason. */
    expect(text).toMatch(/input_tokens\s*=\s*assistant_usage\.input_tokens \+ excluded\.input_tokens/i);
    expect(values).toEqual(['u', expect.any(String), 7, 3]);
  });

  it('reads a missing postgres row as zero rather than undefined', async () => {
    const quota = createPostgresQuota((async () => []) as never);
    expect(await quota.used('nobody')).toBe(0);
  });

  it('expires every redis key at the end of the UTC day', async () => {
    const store = new Map<string, number>();
    const expires: number[] = [];
    const quota = createRedisQuota(
      {
        async incrBy(key, by) {
          store.set(key, (store.get(key) ?? 0) + by);
          return store.get(key)!;
        },
        async get(key) {
          return store.has(key) ? String(store.get(key)) : null;
        },
        async expire(_key, seconds) {
          expires.push(seconds);
        },
      },
      () => new Date('2026-08-17T23:00:00Z'),
    );

    await quota.increment('u', { input: 4, output: 2 });
    expect(await quota.used('u')).toBe(1);
    /* An hour to midnight, on every key — a counter that outlives its window is
       a user locked out until someone notices. */
    expect(expires).toHaveLength(3);
    for (const ttl of expires) expect(ttl).toBe(3600);
  });
});
