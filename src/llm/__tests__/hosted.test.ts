/**
 * The provider a store build uses. What matters here is the failure taxonomy:
 * a lapsed subscription, an exhausted quota and a dead server all have to reach
 * the retry layer as different things, or the app either gives up on a blip or
 * hammers a wall it cannot get past.
 */
import { createHostedProvider } from '@/llm/provider/hosted';
import { isLlmProviderError, type LlmRequest } from '@/llm/provider';

const REQUEST: LlmRequest = {
  system: 'you are ridik',
  messages: [{ role: 'user', content: 'remind me to call Ivo at 4' }],
  responseSchema: { type: 'OBJECT' },
};

function respond(status: number, body: unknown): typeof fetch {
  return jest.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

const provider = (fetchImpl: typeof fetch, token: string | null = 'session-token') =>
  createHostedProvider({
    endpoint: 'https://api.ridik.app/',
    getToken: () => token,
    fetchImpl,
  });

describe('hosted assistant provider', () => {
  it('sends the turn to the backend with the session token and no model key', async () => {
    const fetchImpl = respond(200, {
      text: '{"actions":[]}',
      model: 'gpt-5.6-luna',
      usage: { input: 2500, output: 300 },
    });

    const completion = await provider(fetchImpl).complete(REQUEST);

    expect(completion.text).toBe('{"actions":[]}');
    expect(completion.model).toBe('gpt-5.6-luna');
    expect(completion.usage).toEqual({ input: 2500, output: 300 });

    const [url, init] = (fetchImpl as jest.Mock).mock.calls[0]!;
    // The trailing slash on the configured endpoint must not double up.
    expect(url).toBe('https://api.ridik.app/v1/interpret');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer session-token');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.system).toBe(REQUEST.system);
    expect(sent.responseSchema).toEqual({ type: 'OBJECT' });
    // Nothing resembling a provider credential may be in the request.
    expect(JSON.stringify(sent)).not.toMatch(/api[_-]?key/i);
  });

  /**
   * The proxy is the half of the app where prompt caching can pay, so the only
   * thing the client insists on is being told when it did: `cached` is a slice
   * of `input`.
   *
   * This test stops at the provider boundary, which is as far as it can see.
   * The rest of the chain — a hosted turn being metered at all, and the count
   * reaching `llm_usage.cached_tokens` — is asserted in
   * `features/voice/__tests__/pipeline.test.ts`, because for one release it was
   * not true: hosted turns skipped `record()` entirely, so the column this
   * number exists to fill could never move.
   */
  it("carries the backend's cached-token count through to the meter", async () => {
    const fetchImpl = respond(200, {
      text: '{"actions":[]}',
      usage: { input: 2500, cached: 2100, output: 300 },
    });

    const completion = await provider(fetchImpl).complete(REQUEST);

    expect(completion.usage).toEqual({ input: 2500, cached: 2100, output: 300 });
  });

  it('refuses to send an anonymous request', async () => {
    const fetchImpl = respond(200, { text: 'x' });
    await expect(provider(fetchImpl, null).complete(REQUEST)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('separates a lapsed subscription from a signed-out user', async () => {
    const lapsed = respond(402, { error: { message: 'Your subscription ended on 1 August.' } });
    await expect(provider(lapsed).complete(REQUEST)).rejects.toMatchObject({
      code: 'unauthorized',
      status: 402,
      // Not retryable: paying again is the only fix, and retrying costs the
      // user a wait for an answer that cannot come.
      retryable: false,
    });

    const signedOut = respond(401, {});
    await expect(provider(signedOut).complete(REQUEST)).rejects.toMatchObject({ status: 401 });
  });

  it('treats an exhausted server quota as retryable and says when it resets', async () => {
    const fetchImpl = respond(429, { retryAfterSeconds: 900 });
    const error = await provider(fetchImpl)
      .complete(REQUEST)
      .catch((e: unknown) => e);

    expect(isLlmProviderError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'rate_limited', retryable: true });
    expect((error as Error).message).toContain('15 minutes');
  });

  it('marks a server fault retryable and a malformed request not', async () => {
    await expect(provider(respond(503, {})).complete(REQUEST)).rejects.toMatchObject({
      code: 'server',
      retryable: true,
    });
    await expect(provider(respond(400, {})).complete(REQUEST)).rejects.toMatchObject({
      code: 'bad_request',
      retryable: false,
    });
  });

  it('reports an unreachable backend as a network fault, not a bad reply', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;

    await expect(provider(fetchImpl).complete(REQUEST)).rejects.toMatchObject({
      code: 'network',
      retryable: true,
    });
  });

  it('rejects an empty body rather than handing "" to the parser', async () => {
    await expect(provider(respond(200, { text: '   ' })).complete(REQUEST)).rejects.toMatchObject({
      code: 'server',
    });
  });

  it('survives a backend that answers with something other than JSON', async () => {
    const fetchImpl = jest.fn(
      async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    ) as unknown as typeof fetch;

    await expect(provider(fetchImpl).complete(REQUEST)).rejects.toMatchObject({ code: 'server' });
  });
});
