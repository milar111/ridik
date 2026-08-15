import { freezeClock } from '@/core/clock';
import { localToEpoch } from '@/core/time';
import { extractJson, parseLlmResponse } from '@/llm/contract';
import { computeBackoffDelay, createLlmClient } from '@/llm/client';
import { createMockProvider, fallbackInterpret, LlmProviderError } from '@/llm/provider';
import type { LlmContext } from '@/llm/prompt';

const ZONE = 'Europe/Sofia';
const NOW = localToEpoch('2026-03-04T18:05', ZONE);
const context: LlmContext = { now: NOW, zone: ZONE, weekStart: 'monday' };

const VALID = JSON.stringify({
  conversational_feedback: 'Noted.',
  actions: [
    {
      tool_name: 'note_create',
      parameters: {
        title_summary: 'Order 10k resistors',
        category_tag: 'electronics',
        bullets: ['Need 10k resistors'],
      },
    },
  ],
});

function harness(providerOptions: Parameters<typeof createMockProvider>[0], clientOptions = {}) {
  const sleeps: number[] = [];
  const provider = createMockProvider(providerOptions);
  const client = createLlmClient({
    provider,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    baseDelayMs: 500,
    ...clientOptions,
  });
  return { provider, client, sleeps };
}

describe('computeBackoffDelay', () => {
  it('grows exponentially and stays inside the jitter window', () => {
    expect(computeBackoffDelay(0, { baseMs: 500, random: () => 0 })).toBe(250);
    expect(computeBackoffDelay(0, { baseMs: 500, random: () => 1 })).toBe(500);
    expect(computeBackoffDelay(1, { baseMs: 500, random: () => 0.5 })).toBe(750);
    expect(computeBackoffDelay(2, { baseMs: 500, random: () => 0.5 })).toBe(1500);
  });

  it('caps at maxMs however many attempts have failed', () => {
    expect(computeBackoffDelay(30, { baseMs: 500, maxMs: 8000, random: () => 1 })).toBe(8000);
    expect(computeBackoffDelay(30, { baseMs: 500, maxMs: 8000, random: () => 0 })).toBe(4000);
  });
});

describe('interpret — happy path', () => {
  it('parses a clean reply on the first attempt', async () => {
    const { client, provider, sleeps } = harness({ responses: [VALID] });
    const result = await client.interpret({ transcript: 'note that I need 10k resistors', context });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attempts).toBe(1);
    expect(result.value.model).toBe('mock-1');
    expect(result.value.raw).toBe(VALID);
    expect(result.value.response.actions).toHaveLength(1);
    expect(result.value.response.actions[0]!.tool_name).toBe('note_create');
    expect(sleeps).toEqual([]);
    expect(provider.calls).toBe(1);
  });

  it('sends the built system prompt and the history before the transcript', async () => {
    const { client, provider } = harness({ responses: [VALID] });
    await client.interpret({
      transcript: 'and add bread',
      context,
      history: [
        { role: 'user', content: 'add milk to my groceries list' },
        { role: 'model', content: '{"actions":[]}' },
      ],
    });

    const req = provider.requests[0]!;
    expect(req.system).toContain('Local datetime: 2026-03-04T18:05 (Wednesday)');
    expect(req.messages.map((m) => m.role)).toEqual(['user', 'model', 'user']);
    expect(req.messages[2]!.content).toBe('and add bread');
  });

  it('accepts a fenced or prose-wrapped reply', async () => {
    const { client } = harness({
      responses: [`Sure thing!\n\`\`\`json\n${VALID}\n\`\`\`\nHope that helps.`],
    });
    const result = await client.interpret({ transcript: 'x', context });
    expect(result.ok).toBe(true);
  });
});

