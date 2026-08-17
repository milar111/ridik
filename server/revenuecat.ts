/**
 * `verifyCaller`, backed by RevenueCat.
 *
 * The handler's contract is one function: turn the token the app sent into a
 * `Caller`, or into null. This is the implementation for the case Ridik actually
 * ships — RevenueCat already knows who has paid, so asking it is strictly better
 * than maintaining a second copy of that truth.
 *
 * WHAT THE TOKEN IS, AND WHAT IT IS NOT.
 *
 * It is the caller's RevenueCat **app user id**. That is an opaque identifier,
 * not a credential: RevenueCat's anonymous ids look like
 * `$RCAnonymousID:9f2c…` and carry ~128 bits, so it cannot be guessed, but
 * anyone who *learns* one can spend that person's daily allowance. Nothing else
 * is exposed by that — the request body is the attacker's own sentence and the
 * response goes back to them — so the blast radius is one person's quota, and
 * `used()`/`increment()` keep it bounded to a day.
 *
 * This is stated plainly because the alternative is worse in a way that is easy
 * to miss: the honest fix is a signed token, which needs an account system, and
 * Ridik deliberately has none. "No account, nothing to sign in to" is a promise
 * on the consent screen and in the README. So the trade is: an id that must not
 * be logged anywhere it can leak, against a login screen the product does not
 * want. If that trade ever stops being acceptable, the seam is this file and
 * nothing above it changes.
 *
 * WHAT IS NEVER TRUSTED: the *entitlement*. The app does not tell the server
 * whether it has paid; the server asks RevenueCat with its own secret key. A
 * client claim about its own subscription is worth nothing, and that is the
 * whole reason this function exists rather than reading a field off the request.
 */
import type { Caller } from './interpret';

/** RevenueCat's own v1 subscriber endpoint. v2 needs a project id in the path. */
const REVENUECAT_URL = 'https://api.revenuecat.com/v1/subscribers';

export type RevenueCatOptions = {
  /**
   * A RevenueCat **secret** key (`sk_…`), from Project settings -> API keys.
   * Not the publishable `appl_`/`goog_` key the app carries — that one cannot
   * read another subscriber and is public anyway.
   */
  secretKey: string;
  /** Entitlement id that means "may use the assistant". Matches the app's. */
  entitlementId: string;
  /**
   * Requests per day, per tier. Keyed by the product identifier RevenueCat
   * reports, so it is the same vocabulary as `PLAN_IDS` in the app.
   */
  dailyLimits: Record<string, number>;
  /** Used when an active entitlement's product is not in `dailyLimits`. */
  fallbackDailyLimit: number;
  fetchImpl?: typeof fetch;
};

type SubscriberResponse = {
  subscriber?: {
    entitlements?: Record<string, { expires_date?: string | null; product_identifier?: string }>;
  };
};

export function createRevenueCatVerifier(options: RevenueCatOptions) {
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  return async function verifyCaller(token: string): Promise<Caller | null> {
    /*
     * The token goes in a URL path, so it has to be checked before it is used.
     * An id containing `../` or a newline would otherwise address a different
     * endpoint entirely. RevenueCat ids are opaque, so anything outside this
     * character set is not one.
     */
    if (!/^[\w.:$@|+-]{8,256}$/.test(token)) return null;

    const response = await doFetch(`${REVENUECAT_URL}/${encodeURIComponent(token)}`, {
      headers: {
        authorization: `Bearer ${options.secretKey}`,
        'content-type': 'application/json',
      },
    });

    /*
     * 404 is a real answer: nobody by that id. Anything else non-OK is RevenueCat
     * being unreachable, and the two must not be conflated.
     *
     * Returning null on an outage means a paying subscriber is told to sign in
     * again during someone else's incident. Returning a Caller means a lapsed one
     * gets free requests. Refusing is the cheaper mistake — the app degrades to
     * the offline matcher with a notice, which is a path it already has and
     * already explains — so `null` it is. `throw` would be indistinguishable
     * from it: the handler catches and treats it as null.
     */
    if (!response.ok) return null;

    const body = (await response.json().catch(() => null)) as SubscriberResponse | null;
    const entitlement = body?.subscriber?.entitlements?.[options.entitlementId];
    if (!entitlement) return { userId: token, subscriptionActive: false, dailyLimit: 0 };

    /*
     * `expires_date` null means a lifetime grant, not an expired one — reading a
     * missing date as "expired" would lock out exactly the people who paid most.
     * A date in the past is a lapse RevenueCat has not tidied up yet.
     */
    const expiresAt = entitlement.expires_date ? Date.parse(entitlement.expires_date) : null;
    const active = expiresAt === null || (Number.isFinite(expiresAt) && expiresAt > Date.now());
    if (!active) return { userId: token, subscriptionActive: false, dailyLimit: 0 };

    const product = entitlement.product_identifier ?? '';
    return {
      userId: token,
      subscriptionActive: true,
      dailyLimit: options.dailyLimits[product] ?? options.fallbackDailyLimit,
    };
  };
}
