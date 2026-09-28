/**
 * Narrowing the tool set, from the picker down to the bytes on the wire.
 *
 * The decision is `toolPicker`'s and is tested next door. This is about what
 * the rest of the stack does with it, and it has two hard edges:
 *
 *  - **Narrowing must not pin the schema.** Setting `responseSchema` on a
 *    request is how a caller says "I know better than your ladder", and it
 *    switches off the step-down that exists because the strict schema has
 *    never been sent to Google with a real key. A narrowing is a statement
 *    about one utterance, not about the API, so it travels as its own field
 *    and the ladder keeps working underneath it.
 *  - **A repair widens.** If the first constrained reply came back unusable,
 *    the app's own constraint is the first thing to drop — the model cannot
 *    argue with an enum, and a second ask under the same one can only produce
 *    the same shape.
 */
import { localToEpoch } from '@/core/time';
import { createLlmClient } from '@/llm/client';
import { TOOL_NAMES } from '@/llm/contract';
import { buildSystemPrompt, type LlmContext } from '@/llm/prompt';
import {
  createGeminiProvider,
  createMockProvider,
  narrowToolNames,
  RESPONSE_SCHEMA,
  strictResponseSchema,
  type LlmRequest,
} from '@/llm/provider';

const ZONE = 'Europe/Sofia';
const NOW = localToEpoch('2026-03-04T18:05', ZONE);
const context: LlmContext = { now: NOW, zone: ZONE, weekStart: 'monday' };

/** A single-domain utterance, so the picker is certain about it. */
const LIST_UTTERANCE = 'add milk and bread to the shopping list';
const LIST_TOOLS = [
  'note_create',
  'checklist_add',
  'checklist_toggle',
  'checklist_remove',
  'checklist_delete',
];

const VALID = JSON.stringify({
  conversational_feedback: 'Added.',
  actions: [{ tool_name: 'checklist_add', parameters: { list_name: 'shopping', items: ['milk'] } }],
});

type Branches = { properties: { tool_name: { enum: string[] } } }[];

const branchesOf = (schema: unknown): Branches =>
  ((schema as { properties: { actions: { items: { anyOf?: Branches } } } }).properties.actions.items
    .anyOf ?? []) as Branches;

const envelopeEnum = (schema: unknown): string[] =>
  (
    schema as {
      properties: { actions: { items: { properties: { tool_name: { enum: string[] } } } } };
    }
  ).properties.actions.items.properties.tool_name.enum;

describe('narrowToolNames', () => {
  it('deletes the branches of the strict schema, and their parameters with them', () => {
    const full = strictResponseSchema();
    const narrowed = narrowToolNames(full, LIST_TOOLS);

    expect(branchesOf(narrowed).map((b) => b.properties.tool_name.enum[0])).toEqual(LIST_TOOLS);
    // The point of narrowing the strict rung: each branch carries a full
    // parameter schema, so dropping most of them takes most of the request with
    // it. That is the same ~4,600-token line item `schema-rung.test.ts` weighs.
    expect(JSON.stringify(narrowed).length).toBeLessThan(JSON.stringify(full).length / 3);
  });

  it('narrows the envelope rung too, where the names are one enum', () => {
    expect(envelopeEnum(narrowToolNames(RESPONSE_SCHEMA, LIST_TOOLS))).toEqual(LIST_TOOLS);
  });

  /* The cached strict schema is handed to every other turn. A narrowing that
     wrote through it would silently restrict the next utterance to the tools
     of the last one — and nothing downstream could tell. */
  it('never writes through the schema it was given', () => {
    const full = strictResponseSchema();
    narrowToolNames(full, LIST_TOOLS);
    narrowToolNames(RESPONSE_SCHEMA, LIST_TOOLS);

    expect(branchesOf(strictResponseSchema())).toHaveLength(TOOL_NAMES.length);
    expect(envelopeEnum(RESPONSE_SCHEMA)).toEqual([...TOOL_NAMES]);
  });

  it('leaves a schema it cannot read exactly as it found it', () => {
    const alien = { type: 'OBJECT', properties: { whatever: { type: 'STRING' } } };

    expect(narrowToolNames(alien, LIST_TOOLS)).toBe(alien);
    expect(narrowToolNames(null, LIST_TOOLS)).toBeNull();
    // An empty list is not "no tools are allowed" — nothing could be emitted at
    // all, and the caller plainly meant to say nothing.
    expect(narrowToolNames(RESPONSE_SCHEMA, [])).toBe(RESPONSE_SCHEMA);
    // Nor does a list naming nothing the schema knows about empty it out.
    expect(narrowToolNames(RESPONSE_SCHEMA, ['not_a_tool'])).toBe(RESPONSE_SCHEMA);
  });
});

/* ----------------------------------------------------------------- gemini -- */

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

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const okBody = {
  candidates: [{ content: { parts: [{ text: '{"actions":[]}' }] }, finishReason: 'STOP' }],
};

const request: LlmRequest = {
  system: 'You are Ridik.',
  messages: [{ role: 'user', content: LIST_UTTERANCE }],
};

const schemaOf = (call: FetchArgs): unknown =>
  (JSON.parse(String(call.init.body)) as { generationConfig: { responseSchema?: unknown } })
    .generationConfig.responseSchema;

