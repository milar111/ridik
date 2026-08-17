/**
 * The backend, tested — because it is the only thing between the operator's
 * model key and an invoice they did not expect.
 *
 * The three properties worth asserting, in order of what they cost when wrong:
 *
 *   1. The key never appears in a response. Ever. Including on failure, which is
 *      where provider SDKs love to echo the request back.
 *   2. A caller who has not paid, or whose subscription lapsed, cannot spend
 *      anything — and the check happens before the provider is touched, so a
 *      refusal costs nothing.
 *   3. The quota is counted after a *successful* answer, so a failure the user
 *      never saw does not consume their day.
 */
import { createInterpretHandler, type Caller, type Quota } from '../interpret';
import { createMemoryQuota } from '../quota';

const KEY = 'test-provider-key-do-not-leak';

function geminiOk(text = '{"tool":"note_create"}', usage = {}) {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, ...usage },
      modelVersion: 'gemini-3.7-flash',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function subscriber(over: Partial<Caller> = {}): Caller {
  return { userId: 'u1', subscriptionActive: true, dailyLimit: 10, ...over };
}

function post(body: unknown, token = 'a-token') {
  return new Request('https://api.ridik.app/v1/interpret', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID = { system: 'You file things.', messages: [{ role: 'user', content: 'note this' }] };

function harness(over: Partial<Parameters<typeof createInterpretHandler>[0]> = {}) {
  const fetchImpl = jest.fn(async () => geminiOk());
  const quota = createMemoryQuota();
  const deps = {
    verifyCaller: jest.fn(async () => subscriber()),
    quota,
    apiKey: KEY,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...over,
  };
  return { handle: createInterpretHandler(deps), fetchImpl, quota, deps };
}

describe('the model key', () => {
  /* The reason this file exists. A key in a response body is a key in the app's
     logs, in the user's proxy, and eventually on a pastebin. */
  it('never appears in a successful response', async () => {
    const { handle } = harness();
    const text = await (await handle(post(VALID))).text();
    expect(text).not.toContain(KEY);
  });

  it('never appears when the provider rejects the call', async () => {
    const { handle } = harness({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { message: `bad key ${KEY}` } }), {
          status: 401,
        })) as unknown as typeof fetch,
    });
    const response = await handle(post(VALID));
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(text).not.toContain(KEY);
    /* Not just the key — the provider's whole body is withheld, because it also
       names the account and the project. */
    expect(text).not.toContain('bad key');
  });

  it('travels in a header rather than the query string', async () => {
    const { handle, fetchImpl } = harness();
    await handle(post(VALID));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain(KEY);
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY);
  });
});

