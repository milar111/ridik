/**
 * Web-to-app unlock: somebody paid on a web page, and comes back to the app.
 *
 * The shape, end to end:
 *
 *   1. A web page runs Stripe Checkout. Nothing in this repository is involved.
 *   2. Stripe's `success_url` sends the browser to a link that opens Ridik,
 *      carrying the checkout session id — see `parseUnlockLink` for the exact
 *      spellings accepted.
 *   3. expo-router matches that link to `app/unlock.tsx`, which hands it here.
 *      This file validates it, posts the session to a backend you own, and the
 *      backend grants the entitlement.
 *   4. The app re-reads the entitlement through `currentEntitlement()` — the
 *      same call the paywall and the profile already make.
 *
 * **This file never verifies a Stripe session and never can.** Verification
 * means calling Stripe with a *secret* key, and a shipped app cannot hold one:
 * anyone can unzip the bundle and read it, and that key can move money. A
 * client that decided for itself whether a payment happened would also be
 * trivially spoofable — the "session id" is just a string typed into a URL.
 * So the only thing on-device is: reject what is obviously not a real link,
 * hand the rest to a server, and believe nothing until the server has spoken.
 *
 * **Step 4 is the part that matters architecturally.** The backend grants the
 * entitlement *upstream*, in RevenueCat, against the same customer the store
 * purchases attach to. So the app does not learn a second way to be subscribed:
 * there is one `Entitlement`, produced by one provider, and a web purchase is
 * simply another reason for it to come back active. Returning entitlement
 * fields from our own endpoint would have been less code and a second source of
 * truth — the one thing the seam in `entitlement.ts` exists to prevent.
 *
 * **Capability-detected, like every other optional service here.** No endpoint
 * configured means `unconfigured`: nothing is sent, nothing is unlocked, and
 * nothing is claimed. That is the state every build is in until §2.6 of
 * `DEPLOY.md` is done, and it must be indistinguishable from the app that
 * shipped before this file existed.
 *
 * ## The backend contract this assumes
 *
 * One endpoint. `POST <verifyEndpoint()>`, `content-type: application/json`,
 * and `authorization: Bearer <token>` when the device has one (the same
 * `ridik.assistant.token` slot the hosted assistant presents).
 *
 * ```jsonc
 * // request
 * { "session": "cs_live_a1…", "platform": "ios", "appUserId": null }
 * ```
 *
 * ```jsonc
 * // 200 — the only success shape
 * { "status": "granted" }                       // entitlement granted upstream
 * { "status": "pending" }                       // payment still settling
 * { "status": "rejected", "reason": "expired" }
 * ```
 *
 * The server is expected to, in this order: verify the session with Stripe
 * using its secret key; check `payment_status === 'paid'`; **burn the session
 * so it can never be redeemed twice**; resolve which customer it belongs to;
 * grant them the entitlement in RevenueCat; and only then answer `granted`.
 * Single-use is the server's job and only the server's — a reinstall wipes
 * anything this file could remember, and the device is the one party in this
 * exchange the user can edit.
 *
 * Status codes carry the failures, so a plain reverse proxy in front of the
 * endpoint cannot turn a refusal into a success: 400/422 malformed, 401/403
 * not this user's session, 402 not paid, 409 already redeemed, 410 expired,
 * 5xx broken. Anything unrecognised is a failure, never an unlock.
 */
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { createLogger } from '@/core/logger';
import { ASSISTANT_TOKEN_STORE_KEY, readSecret } from '@/features/voice/mode';

import { currentEntitlement, type Entitlement } from './entitlement';

const log = createLogger('billing/web-funnel');

/* --------------------------------------------------------------- parsing -- */

/** The path segment that means "this link is a payment coming home". */
const UNLOCK_SEGMENT = 'unlock';

/**
 * Which query parameter holds the session, in preference order.
 *
 * `session_id` is here because Stripe's own docs put `{CHECKOUT_SESSION_ID}`
 * under that name and half the copy-pasted `success_url` in the world spells it
 * that way. `token` is for a backend that would rather mint its own single-use
 * value than let a Stripe id travel through a mail client — which is the better
 * design, and costs nothing to support.
 */
const SESSION_PARAMS = ['session', 'session_id', 'token'];