describe('interpret — transport retries', () => {
  it('retries a 429 with jittered exponential backoff and then succeeds', async () => {
    const { client, provider, sleeps } = harness({ failTimes: 2, responses: [VALID] });
    const result = await client.interpret({ transcript: 'x', context });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attempts).toBe(3);
    expect(provider.calls).toBe(3);
    expect(sleeps).toEqual([375, 750]);
  });

  it('gives up after the transport budget and reports a speakable error', async () => {
    const { client, provider, sleeps } = harness(
      { failTimes: 99 },
      { maxTransportRetries: 2 },
    );
    const result = await client.interpret({ transcript: 'x', context });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(provider.calls).toBe(3);
    expect(sleeps).toEqual([375, 750]);
    expect(result.error.code).toBe('rate_limited');
    expect(result.error.retryable).toBe(true);
    expect(result.error.userMessage).toMatch(/busy/i);
  });

  it('does not retry a non-retryable provider error', async () => {
    const { client, provider, sleeps } = harness({
      failTimes: 99,
      failWith: new LlmProviderError('unauthorized', 'bad key', { status: 401 }),
    });
    const result = await client.interpret({ transcript: 'x', context });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(provider.calls).toBe(1);
    expect(sleeps).toEqual([]);
    expect(result.error.code).toBe('permission_denied');
  });

  it('abandons the turn when the caller aborts during the backoff wait', async () => {
    const controller = new AbortController();
    const sleeps: number[] = [];
    const provider = createMockProvider({ failTimes: 99 });
    const client = createLlmClient({
      provider,
      random: () => 0.5,
      baseDelayMs: 500,
      sleep: async (ms) => {
        sleeps.push(ms);
        controller.abort();
      },
    });
    const result = await client.interpret({ transcript: 'x', context, signal: controller.signal });

    expect(result.ok).toBe(false);
    // One call, one wait, then nothing: the aborted turn must not buy a retry.
    expect(provider.calls).toBe(1);
    expect(sleeps).toEqual([375]);
  });

  it('stops retrying once the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, provider } = harness({ failTimes: 99 });
    const result = await client.interpret({ transcript: 'x', context, signal: controller.signal });

    expect(result.ok).toBe(false);
    expect(provider.calls).toBe(1);
  });

  it('refuses to call an unconfigured provider', async () => {
    const { client, provider } = harness({ configured: false, responses: [VALID] });
    const result = await client.interpret({ transcript: 'x', context });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('permission_denied');
    expect(provider.calls).toBe(0);
  });

  it('never throws, even when the provider throws something unexpected', async () => {
    const { client } = harness({
      responses: () => {
        throw new TypeError('undefined is not a function');
      },
    });
    const result = await client.interpret({ transcript: 'x', context });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('upstream');
  });
});

