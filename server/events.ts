/**
 * The usage ingest. `POST /v1/events`. NOT DEPLOYED — a starting point, like
 * `interpret.ts` beside it.
 *
 * It exists because `docs/privacy.md` stakes its credibility on being checkable
 * against this repository, and half a claim is not checkable: the app can be
 * read to see that it sends counters and nothing else, but "and the server
 * keeps no identity" is a promise about code that was not here. This is that
 * code.
 *
 * The design is almost entirely about what it refuses to do.
 *
 * - **No authentication, deliberately.** `interpret.ts` needs a token because
 *   it spends the operator's money; this spends nothing, and a token would be
 *   an identifier — the one thing the payload is guaranteed not to carry. The
 *   cost of that choice is that the endpoint is spammable, which is what
 *   `Sink.rateLimit` is for.
 * - **No IP, no user agent, no timestamp of arrival.** The batch carries a
 *   local *date* and the sink is handed exactly that. Recording when a request
 *   arrived, to the second, alongside a batch of behaviour, reconstructs a
 *   session — which is precisely what the app went to the trouble of not
 *   sending.
 * - **No pass-through.** Every event is re-validated here against the same
 *   closed shape the app validated it against. A server that trusts its client
 *   is a server whose privacy properties are a client-side promise.
 *
 * What is left to you is `Sink` — where the counters go. Anything that can
 * append rows works; the reference is deliberately not a database.
 */

/* -------------------------------------------------------------- the seams -- */

export type IngestEvent = {
  name: string;
  props: Record<string, unknown>;
  local_date: string;
};

export interface Sink {
  /** Append a validated batch. Never called with an empty array. */
  write(events: readonly IngestEvent[]): Promise<void>;
  /**
   * Coarse abuse control, and the only reason this endpoint sees anything
   * request-shaped at all. Return false to drop the batch with a 429.
   *
   * Implement it against a hash of the caller's IP **that you do not store**,
   * or against nothing at all if your platform already rate-limits. Do not be
   * tempted to keep the key: a per-IP counter kept next to the events is an
   * identifier joined to behaviour, which is the thing this whole path exists
   * to avoid.
   */
  rateLimit?(request: Request): Promise<boolean> | boolean;
}

export type Deps = {
  sink: Sink;
  /**
   * The event names the app is allowed to send, and the only vocabulary this
   * endpoint accepts. Keep it in step with
   * `src/services/analytics/events.ts` — an unknown name is dropped, not
   * stored, so a server running behind the app loses new events rather than
   * accumulating rows it cannot describe.
   */
  allowedNames: readonly string[];
};

/** One request's worth, matching `BATCH` in `services/analytics/upload.ts`. */
const MAX_EVENTS = 200;

/** Nothing legitimate is close to this; it is a parser guard, not a policy. */
const MAX_BODY_BYTES = 256 * 1024;

/** Comfortably longer than the longest enum member, far shorter than a phrase. */
const MAX_VALUE_CHARS = 24;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Is this one event, and is it *only* the three fields it should be?
 *
 * Strict about shape rather than about values: the props are that event's own
 * business and this file deliberately does not encode eleven schemas it would
 * then have to keep in step. What it does enforce is that nothing arrived
 * beside them — an extra key is the shape of a client that has started sending
 * something new, and dropping it loudly is better than storing it quietly.
 */
function valid(candidate: unknown, allowedNames: readonly string[]): candidate is IngestEvent {
  if (candidate === null || typeof candidate !== 'object') return false;
  const event = candidate as Record<string, unknown>;

  const keys = Object.keys(event).sort();
  if (keys.length !== 3) return false;
  if (keys[0] !== 'local_date' || keys[1] !== 'name' || keys[2] !== 'props') return false;

  if (typeof event.name !== 'string' || !allowedNames.includes(event.name)) return false;
  if (typeof event.local_date !== 'string' || !DATE.test(event.local_date)) return false;
  if (event.props === null || typeof event.props !== 'object' || Array.isArray(event.props)) {
    return false;
  }

  // The property that makes the whole disclosure true: no value inside `props`
  // may be free text.
  //
  // Stated as a *shape* rather than a length, because a length alone is the
  // wrong rule and the test that caught it is worth keeping in mind — a
  // generous cap happily accepted "the doctor said the results were", which is
  // exactly the kind of sentence this endpoint exists to never hold. Every
  // legitimate value in the app's vocabulary is a single token: an enum member
  // (`crm_log_interaction`, the longest at nineteen), a bucket (`1-2s`), a
  // route, a small integer or a bit. None of them contains whitespace and none
  // of them is long. A value that is either is not from the vocabulary, whether
  // it got here by a bug or by somebody posting to an open endpoint.
  for (const value of Object.values(event.props as Record<string, unknown>)) {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') continue;
    if (typeof value !== 'string') return false;
    if (value.length > MAX_VALUE_CHARS || /\s/.test(value)) return false;
  }

  return true;
}

export function createEventsHandler(deps: Deps) {
  return async function handle(request: Request): Promise<Response> {
    if (request.method !== 'POST') return json(405, { error: { message: 'Use POST.' } });

    if (deps.sink.rateLimit && !(await deps.sink.rateLimit(request))) {
      return json(429, { error: { message: 'Too many.' } });
    }

    let body: unknown;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) return json(413, { error: { message: 'Too large.' } });
      body = JSON.parse(text);
    } catch {
      return json(400, { error: { message: 'Bad JSON.' } });
    }

    const events = (body as { events?: unknown })?.events;
    if (!Array.isArray(events)) return json(400, { error: { message: 'Expected { events }.' } });
    if (events.length > MAX_EVENTS) return json(413, { error: { message: 'Too many events.' } });

    const accepted = events.filter((event) => valid(event, deps.allowedNames)) as IngestEvent[];

    // 202 with a count rather than 400 on a partial batch, and the app treats
    // any 2xx as "sent". A batch that is half-recognised is a client one
    // version ahead of this server; refusing the whole thing would make it
    // retry that batch for ever, which costs the user's battery to protect a
    // row nobody can read anyway.
    if (accepted.length > 0) await deps.sink.write(accepted);

    return json(202, { accepted: accepted.length, dropped: events.length - accepted.length });
  };
}