/**
 * What a session id is allowed to look like before it is allowed near a
 * network call. Stripe's are `cs_` + base62-ish; a self-issued token is
 * whatever the backend mints. Either way it is one opaque word: no slashes, no
 * dots, no spaces, no percent signs left after decoding.
 */
const SESSION_SHAPE = /^[A-Za-z0-9_-]{20,200}$/;

/** A Stripe checkout session is always one of exactly two prefixes. */
const STRIPE_SESSION = /^cs_(test|live)_/;

export type MalformedReason =
  /** `http://` — a bearer-ish token must not travel in clear text. */
  | 'insecure-scheme'
  /** `/unlock` with nothing to redeem. */
  | 'no-session'
  /** Percent-encoding that does not decode. */
  | 'undecodable'
  /** Two different sessions in one link: someone is probing the parser. */
  | 'conflicting-session'
  /** Right shape of link, wrong shape of session. */
  | 'bad-session';

export type UnlockLink = {
  /** Validated, decoded, safe to send. Never logged in full. */
  session: string;
};

export type ParsedUnlock =
  | { kind: 'unlock'; link: UnlockLink }
  /** Not addressed to the funnel at all — `/notes`, `/briefing`, a cold start. */
  | { kind: 'not-unlock' }
  /** Addressed to the funnel and wrong. Must be told to the user, not dropped. */
  | { kind: 'malformed'; reason: MalformedReason };

/**
 * Reads a deep link without trusting one byte of it.
 *
 * The app has no URL router of its own: expo-router matches file routes, and
 * the only other consumers of a raw URL are the ones that never see one. So
 * this parses by hand rather than through `URL`, which in Hermes is a partial
 * implementation that does not agree with Node's about custom schemes — the
 * tests would then be proving something the device does not do.
 *
 * Three spellings all mean the same route, because the app does not get to
 * choose which one arrives:
 *
 *   ridik:///unlock?session=cs_live_…     three slashes — empty authority
 *   ridik://unlock?session=cs_live_…      two — "unlock" lands in the authority
 *   https://your.site/unlock?session=…    a universal link, once one is set up
 *
 * The https form is accepted for the day associated domains exist; until then
 * the OS will never hand one over, and that is the right gate for it — a link
 * on a domain we do not own cannot open this app, so the host is not something
 * this function has to police.
 */
export function parseUnlockLink(url: string | null | undefined): ParsedUnlock {
  const raw = (url ?? '').trim();
  if (raw === '') return { kind: 'not-unlock' };

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(raw);
  if (!scheme) return { kind: 'not-unlock' };

  // Everything after "scheme:". The fragment is dropped first: it never reaches
  // a server, and leaving it on would let "#&session=x" look like a parameter.
  let rest = raw.slice(scheme[0].length);
  const hash = rest.indexOf('#');
  if (hash !== -1) rest = rest.slice(0, hash);

  const mark = rest.indexOf('?');
  const route = mark === -1 ? rest : rest.slice(0, mark);
  const query = mark === -1 ? '' : rest.slice(mark + 1);

  // Authority and path are folded together deliberately: in `ridik://unlock`
  // the word is the authority and in `ridik:///unlock` it is the path, and the
  // two spellings have to resolve to the same route.
  const segments = route.split('/').filter((segment) => segment !== '');
  const last = segments.length === 0 ? '' : segments[segments.length - 1]!.toLowerCase();
  if (last !== UNLOCK_SEGMENT) return { kind: 'not-unlock' };

  // Only now is the scheme worth an opinion. Checking it earlier would have
  // called every ordinary `http://` link in the world a malformed unlock.
  const protocol = scheme[1]!.toLowerCase();
  if (protocol !== 'ridik' && protocol !== 'https') {
    return { kind: 'malformed', reason: 'insecure-scheme' };
  }

  const candidates: string[] = [];
  for (const pair of query.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const key = (eq === -1 ? pair : pair.slice(0, eq)).toLowerCase();
    if (!SESSION_PARAMS.includes(key)) continue;
    candidates.push(eq === -1 ? '' : pair.slice(eq + 1));
  }
  if (candidates.length === 0) return { kind: 'malformed', reason: 'no-session' };

  const decoded = new Set<string>();
  for (const candidate of candidates) {
    let value: string;
    try {
      value = decodeURIComponent(candidate);
    } catch {
      // A stray "%" is not a session id, and guessing at what was meant is how
      // a parser starts accepting things nobody sent.
      return { kind: 'malformed', reason: 'undecodable' };
    }
    decoded.add(value.trim());
  }
  // One link, one payment. Two different values is not a user mistake.
  if (decoded.size > 1) return { kind: 'malformed', reason: 'conflicting-session' };

  const session = [...decoded][0]!;
  if (session === '') return { kind: 'malformed', reason: 'no-session' };
  if (!SESSION_SHAPE.test(session)) return { kind: 'malformed', reason: 'bad-session' };
  // `cs_` claims to be a Stripe session; then it has to look like one. A
  // half-formed id would only be rejected after a round trip, and the round
  // trip is the part that can be aimed at somebody else's server.
  if (session.startsWith('cs_') && !STRIPE_SESSION.test(session)) {
    return { kind: 'malformed', reason: 'bad-session' };
  }

  return { kind: 'unlock', link: { session } };
}