describe('interpret — schema retries', () => {
  it('repairs malformed JSON on the second attempt', async () => {
    const { client, provider } = harness({ responses: ['I think you meant something else.', VALID] });
    const result = await client.interpret({ transcript: 'x', context });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attempts).toBe(2);

    const retry = provider.requests[1]!;
    expect(retry.messages.map((m) => m.role)).toEqual(['user', 'model', 'user']);
    expect(retry.messages[2]!.content).toContain('rejected by the schema validator');
    expect(retry.messages[2]!.content).toContain('the reply was not a JSON object');
  });

  /* A reply can be perfectly typed and still impossible. Those rejections have
     to reach the model the same way a missing field does, or the sanity rules
     are just a more elaborate way to lose a turn. */
  it('repairs a well-typed reply whose values contradict each other', async () => {
    const backwards = JSON.stringify({
      actions: [
        {
          tool_name: 'calendar_add',
          parameters: { title: 'Dentist', start: '2026-03-05T15:00', end: '2026-03-05T14:00' },
        },
      ],
    });
    const { client, provider } = harness({ responses: [backwards, VALID] });
    const result = await client.interpret({ transcript: 'dentist tomorrow at 3', context });

    expect(result.ok).toBe(true);
    const retry = provider.requests[1]!.messages[2]!.content;
    expect(retry).toContain('actions.0.parameters.end');
    expect(retry).toContain('after the start');
  });

  it('feeds the exact Zod issues back to the model', async () => {
    const wrongShape = JSON.stringify({
      actions: [{ tool_name: 'note_create', parameters: { title_summary: 'x' } }],
    });
    const { client, provider } = harness({ responses: [wrongShape, VALID] });
    const result = await client.interpret({ transcript: 'x', context });

    expect(result.ok).toBe(true);
    expect(provider.requests[1]!.messages[2]!.content).toContain('actions.0.parameters.category_tag');
  });

  /* Three replies the validator will not take mean the model cannot answer this
     utterance. A fourth ask would spend another request to be told the same
     thing, so the turn degrades to the offline engine — the user keeps what
     they said, and the reply says out loud that it came from the fallback. */
  it('answers offline rather than losing the utterance after the third malformed reply', async () => {
    const restore = freezeClock(NOW);
    try {
      const { client, provider } = harness({
        responses: ['nope', 'still nope', '{"actions": "not an array"}'],
      });
      const result = await client.interpret({
        transcript: 'spent 12 leva on lunch',
        context,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(provider.calls).toBe(3);
      expect(result.value.degraded).toBe(true);
      expect(result.value.issues?.length).toBeGreaterThan(0);
      // The raw reply is what the model really sent, not what we substituted.
      expect(result.value.raw).toBe('{"actions": "not an array"}');
      expect(result.value.model).toBe('mock-1');
      const action = result.value.response.actions[0]!;
      expect(action.tool_name).toBe('ledger_add');
      if (action.tool_name !== 'ledger_add') return;
      expect(action.parameters.amount).toBe(12);
    } finally {
      restore();
    }
  });

  it('still reports a plain error when the fallback is switched off', async () => {
    const { client, provider } = harness(
      { responses: ['nope', 'still nope', '{"actions": "not an array"}'] },
      { offlineFallback: false },
    );
    const result = await client.interpret({ transcript: 'x', context });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(provider.calls).toBe(3);
    expect(result.error.code).toBe('upstream');
    expect(result.error.userMessage).toBe(
      "I couldn't make sense of the assistant's reply. Please try saying that again.",
    );
    expect((result.error.details as { issues: string[] }).issues.length).toBeGreaterThan(0);
  });

  /* The two ladders multiply: five transport attempts inside each of three
     schema attempts is fifteen requests for one sentence nobody asked to pay
     for. The flat ceiling is what makes the worst case knowable. */
  it('never spends more than the per-turn ceiling on both ladders at once', async () => {
    const restore = freezeClock(NOW);
    try {
      const { client, provider, sleeps } = harness({ failTimes: 3, responses: () => 'not json' });
      const result = await client.interpret({ transcript: 'x', context });

      expect(result.ok).toBe(true);
      expect(provider.calls).toBe(6);
      expect(sleeps).toHaveLength(3);
      expect(result.ok && result.value.attempts).toBe(6);
    } finally {
      restore();
    }
  });

  it('accepts the nulls a structured-output model fills its optional fields with', async () => {
    // Exactly what Gemini emits against RESPONSE_SCHEMA: every declared
    // property present, the empty ones null. The contract rejects null, so
    // without normalisation this good reply would burn all three attempts.
    const withNulls = JSON.stringify({
      conversational_feedback: 'Added.',
      requires_user_input: null,
      clarification: null,
      actions: [
        {
          tool_name: 'calendar_add',
          parameters: {
            title: 'Dentist',
            start: '2026-03-05T15:00',
            end: null,
            duration_minutes: 60,
            location: null,
            all_day: null,
            project: null,
          },
        },
      ],
    });
    const { client, provider } = harness({ responses: [withNulls] });
    const result = await client.interpret({ transcript: 'dentist tomorrow at 3', context });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(provider.calls).toBe(1);
    expect(result.value.response.requires_user_input).toBe(false);
    expect(result.value.response.clarification).toBeUndefined();
    const action = result.value.response.actions[0]!;
    if (action.tool_name !== 'calendar_add') throw new Error('expected calendar_add');
    expect(action.parameters.location).toBeUndefined();
    expect(action.parameters.duration_minutes).toBe(60);
    // The raw reply is the audit trail: it keeps the nulls the model really sent.
    expect(result.value.raw).toBe(withNulls);
  });

  it('still rejects a null inside an array rather than silently dropping it', async () => {
    const nullBullet = JSON.stringify({
      actions: [
        {
          tool_name: 'note_create',
          parameters: { title_summary: 'x', category_tag: 'inbox', bullets: ['a', null] },
        },
      ],
    });
    const { client, provider } = harness({ responses: [nullBullet, VALID] });
    const result = await client.interpret({ transcript: 'x', context });

    expect(result.ok).toBe(true);
    expect(provider.calls).toBe(2);
    expect(provider.requests[1]!.messages[2]!.content).toContain('actions.0.parameters.bullets.1');
  });

  it('honours a smaller schema retry budget', async () => {
    const { client, provider } = harness(
      { responses: ['nope', VALID] },
      { maxSchemaRetries: 0, offlineFallback: false },
    );
    const result = await client.interpret({ transcript: 'x', context });

    expect(result.ok).toBe(false);
    expect(provider.calls).toBe(1);
  });
});

describe('extractJson', () => {
  it('unwraps a fenced block', () => {
    expect(extractJson('```json\n{"actions": []}\n```')).toEqual({ actions: [] });
    expect(extractJson('```\n{"actions": []}\n```')).toEqual({ actions: [] });
  });

  it('digs a JSON object out of surrounding prose', () => {
    expect(extractJson('Sure! {"actions": [], "note": "{not json}"} — done.')).toEqual({
      actions: [],
      note: '{not json}',
    });
  });

  it('returns null when there is nothing to parse', () => {
    expect(extractJson('I am afraid I cannot do that.')).toBeNull();
  });
});

describe('offline fallback', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = freezeClock(NOW);
  });
  afterEach(() => restore());

  const expectValid = (transcript: string) => {
    const response = fallbackInterpret(transcript);
    const parsed = parseLlmResponse(JSON.parse(JSON.stringify(response)));
    if (!parsed.ok) throw new Error(`${transcript} -> ${parsed.issues.join('; ')}`);
    return response;
  };

  it('turns a plain sentence into a note', () => {
    const response = expectValid('the new lab has a resin printer and two soldering stations');
    const action = response.actions[0]!;
    expect(action.tool_name).toBe('note_create');
    if (action.tool_name !== 'note_create') return;
    expect(action.parameters.title_summary).toBe(
      'The new lab has a resin printer and two soldering stations',
    );
    expect(action.parameters.category_tag).toBe('inbox');
    expect(action.parameters.bullets[0]).toContain('resin printer');
  });

  it('trims a long note title at a word boundary', () => {
    const response = expectValid(
      'The new lab has a resin printer, two soldering stations and a reflow oven',
    );
    const action = response.actions[0]!;
    if (action.tool_name !== 'note_create') throw new Error('expected note_create');
    expect(action.parameters.title_summary).toBe(
      'The new lab has a resin printer, two soldering stations and',
    );
    expect(action.parameters.bullets[0]).toContain('reflow oven');
  });

  it('turns "remind me to X at TIME" into a calendar entry today or tomorrow', () => {
    const tonight = expectValid('remind me to call mum at 7pm');
    const first = tonight.actions[0]!;
    expect(first.tool_name).toBe('calendar_add');
    if (first.tool_name !== 'calendar_add') return;
    expect(first.parameters.title).toBe('Call mum');
    expect(first.parameters.start).toBe('2026-03-04T19:00');
    expect(first.parameters.kind).toBe('reminder');

    const tomorrow = expectValid('remind me to take the bins out at 7:30 am');
    const second = tomorrow.actions[0]!;
    if (second.tool_name !== 'calendar_add') throw new Error('expected calendar_add');
    expect(second.parameters.start).toBe('2026-03-05T07:30');
  });

  it('turns "spent N on X" into a ledger entry', () => {
    const response = expectValid('spent 12 leva on lunch');
    const action = response.actions[0]!;
    expect(action.tool_name).toBe('ledger_add');
    if (action.tool_name !== 'ledger_add') return;
    expect(action.parameters.amount).toBe(12);
    expect(action.parameters.currency).toBe('BGN');
    expect(action.parameters.category).toBe('lunch');
    expect(action.parameters.direction).toBe('expense');
  });

  it('defaults the currency when the user did not say one', () => {
    const response = expectValid('spent 4.50 on coffee');
    const action = response.actions[0]!;
    if (action.tool_name !== 'ledger_add') throw new Error('expected ledger_add');
    expect(action.parameters.amount).toBe(4.5);
    expect(action.parameters.currency).toBe('EUR');
  });

  it('turns "add X to my Y list" into checklist items', () => {
    const response = expectValid('add milk, bread and coffee to my groceries list');
    const action = response.actions[0]!;
    expect(action.tool_name).toBe('checklist_add');
    if (action.tool_name !== 'checklist_add') return;
    expect(action.parameters.list_name).toBe('groceries');
    expect(action.parameters.items).toEqual(['milk', 'bread', 'coffee']);
  });

  it('asks again instead of writing an empty note', () => {
    const response = expectValid('   ');
    expect(response.actions).toEqual([]);
    expect(response.requires_user_input).toBe(true);
  });

  it('stays contract-valid on transcripts its own patterns cannot survive', () => {
    // Speech recognisers emit bare punctuation. `strip` can annihilate a
    // capture group entirely, and an empty required field used to throw a
    // ZodError straight out of the offline engine instead of degrading.
    for (const transcript of [
      '.',
      '...',
      '- - -',
      '. . . .',
      'remind me to . at 5',
      'spent 5 on .',
      'add . to my . list',
      'add milk to my . list',
    ]) {
      const response = expectValid(transcript);
      expect(response.actions).toHaveLength(1);
    }
  });

  it('drives the whole client when no script is supplied', async () => {
    const { client, provider } = harness({});
    const result = await client.interpret({ transcript: 'spent 20 euros on filament', context });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.response.actions[0]!.tool_name).toBe('ledger_add');
    expect(provider.requests[0]!.system).toContain('You are Ridik');
  });
});

describe('mock provider bookkeeping', () => {
  it('records requests and resets its script', async () => {
    const provider = createMockProvider({ responses: [VALID, VALID] });
    await provider.complete({ system: 's', messages: [{ role: 'user', content: 'a' }] });
    expect(provider.calls).toBe(1);
    expect(provider.requests).toHaveLength(1);

    provider.reset();
    expect(provider.calls).toBe(0);
    expect(provider.requests).toHaveLength(0);
    await expect(
      provider.complete({ system: 's', messages: [{ role: 'user', content: 'b' }] }),
    ).resolves.toMatchObject({ text: VALID });
  });

  it('throws once the script runs out rather than inventing a reply', async () => {
    const provider = createMockProvider({ responses: [VALID] });
    await provider.complete({ system: 's', messages: [] });
    await expect(provider.complete({ system: 's', messages: [] })).rejects.toThrow(
      /ran out of scripted replies/,
    );
  });
});
