import { TOOL_NAMES } from '@/llm/contract';
import {
  createGeminiProvider,
  DEFAULT_GEMINI_MODEL,
  isLlmProviderError,
  RESPONSE_SCHEMA,
  type LlmRequest,
} from '@/llm/provider';

type FetchArgs = { url: string; init: RequestInit };

function stubFetch(handler: (args: FetchArgs) => Promise<Response> | Response) {
  const calls: FetchArgs[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const args = { url: String(input), init: init ?? {} };
    calls.push(args);
    return handler(args);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Never resolves; rejects the way a real fetch does once its signal aborts. */
const hangingFetch = () =>
  stubFetch(
    ({ init }) =>
      new Promise<Response>((_resolve, reject) => {
        if (init.signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  );

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const okBody = {
  candidates: [{ content: { parts: [{ text: '{"actions":[]}' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 80 },
};

const request: LlmRequest = {
  system: 'You are Ridik.',
  messages: [{ role: 'user', content: 'note that I need resistors' }],
};

describe('RESPONSE_SCHEMA', () => {
  it('lists exactly the contract tool names', () => {
    expect(RESPONSE_SCHEMA.properties.actions.items.properties.tool_name.enum).toEqual([
      ...TOOL_NAMES,
    ]);
  });

  it('stays inside Gemini\'s OpenAPI subset', () => {
    const serialised = JSON.stringify(RESPONSE_SCHEMA);
    for (const unsupported of ['oneOf', 'anyOf', 'allOf', '$ref', 'additionalProperties']) {
      expect(serialised).not.toContain(unsupported);
    }
    // The discriminated union cannot be expressed, so parameters stays open.
    expect(RESPONSE_SCHEMA.properties.actions.items.properties.parameters.type).toBe('OBJECT');
  });
});

describe('gemini provider', () => {
  it('reports whether a key is present', () => {
    expect(createGeminiProvider({ apiKey: '  ' }).isConfigured()).toBe(false);
    expect(createGeminiProvider({ apiKey: () => null }).isConfigured()).toBe(false);
    expect(createGeminiProvider({ apiKey: 'k' }).isConfigured()).toBe(true);
  });

  it('sends the key in a header, never in the URL', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse(okBody));
    const provider = createGeminiProvider({ apiKey: 'secret-key', fetchImpl: impl });
    await provider.complete(request);

    const call = calls[0]!;
    expect(call.url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`,
    );
    expect(call.url).not.toContain('secret-key');
    expect((call.init.headers as Record<string, string>)['x-goog-api-key']).toBe('secret-key');
  });

  it('asks for JSON against the response schema at a low temperature', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse(okBody));
    await createGeminiProvider({ apiKey: 'k', fetchImpl: impl }).complete(request);

    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.systemInstruction.parts[0].text).toBe('You are Ridik.');
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'note that I need resistors' }] },
    ]);
    expect(body.generationConfig.temperature).toBe(0.1);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema).toEqual(JSON.parse(JSON.stringify(RESPONSE_SCHEMA)));
  });

  it('omits the schema when it is explicitly disabled', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse(okBody));
    await createGeminiProvider({ apiKey: 'k', fetchImpl: impl, responseSchema: null }).complete(
      request,
    );
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.generationConfig.responseSchema).toBeUndefined();
    expect(body.generationConfig.responseMimeType).toBeUndefined();
  });

  it('lets a single request disable the schema without rebuilding the provider', async () => {
    // The documented escape hatch if Gemini ever rejects our schema shape:
    // null on the request means "no schema", not "use the default".
    const { impl, calls } = stubFetch(() => jsonResponse(okBody));
    const provider = createGeminiProvider({ apiKey: 'k', fetchImpl: impl });
    await provider.complete({ ...request, responseSchema: null });
    expect(JSON.parse(String(calls[0]!.init.body)).generationConfig.responseSchema).toBeUndefined();

    await provider.complete(request);
    expect(JSON.parse(String(calls[1]!.init.body)).generationConfig.responseSchema).toBeDefined();
  });

  it('prefers a per-request schema over the provider default', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse(okBody));
    const custom = { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } } };
    await createGeminiProvider({ apiKey: 'k', fetchImpl: impl }).complete({
      ...request,
      responseSchema: custom,
    });
    expect(JSON.parse(String(calls[0]!.init.body)).generationConfig.responseSchema).toEqual(custom);
  });

  it('returns the joined candidate text, model and usage', async () => {
    const { impl } = stubFetch(() =>
      jsonResponse({
        candidates: [
          { content: { parts: [{ text: '{"act' }, { text: 'ions":[]}' }] }, finishReason: 'STOP' },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
      }),
    );
    const completion = await createGeminiProvider({
      apiKey: 'k',
      fetchImpl: impl,
      model: 'gemini-3-pro',
    }).complete(request);

    expect(completion.text).toBe('{"actions":[]}');
    expect(completion.model).toBe('gemini-3-pro');
    expect(completion.usage).toEqual({ input: 10, output: 4 });
    expect(completion.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it.each([
    [429, 'rate_limited', true],
    [500, 'server', true],
    [503, 'server', true],
    [401, 'unauthorized', false],
    [403, 'unauthorized', false],
    [400, 'bad_request', false],
  ])('maps HTTP %i to %s', async (status, code, retryable) => {
    const { impl } = stubFetch(() => jsonResponse({ error: { message: 'nope' } }, status));
    const provider = createGeminiProvider({ apiKey: 'k', fetchImpl: impl });

    await expect(provider.complete(request)).rejects.toMatchObject({ code, retryable, status });
  });

  it('maps a fetch rejection to a retryable network error', async () => {
    const { impl } = stubFetch(() => {
      throw new TypeError('Network request failed');
    });
    const provider = createGeminiProvider({ apiKey: 'k', fetchImpl: impl });

    await expect(provider.complete(request)).rejects.toMatchObject({
      code: 'network',
      retryable: true,
    });
  });

  it('fails fast without a key', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse(okBody));
    const provider = createGeminiProvider({ apiKey: '', fetchImpl: impl });

    await expect(provider.complete(request)).rejects.toMatchObject({
      code: 'unauthorized',
      retryable: false,
    });
    expect(calls).toHaveLength(0);
  });

  it('surfaces a blocked prompt and a safety stop as non-retryable', async () => {
    const blocked = stubFetch(() => jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } }));
    await expect(
      createGeminiProvider({ apiKey: 'k', fetchImpl: blocked.impl }).complete(request),
    ).rejects.toMatchObject({ code: 'bad_request', retryable: false });

    const unsafe = stubFetch(() =>
      jsonResponse({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] }),
    );
    await expect(
      createGeminiProvider({ apiKey: 'k', fetchImpl: unsafe.impl }).complete(request),
    ).rejects.toThrow(/safety/i);
  });

  it('treats an empty candidate list as a retryable server fault', async () => {
    const { impl } = stubFetch(() => jsonResponse({ candidates: [] }));
    await expect(
      createGeminiProvider({ apiKey: 'k', fetchImpl: impl }).complete(request),
    ).rejects.toMatchObject({ code: 'server', retryable: true });
  });

  it('reports a truncated reply rather than retrying it forever', async () => {
    const { impl } = stubFetch(() =>
      jsonResponse({ candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] }),
    );
    await expect(
      createGeminiProvider({ apiKey: 'k', fetchImpl: impl }).complete(request),
    ).rejects.toMatchObject({ code: 'bad_request', retryable: false });
  });

  it('honours an abort signal without asking for a retry', async () => {
    const controller = new AbortController();
    const { impl } = hangingFetch();
    const promise = createGeminiProvider({ apiKey: 'k', fetchImpl: impl }).complete({
      ...request,
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: 'network', retryable: false });
  });

  it('aborts a request whose signal was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { impl, calls } = hangingFetch();

    await expect(
      createGeminiProvider({ apiKey: 'k', fetchImpl: impl }).complete({
        ...request,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'network', retryable: false });
    expect(calls[0]!.init.signal?.aborted).toBe(true);
  });

  it('times out slow requests as retryable', async () => {
    const { impl } = hangingFetch();
    const error = await createGeminiProvider({ apiKey: 'k', fetchImpl: impl, timeoutMs: 10 })
      .complete(request)
      .catch((e: unknown) => e);

    expect(isLlmProviderError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'network', retryable: true });
  });
});
