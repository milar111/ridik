import { TOOL_NAMES } from '@/llm/contract';
import {
  createGeminiProvider,
  DEFAULT_GEMINI_MODEL,
  isLlmProviderError,
  RESPONSE_SCHEMA,
  strictResponseSchema,
  toGeminiSchema,
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

  it('stays inside the oldest corner of the subset, since it is the fallback rung', () => {
    const serialised = JSON.stringify(RESPONSE_SCHEMA);
    for (const unsupported of ['oneOf', 'anyOf', 'allOf', '$ref', 'additionalProperties']) {
      expect(serialised).not.toContain(unsupported);
    }
    // This rung deliberately leaves parameters open; the strict one below is
    // where the union is expressed.
    expect(RESPONSE_SCHEMA.properties.actions.items.properties.parameters.type).toBe('OBJECT');
  });
});

describe('the schema derived from the contract', () => {
  const schema = strictResponseSchema() as {
    type: string;
    required: string[];
    properties: Record<string, { type?: string; items?: { anyOf?: unknown[] } }>;
  };
  const serialised = JSON.stringify(schema);
  const branches = (schema.properties.actions?.items?.anyOf ?? []) as {
    properties: {
      tool_name: { enum: string[] };
      parameters: { type: string; properties?: Record<string, unknown>; required?: string[] };
    };
  }[];

  it('gives every tool its own branch, in contract order', () => {
    expect(branches.map((b) => b.properties.tool_name.enum[0])).toEqual([...TOOL_NAMES]);
  });

  /* The whole point: a tool's parameters are typed at the decoder, not just at
     the validator. A model constrained by this cannot emit `duration_minutes`
     as a string or invent a field, because neither is generatable. */
  it('types each tool\'s parameters instead of leaving the object open', () => {
    const calendarAdd = branches[0]!.properties.parameters;
    expect(calendarAdd.type).toBe('OBJECT');
    expect(calendarAdd.required).toEqual(['title', 'start']);
    expect(calendarAdd.properties).toMatchObject({
      duration_minutes: { type: 'INTEGER', minimum: 1, maximum: 1440 },
      kind: { type: 'STRING', enum: ['event', 'exam', 'class', 'reminder'] },
      // The wall-clock dialect, enforced while the tokens are being chosen.
      start: { type: 'STRING', pattern: expect.stringContaining('\\d{4}-\\d{2}-\\d{2}') },
    });
  });

  it('demands an actions array even though the validator would default one', () => {
    expect(schema.required).toContain('actions');
  });

  it('speaks only the dialect Google documents for responseSchema', () => {
    for (const unsupported of ['oneOf', 'allOf', '$ref', '$defs', 'additionalProperties', 'const', 'exclusiveMinimum']) {
      expect(serialised).not.toContain(`"${unsupported}"`);
    }
    for (const lowercase of ['"string"', '"integer"', '"boolean"', '"object"', '"array"', '"number"']) {
      expect(serialised).not.toContain(`"type":${lowercase}`);
    }
  });

  it('refuses to guess at a keyword it has not been taught', () => {
    // A zod upgrade that starts emitting something new fails here rather than
    // shipping a schema Gemini will 400 on.
    expect(() => toGeminiSchema({ type: 'string', patternProperties: {} })).toThrow(
      /patternProperties/,
    );
    expect(() => toGeminiSchema({ type: 'unknown-thing' })).toThrow(/Unsupported/);
  });

  it('translates a union, a literal and an exclusive bound', () => {
    expect(
      toGeminiSchema({
        oneOf: [
          { type: 'string', const: 'a' },
          { type: 'number', exclusiveMinimum: 0, default: 3 },
        ],
      }),
    ).toEqual({
      anyOf: [
        { type: 'STRING', enum: ['a'] },
        { type: 'NUMBER', minimum: 0 },
      ],
    });
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

  it('asks for JSON against the strict schema at a low temperature', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse(okBody));
    await createGeminiProvider({ apiKey: 'k', fetchImpl: impl }).complete(request);

    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.systemInstruction.parts[0].text).toBe('You are Ridik.');
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'note that I need resistors' }] },
    ]);
    expect(body.generationConfig.temperature).toBe(0.1);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema).toEqual(
      JSON.parse(JSON.stringify(strictResponseSchema())),
    );
  });

  /* No request has ever been made with a real key, and the strict schema is by
     far the largest thing we send. If Google will not decode against it, the
     turn must degrade, not die: one step down the ladder, one retry, and the
     step is remembered so the next turn does not pay for it again. */
  it('steps down to the simple schema when Gemini rejects the strict one', async () => {
    let rejected = 0;
    const { impl, calls } = stubFetch(({ init }) => {
      const body = JSON.parse(String(init.body));
      if (JSON.stringify(body.generationConfig.responseSchema).includes('anyOf')) {
        rejected += 1;
        return jsonResponse(
          { error: { message: 'Invalid value at generation_config.response_schema: too complex' } },
          400,
        );
      }
      return jsonResponse(okBody);
    });

    const provider = createGeminiProvider({ apiKey: 'k', fetchImpl: impl });
    await expect(provider.complete(request)).resolves.toMatchObject({ text: '{"actions":[]}' });
    expect(rejected).toBe(1);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[1]!.init.body)).generationConfig.responseSchema).toEqual(
      JSON.parse(JSON.stringify(RESPONSE_SCHEMA)),
    );
    expect(provider.schemaRung).toBe(1);

    await provider.complete(request);
    expect(calls).toHaveLength(3);
    expect(rejected).toBe(1);
  });

  it('drops the schema entirely rather than losing the turn', async () => {
    const { impl, calls } = stubFetch(({ init }) => {
      const body = JSON.parse(String(init.body));
      return body.generationConfig.responseSchema
        ? jsonResponse({ error: { message: 'response_schema is not supported by this model' } }, 400)
        : jsonResponse(okBody);
    });

    const provider = createGeminiProvider({ apiKey: 'k', fetchImpl: impl });
    await expect(provider.complete(request)).resolves.toMatchObject({ text: '{"actions":[]}' });
    expect(calls).toHaveLength(3);
    expect(provider.schemaRung).toBe(2);
  });

  /**
   * Any 400 on a schema-bearing call steps down. This test used to assert the
   * opposite, and that assertion is what broke the assistant.
   *
   * The rule was `status === 400 && /schema/i.test(message)`. The first real
   * request this app ever made came back with:
   *
   *     400  "Request contains an invalid argument."
   *
   * No mention of a schema. So the ladder never stepped down and **every turn
   * failed permanently** — on the exact code path built to survive this. The
   * test passed throughout, because it was written against a message Google
   * does not actually send.
   *
   * The test is now the shape of the request, not the wording of the reply:
   * we sent a schema and got a 400, so the schema is what we stop sending.
   * A 400 that was really about something else costs one extra, smaller call
   * that fails the same way; not stepping down costs the utterance.
   */
  it('steps down on any 400 while it is carrying a schema', async () => {
    const { impl, calls } = stubFetch(() =>
      jsonResponse({ error: { message: 'Request contains an invalid argument.' } }, 400),
    );
    const provider = createGeminiProvider({ apiKey: 'k', fetchImpl: impl });

    await expect(provider.complete(request)).rejects.toMatchObject({ code: 'bad_request' });
    // Rung 0, rung 1, then rung 2 — which carries no schema, so the last 400
    // is taken at face value and the turn ends.
    expect(calls).toHaveLength(3);
    expect(provider.schemaRung).toBe(2);
  });

  /* And once there is no schema left to blame, a 400 is just a 400. */
  it('stops laddering when it is no longer sending a schema', async () => {
    const { impl, calls } = stubFetch(() =>
      jsonResponse({ error: { message: 'contents is not specified' } }, 400),
    );
    const provider = createGeminiProvider({ apiKey: 'k', fetchImpl: impl, startRung: 2 });

    await expect(provider.complete(request)).rejects.toMatchObject({ code: 'bad_request' });
    expect(calls).toHaveLength(1);
  });

  it('never ladders away from a schema the caller pinned', async () => {
    const { impl, calls } = stubFetch(() =>
      jsonResponse({ error: { message: 'bad response_schema' } }, 400),
    );
    const custom = { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } } };
    const provider = createGeminiProvider({ apiKey: 'k', fetchImpl: impl, responseSchema: custom });

    await expect(provider.complete(request)).rejects.toMatchObject({ code: 'bad_request' });
    expect(calls).toHaveLength(1);
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
    expect(completion.usage?.cached).toBeUndefined();
    expect(completion.latencyMs).toBeGreaterThanOrEqual(0);
  });

  /**
   * The only signal that prompt caching did anything. `promptTokenCount`
   * already counts these tokens, so without the separate number a cache hit and
   * a cache miss are the same row in the meter.
   */
  it('captures the cached slice of the prompt when Gemini reports one', async () => {
    const { impl } = stubFetch(() =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: '{"actions":[]}' }] }, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 7_300,
          candidatesTokenCount: 90,
          cachedContentTokenCount: 6_900,
        },
      }),
    );
    const completion = await createGeminiProvider({ apiKey: 'k', fetchImpl: impl }).complete(
      request,
    );

    expect(completion.usage).toEqual({ input: 7_300, cached: 6_900, output: 90 });
  });

  /**
   * Reasoning tokens bill at the output rate — six times input on this family —
   * and Gemini reports them SEPARATELY from `candidatesTokenCount`, which counts
   * only the reply a caller can see. Reading just the visible number made every
   * thinking token invisible to the meter, the cost cap and the free trial, so
   * the more the model thought the further the estimate drifted below the bill.
   */
  it('counts what the model thought as well as what it said', async () => {
    const { impl } = stubFetch(() =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: '{"actions":[]}' }] }, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 3_240,
          candidatesTokenCount: 120,
          thoughtsTokenCount: 480,
        },
      }),
    );
    const completion = await createGeminiProvider({ apiKey: 'k', fetchImpl: impl }).complete(
      request,
    );

    expect(completion.usage).toEqual({ input: 3_240, output: 600 });
  });

  /* A model that reported no thinking must not become a model that reported
     none of anything: undefined means "the provider said nothing", which the
     meter treats differently from zero. */
  it('leaves output alone when nothing was thought', async () => {
    const { impl } = stubFetch(() =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: '{"actions":[]}' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 3_240, candidatesTokenCount: 120 },
      }),
    );
    const completion = await createGeminiProvider({ apiKey: 'k', fetchImpl: impl }).complete(
      request,
    );

    expect(completion.usage).toEqual({ input: 3_240, output: 120 });
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