/* ---------------------------------------------------------------- config -- */

/**
 * Where the backend convention puts this, when nothing says otherwise.
 *
 * `extra.assistantApiUrl` is already a base URL that the hosted LLM provider
 * hangs `/v1/interpret` off, and the same server is the one that holds the
 * Stripe secret and the RevenueCat secret. Deriving from it means a working
 * hosted build gets the funnel with no second variable to forget.
 */
const DEFAULT_PATH = '/v1/billing/web-unlock';

/** Localhost is the one plaintext host worth allowing: it cannot be sniffed. */
const LOCAL_HOST = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/;

function extra(): Record<string, unknown> {
  return (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;
}

/**
 * The verification endpoint, or null when this build has no backend.
 *
 * Read per call rather than cached: `expoConfig` is not populated when this
 * module loads, which is the same reason `revenuecat.ts` reads its entitlement
 * id per call.
 *
 * Two sources, in order. `extra.webFunnel.verifyUrl` is the explicit one, for a
 * checkout backend that lives somewhere other than the assistant's — set
 * `EXPO_PUBLIC_RIDIK_WEB_UNLOCK_URL` and add the two lines to `app.config.ts`.
 * Otherwise it is derived from `assistantApiUrl`. Neither hardcodes a host: a
 * URL in this file would be a value a deployment cannot own, which is exactly
 * what §0 of `DEPLOY.md` forbids.
 */
export function verifyEndpoint(): string | null {
  const funnel = (extra().webFunnel ?? {}) as { verifyUrl?: string };
  const explicit = funnel.verifyUrl?.trim();
  const derived = String(extra().assistantApiUrl ?? '').trim();
  const url = explicit ? explicit : derived ? `${derived.replace(/\/+$/, '')}${DEFAULT_PATH}` : '';
  if (url === '') return null;

  // A session id in a query string over plaintext is a credential in the clear.
  // Refusing is better than a warning nobody reads: the funnel simply reports
  // itself unconfigured, which is a state the whole app already handles.
  if (!url.startsWith('https://') && !LOCAL_HOST.test(url)) {
    log.warn('the web-unlock endpoint is not https; ignoring it', { url });
    return null;
  }
  return url;
}

/* ------------------------------------------------------------ redemption -- */

export type UnlockRejection =
  /** The link itself never made sense. Nothing was sent. */
  | 'malformed-link'
  /** The server has burned this session already. */
  | 'already-redeemed'
  /** Checkout was started and not completed. */
  | 'not-paid'
  /** Too old, or the server had forgotten it. */
  | 'expired'
  /** Signed in as someone else, or not at all. */
  | 'unauthorised'
  /** No answer. Retryable, and deliberately not remembered. */
  | 'unreachable'
  /** An answer we could not act on. Also retryable. */
  | 'server-error';

export type UnlockOutcome =
  /** Not our link. The caller should carry on as though nothing happened. */
  | { status: 'ignored' }
  /** No backend in this build. Nothing was sent and nothing was unlocked. */
  | { status: 'unconfigured' }
  | { status: 'unlocked'; entitlement: Entitlement }
  /** Verified, but the entitlement has not surfaced yet. Not a failure. */
  | { status: 'pending'; message: string }
  | { status: 'rejected'; reason: UnlockRejection; message: string };

/** What the user is told. Never the server's own words — see `rejectionFor`. */
const MESSAGE: Record<UnlockRejection, string> = {
  'malformed-link': 'That link is not valid. Open the one in your receipt email.',
  'already-redeemed': 'That link has already been used. Try Restore purchases.',
  'not-paid': 'That payment did not complete, so nothing was unlocked.',
  expired: 'That link has expired. Start the checkout again.',
  unauthorised: 'That link belongs to a different account.',
  unreachable: 'Could not reach the server. Tap the link again when you are online.',
  'server-error': 'Something went wrong unlocking that. Nothing was charged twice.',
};

const PENDING_MESSAGE = 'Payment received. Your subscription will appear in a moment.';

export type RedeemDeps = {
  fetchImpl: typeof fetch;
  /** The device's identity, when it has one. */
  readToken: () => Promise<string | null>;
  /** Always the app's one entitlement read. Injected only so tests can drive it. */
  readEntitlement: () => Promise<Entitlement>;
  timeoutMs: number;
  /** Injected so tests do not actually sleep between re-reads. */
  wait: (ms: number) => Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * How long to keep asking whether the entitlement has landed.
 *
 * The grant happens in RevenueCat a moment before the SDK will admit to it, and
 * "we took your money, you are still on Free" is the single worst thing this
 * screen could say. Three reads over about a second and a half covers the
 * normal case; anything slower resolves as `pending`, which is honest, and the
 * entitlement query refetches on focus anyway.
 */
const REREAD_DELAYS_MS = [0, 400, 1_200];

/**
 * Terminal outcomes, by session, for the life of the process.
 *
 * Not persistence and not a replay defence — the server owns single-use, and
 * anything here dies with the app. It exists because one payment really can be
 * presented twice: a receipt email is tapped again, the OS re-delivers a launch
 * URL, a screen remounts. Without this the second attempt posts a session the
 * server has already burned and gets an honest 409 back, so a purchase that
 * worked would announce itself as "already used". Answering from memory instead
 * is not a shortcut around the server's verdict; it *is* the server's verdict,
 * remembered.
 */
const settled = new Map<string, UnlockOutcome>();
const inFlight = new Map<string, Promise<UnlockOutcome>>();

/** Tests only. */
export function resetWebFunnel(): void {
  settled.clear();
  inFlight.clear();
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/**
 * Validate a deep link, have the backend verify it, and report what happened.
 *
 * Never throws and never unlocks on its own authority. Every path that is not
 * an explicit `granted` from the server ends in `pending`, `rejected` or
 * `unconfigured` — there is no branch here that turns silence, a timeout or an
 * unreadable response into an entitlement.
 */
export async function redeemUnlockLink(
  url: string | null | undefined,
  overrides: Partial<RedeemDeps> = {},
): Promise<UnlockOutcome> {
  const parsed = parseUnlockLink(url);
  if (parsed.kind === 'not-unlock') return { status: 'ignored' };
  if (parsed.kind === 'malformed') {
    // Loud, because this is the failure a user can do something about, and
    // silence here is indistinguishable from the app ignoring their purchase.
    log.warn('rejected an unlock link', { reason: parsed.reason });
    return { status: 'rejected', reason: 'malformed-link', message: MESSAGE['malformed-link'] };
  }

  const { session } = parsed.link;
  const remembered = settled.get(session);
  if (remembered) return remembered;
  const running = inFlight.get(session);
  if (running) return running;

  const endpoint = verifyEndpoint();
  if (!endpoint) {
    // The whole point of the capability check: an unconfigured build behaves
    // exactly as it did before this file existed. It does not apologise, it
    // does not half-unlock, and it does not remember the session — a build with
    // the endpoint set later must be able to redeem the same link.
    log.info('an unlock link arrived but no verification endpoint is configured');
    return { status: 'unconfigured' };
  }

  const deps: RedeemDeps = {
    fetchImpl: overrides.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
    readToken: overrides.readToken ?? (() => readSecret(ASSISTANT_TOKEN_STORE_KEY)),
    readEntitlement: overrides.readEntitlement ?? currentEntitlement,
    timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    wait: overrides.wait ?? sleep,
  };

  const attempt = exchange(endpoint, session, deps)
    .then((outcome) => {
      // `pending` and the two retryable failures are not remembered: the link
      // has to stay usable, or a flaky minute would cost somebody their
      // purchase with no way back other than support.
      if (terminal(outcome)) settled.set(session, outcome);
      return outcome;
    })
    .finally(() => {
      inFlight.delete(session);
    });

  inFlight.set(session, attempt);
  return attempt;
}

function terminal(outcome: UnlockOutcome): boolean {
  if (outcome.status === 'unlocked') return true;
  return (
    outcome.status === 'rejected' &&
    outcome.reason !== 'unreachable' &&
    outcome.reason !== 'server-error'
  );
}

async function exchange(
  endpoint: string,
  session: string,
  deps: RedeemDeps,
): Promise<UnlockOutcome> {
  const token = await deps.readToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);

  let response: Response;
  try {
    response = await deps.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        session,
        platform: Platform.OS,
        // Reserved. Once the app signs in to RevenueCat with a stable id, this
        // is what tells the backend whose entitlement to grant; until then the
        // bearer token is the only identity, and an anonymous redemption is the
        // server's decision to accept or refuse.
        appUserId: null,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    log.warn('could not reach the unlock endpoint', { error });
    return { status: 'rejected', reason: 'unreachable', message: MESSAGE.unreachable };
  } finally {
    clearTimeout(timer);
  }

  const payload = await safeJson(response);

  if (!response.ok) {
    const reason = rejectionFor(response.status, payload?.reason);
    log.warn('the unlock endpoint refused the session', {
      http: response.status,
      reason,
      serverReason: payload?.reason,
    });
    return { status: 'rejected', reason, message: MESSAGE[reason] };
  }

  // A 200 with a body we cannot read is not a grant. Every unreadable answer
  // has to land here rather than fall through to something optimistic.
  const status = payload?.status;
  if (status === 'pending') return { status: 'pending', message: PENDING_MESSAGE };
  if (status !== 'granted') {
    const reason = status === 'rejected' ? rejectionFor(200, payload?.reason) : 'server-error';
    log.warn('the unlock endpoint answered 200 without granting', {
      status,
      serverReason: payload?.reason,
    });
    return { status: 'rejected', reason, message: MESSAGE[reason] };
  }

  for (const delay of REREAD_DELAYS_MS) {
    if (delay > 0) await deps.wait(delay);
    const entitlement = await deps.readEntitlement();
    if (entitlement.active) {
      log.info('unlocked from a web purchase', { plan: entitlement.plan, tier: entitlement.tier });
      return { status: 'unlocked', entitlement };
    }
  }

  // Granted upstream, not visible here yet. Saying "pending" costs the user a
  // few seconds; saying "unlocked" over an inactive entitlement would put the
  // paywall back up on the next screen they open.
  log.info('the grant was accepted but the entitlement has not surfaced yet');
  return { status: 'pending', message: PENDING_MESSAGE };
}

/**
 * The server's verdict, mapped onto ours.
 *
 * The status code is authoritative and the body only refines it. The server's
 * own `message` is deliberately never shown: it is a string from the network
 * being rendered into the UI, and the copy in this app should not be editable
 * by whatever answered the request.
 */
function rejectionFor(http: number, reason: unknown): UnlockRejection {
  const named = typeof reason === 'string' ? reason.trim().toLowerCase() : '';
  if (named === 'already-redeemed' || named === 'already_redeemed') return 'already-redeemed';
  if (named === 'not-paid' || named === 'not_paid' || named === 'unpaid') return 'not-paid';
  if (named === 'expired') return 'expired';
  if (named === 'unauthorised' || named === 'unauthorized') return 'unauthorised';
  if (named === 'malformed' || named === 'invalid') return 'malformed-link';

  if (http === 400 || http === 422) return 'malformed-link';
  if (http === 401 || http === 403) return 'unauthorised';
  if (http === 402) return 'not-paid';
  if (http === 409) return 'already-redeemed';
  if (http === 410) return 'expired';
  return 'server-error';
}

type UnlockResponse = { status?: unknown; reason?: unknown };

async function safeJson(response: Response): Promise<UnlockResponse | null> {
  try {
    return (await response.json()) as UnlockResponse;
  } catch {
    return null;
  }
}