describe('who is allowed to spend', () => {
  it('refuses a request with no token without asking the provider', async () => {
    const { handle, fetchImpl } = harness();
    const response = await handle(
      new Request('https://api.ridik.app/v1/interpret', {
        method: 'POST',
        body: JSON.stringify(VALID),
      }),
    );
    expect(response.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /* An outage at RevenueCat resolves to null, and null must cost nothing. */
  it('refuses when identity cannot be established, and spends nothing', async () => {
    const { handle, fetchImpl } = harness({ verifyCaller: jest.fn(async () => null) });
    expect((await handle(post(VALID))).status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /**
   * 402 rather than 403, and the wording matters: the app turns this into a
   * notice that says the assistant is off while everything local keeps working,
   * which is the same degradation a spent trial gets.
   */
  it('answers a lapsed subscriber with 402 and touches nothing', async () => {
    const { handle, fetchImpl } = harness({
      verifyCaller: jest.fn(async () => subscriber({ subscriptionActive: false, dailyLimit: 0 })),
    });
    const response = await handle(post(VALID));
    expect(response.status).toBe(402);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stops at the daily limit and says when it resets', async () => {
    const { handle, fetchImpl, quota } = harness({
      verifyCaller: jest.fn(async () => subscriber({ dailyLimit: 2 })),
    });
    await handle(post(VALID));
    await handle(post(VALID));
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const response = await handle(post(VALID));
    expect(response.status).toBe(429);
    expect((await response.json()).retryAfterSeconds).toBeGreaterThan(0);
    /* Still 2: the refused turn must not count against tomorrow. */
    expect(await quota.used('u1')).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('what the quota counts', () => {
  it('counts a successful answer', async () => {
    const { handle, quota } = harness();
    await handle(post(VALID));
    expect(await quota.used('u1')).toBe(1);
    expect(quota.tokens('u1')).toEqual({ input: 100, output: 20 });
  });

  /* A turn the user never got an answer from is not one they should pay for. */
  it('does not count a provider failure', async () => {
    const { handle, quota } = harness({
      fetchImpl: (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch,
    });
    expect((await handle(post(VALID))).status).toBe(503);
    expect(await quota.used('u1')).toBe(0);
  });

  it('does not count an answer that came back empty', async () => {
    const { handle, quota } = harness({
      fetchImpl: (async () => geminiOk('   ')) as unknown as typeof fetch,
    });
    expect((await handle(post(VALID))).status).toBe(502);
    expect(await quota.used('u1')).toBe(0);
  });

  /**
   * Thinking tokens are billed as output and are absent from
   * `candidatesTokenCount`. Counting only the visible reply undercounts the
   * expensive turns specifically — the same trap `gemini.ts` documents.
   */
  it('bills thinking tokens as output', async () => {
    const { handle, quota } = harness({
      fetchImpl: (async () =>
        geminiOk('{"ok":1}', { thoughtsTokenCount: 500 })) as unknown as typeof fetch,
    });
    await handle(post(VALID));
    expect(quota.tokens('u1').output).toBe(520);
  });
});

describe('the wire shape the app expects', () => {
  it('joins every part of a split reply', async () => {
    const parts = [{ text: '{"tool":' }, { text: '"note_create"}' }];
    const { handle } = harness({
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts } }],
            usageMetadata: {},
          }),
        )) as unknown as typeof fetch,
    });
    /* parts[0] alone is `{"tool":` — valid-looking and unparseable, which is the
       worst failure mode available. */
    expect((await (await handle(post(VALID))).json()).text).toBe('{"tool":"note_create"}');
  });

  /* The client reads `usage.cached` to know whether the shared prompt prefix is
     paying for itself. A saving nobody can see is a saving nobody maintains. */
  it('reports what the provider served from its cache', async () => {
    const { handle } = harness({
      fetchImpl: (async () =>
        geminiOk('{"ok":1}', { cachedContentTokenCount: 64 })) as unknown as typeof fetch,
    });
    expect((await (await handle(post(VALID))).json()).usage).toEqual({
      input: 100,
      cached: 64,
      output: 20,
    });
  });

  /* `gemini-flash-latest` answered as `gemini-3.7-flash` the first time a real
     key was used — five times the assumed input price. Echoing the requested
     model would have hidden that. */
  it('reports the model that answered, not the one requested', async () => {
    const { handle } = harness({ model: 'gemini-flash-latest' });
    expect((await (await handle(post(VALID))).json()).model).toBe('gemini-3.7-flash');
  });

  it('refuses anything but POST', async () => {
    const { handle } = harness();
    expect(
      (await handle(new Request('https://api.ridik.app/v1/interpret', { method: 'GET' }))).status,
    ).toBe(405);
  });

  it.each([
    ['no system prompt', { messages: VALID.messages }],
    ['no messages', { system: 'x' }],
    ['an empty message list', { system: 'x', messages: [] }],
    ['a bad role', { system: 'x', messages: [{ role: 'system', content: 'x' }] }],
    ['an oversized message', { system: 'x', messages: [{ role: 'user', content: 'x'.repeat(9000) }] }],
  ])('rejects %s before spending anything', async (_label, body) => {
    const { handle, fetchImpl } = harness();
    expect((await handle(post(body))).status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