describe('gemini with a narrowed tool set', () => {
  it('sends the rung it is on, with only the tools the caller allowed', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse(okBody));
    await createGeminiProvider({ apiKey: 'k', fetchImpl: impl }).complete({
      ...request,
      tools: LIST_TOOLS as never,
    });

    expect(branchesOf(schemaOf(calls[0]!)).map((b) => b.properties.tool_name.enum[0])).toEqual(
      LIST_TOOLS,
    );
  });

  /**
   * The hard constraint. Pinning `responseSchema` would have been the quick way
   * to narrow, and it takes the provider off its own ladder: the 400-fallback
   * is the only thing standing between an unrecognised schema keyword and a
   * dead assistant on the first real key.
   */
  it('still steps down a rung when Gemini rejects the schema', async () => {
    const { impl, calls } = stubFetch(({ init }) => {
      const body = JSON.parse(String(init.body)) as {
        generationConfig: { responseSchema?: { properties?: unknown } };
      };
      if (JSON.stringify(body.generationConfig.responseSchema).includes('anyOf')) {
        return jsonResponse(
          { error: { message: 'Invalid JSON payload: schema too complex' } },
          400,
        );
      }
      return jsonResponse(okBody);
    });

    const provider = createGeminiProvider({ apiKey: 'k', fetchImpl: impl });
    await provider.complete({ ...request, tools: LIST_TOOLS as never });

    expect(provider.schemaRung).toBe(1);
    expect(calls).toHaveLength(2);
    // …and the narrowing survives the step down: the envelope goes out with the
    // same three names rather than all 28.
    expect(envelopeEnum(schemaOf(calls[1]!))).toEqual(LIST_TOOLS);
  });

  it('sends the whole surface when the caller narrowed nothing', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse(okBody));
    await createGeminiProvider({ apiKey: 'k', fetchImpl: impl }).complete(request);

    expect(branchesOf(schemaOf(calls[0]!))).toHaveLength(TOOL_NAMES.length);
  });
});

/* ----------------------------------------------------------------- client -- */

function harness(responses: readonly string[], clientOptions = {}) {
  const provider = createMockProvider({ responses });
  const client = createLlmClient({ provider, sleep: async () => {}, ...clientOptions });
  return { provider, client };
}

const ACTIVE_TOOLS_HEADING = 'ACTIVE TOOLS';

describe('the client decides once per turn', () => {
  it('narrows a self-contained utterance and says so in the prompt', async () => {
    const { client, provider } = harness([VALID]);
    await client.interpret({ transcript: LIST_UTTERANCE, context });

    expect(provider.requests[0]!.tools).toEqual(LIST_TOOLS);
    // The enum alone is silent: a tool that is not in it cannot be emitted, so
    // the model is never told it is missing and files the utterance under the
    // nearest one that is left. The prompt names the set and the way out of it.
    expect(provider.requests[0]!.system).toContain(ACTIVE_TOOLS_HEADING);
    expect(provider.requests[0]!.system).toContain('checklist_add');
    expect(provider.requests[0]!.system).toContain('note_create in their own words');
  });

  /**
   * An answer to a clarification is a fragment — "the one on Friday", "3pm" —
   * whose subject is in the previous turn. Reading a domain off it means
   * reading it off half a sentence, and "3pm" looks like a calendar utterance
   * whatever the parked action was.
   */
  it('refuses to narrow a follow-up answer', async () => {
    const { client, provider } = harness([VALID]);
    await client.interpret({
      transcript: 'make it 3pm',
      context,
      history: [
        { role: 'user', content: 'remind me to submit the form' },
        { role: 'model', content: 'When should I remind you?' },
      ],
    });

    expect(provider.requests[0]!.tools).toBeUndefined();
    expect(provider.requests[0]!.system).not.toContain(ACTIVE_TOOLS_HEADING);
  });

  it('leaves the request untouched when narrowing is switched off', async () => {
    const { client, provider } = harness([VALID], { narrowTools: false });
    await client.interpret({ transcript: LIST_UTTERANCE, context });

    expect(provider.requests[0]!.tools).toBeUndefined();
    expect(provider.requests[0]!.system).toBe(buildSystemPrompt(context));
  });

  it('drops the narrowing, and its paragraph, on the repair', async () => {
    const { client, provider } = harness(['{"actions":[{"tool_name":"nope"}]}', VALID]);
    const result = await client.interpret({ transcript: LIST_UTTERANCE, context });

    expect(result.ok).toBe(true);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]!.tools).toEqual(LIST_TOOLS);
    expect(provider.requests[1]!.tools).toBeUndefined();
    expect(provider.requests[1]!.system).not.toContain(ACTIVE_TOOLS_HEADING);
  });

  it('says nothing about active tools when the picker declined', async () => {
    const { client, provider } = harness([VALID]);
    await client.interpret({ transcript: 'hello there', context });

    expect(provider.requests[0]!.tools).toBeUndefined();
    expect(provider.requests[0]!.system).not.toContain(ACTIVE_TOOLS_HEADING);
  });
});

describe('the prompt', () => {
  it('is byte-identical to the old one when nothing was narrowed', () => {
    expect(buildSystemPrompt(context, {})).toBe(buildSystemPrompt(context));
    expect(buildSystemPrompt(context, { tools: [...TOOL_NAMES] })).toBe(buildSystemPrompt(context));
  });

  /* Every tool stays documented, narrowed or not: the model needs to know what
     `habit_log` means to judge that it does not fit, and the examples below the
     list name tools of their own. */
  it('still documents every tool it ever documented', () => {
    const prompt = buildSystemPrompt(context, { tools: LIST_TOOLS as never });

    for (const name of TOOL_NAMES) expect(prompt).toContain(name);
    expect(prompt).toContain('ACTIVE TOOLS — this turn accepts only these tool names');
  });
});
