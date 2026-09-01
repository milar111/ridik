/**
 * The ingest, and mostly the things it refuses.
 *
 * The valuable assertions here are the negative ones. A privacy claim that
 * rests on "the client only sends counters" is a claim about somebody else's
 * binary; these tests are what make it a claim about this server too.
 */
import { createEventsHandler, type IngestEvent, type Sink } from '../events';

const NAMES = ['turn', 'tool', 'screen', 'app_open'];

function harness(overrides: Partial<Sink> = {}) {
  const written: IngestEvent[][] = [];
  const sink: Sink = {
    write: async (events) => {
      written.push([...events]);
    },
    ...overrides,
  };
  return { written, handle: createEventsHandler({ sink, allowedNames: NAMES }) };
}

const post = (body: unknown) =>
  new Request('https://example.test/v1/events', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const turn = (): IngestEvent => ({
  name: 'turn',
  props: { mode: 'model', input: 'voice', actions: 2, status: 'ok', latency: '1-2s', repaired: 0 },
  local_date: '2026-09-01',
});

describe('the usage ingest', () => {
  it('accepts a well-formed batch and writes it once', async () => {
    const { written, handle } = harness();
    const response = await handle(post({ events: [turn(), turn()] }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 2, dropped: 0 });
    expect(written).toHaveLength(1);
    expect(written[0]).toHaveLength(2);
  });

  it('refuses anything but POST', async () => {
    const { handle } = harness();
    const response = await handle(new Request('https://example.test/v1/events'));
    expect(response.status).toBe(405);
  });

  it('drops an event carrying a field the vocabulary does not have', async () => {
    const { written, handle } = harness();
    // The shape a client would send if somebody added a transcript to an event.
    const response = await handle(
      post({ events: [{ ...turn(), transcript: 'call Ivo at four' }] }),
    );

    expect(await response.json()).toEqual({ accepted: 0, dropped: 1 });
    expect(written).toHaveLength(0);
  });

  it('keeps every legitimate vocabulary value, including the longest', async () => {
    const { handle } = harness();
    const response = await handle(
      post({
        events: [
          {
            name: 'tool',
            // The longest enum member the app can send.
            props: { name: 'crm_log_interaction', ok: 1, confirmed: 0, undone: 0 },
            local_date: '2026-09-01',
          },
        ],
      }),
    );
    expect(await response.json()).toEqual({ accepted: 1, dropped: 0 });
  });

  it('drops an event whose props contain free text', async () => {
    const { written, handle } = harness();
    const response = await handle(
      post({
        events: [
          {
            name: 'screen',
            props: { route: 'notes', body: 'the doctor said the results were' },
            local_date: '2026-09-01',
          },
        ],
      }),
    );

    expect(await response.json()).toEqual({ accepted: 0, dropped: 1 });
    expect(written).toHaveLength(0);
  });

  it('drops an event whose props contain a nested object', async () => {
    const { handle } = harness();
    const response = await handle(
      post({ events: [{ name: 'screen', props: { route: { deep: 1 } }, local_date: '2026-09-01' }] }),
    );
    expect(await response.json()).toEqual({ accepted: 0, dropped: 1 });
  });

  it('drops an unknown event name rather than storing a row it cannot describe', async () => {
    const { handle } = harness();
    const response = await handle(
      post({ events: [{ name: 'exfiltrate', props: {}, local_date: '2026-09-01' }] }),
    );
    expect(await response.json()).toEqual({ accepted: 0, dropped: 1 });
  });

  it('refuses a timestamp finer than a local date', async () => {
    const { handle } = harness();
    const response = await handle(
      post({ events: [{ ...turn(), local_date: '2026-09-01T09:14:22.114Z' }] }),
    );
    expect(await response.json()).toEqual({ accepted: 0, dropped: 1 });
  });

  /**
   * A client one version ahead sends events this server has never heard of.
   * Taking the ones it understands and acknowledging the batch is what stops
   * that client retrying the same rows until its battery runs out.
   */
  it('accepts the recognised half of a mixed batch', async () => {
    const { written, handle } = harness();
    const response = await handle(
      post({ events: [turn(), { name: 'from_the_future', props: {}, local_date: '2026-09-01' }] }),
    );

    expect(await response.json()).toEqual({ accepted: 1, dropped: 1 });
    expect(written[0]).toHaveLength(1);
  });

  it('never calls the sink with an empty batch', async () => {
    const { written, handle } = harness();
    await handle(post({ events: [] }));
    expect(written).toHaveLength(0);
  });

  it('rejects a batch larger than the client is allowed to send', async () => {
    const { handle } = harness();
    const response = await handle(post({ events: Array.from({ length: 201 }, turn) }));
    expect(response.status).toBe(413);
  });

  it('rejects malformed JSON and a missing events array', async () => {
    const { handle } = harness();
    expect((await handle(post('{not json'))).status).toBe(400);
    expect((await handle(post({ rows: [] }))).status).toBe(400);
  });

  it('honours the rate limiter and does not write when it says no', async () => {
    const { written, handle } = harness({ rateLimit: () => false });
    const response = await handle(post({ events: [turn()] }));

    expect(response.status).toBe(429);
    expect(written).toHaveLength(0);
  });
});
