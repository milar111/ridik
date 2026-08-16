/**
 * The web-to-app unlock funnel.
 *
 * Two things are being guarded here, and they pull in opposite directions.
 *
 * The link is the only part of this exchange an attacker fully controls — it is
 * a string in a browser's address bar — so the parser has to be strict, and
 * strictness that only exists in prose rots. Every spelling of the link that a
 * `success_url` might realistically produce is asserted, and so is every shape
 * that must never reach the network.
 *
 * And nothing may unlock without an explicit grant. That is easy to write and
 * easy to lose later to one well-meaning fallback, so the failure modes get
 * more tests than the happy path: a timeout, an unreadable body, a 200 that
 * says nothing, a 200 that says no. All of them have to end on the paywall.
 */
import { FREE, type Entitlement } from '../entitlement';

const mockExtra: Record<string, unknown> = {};
const mockGetItemAsync = jest.fn<Promise<string | null>, [string, unknown?]>();

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return { extra: mockExtra };
    },
  },
}));

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

jest.mock('expo-secure-store', () => ({
  __esModule: true,
  AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
  getItemAsync: (key: string, options?: unknown) => mockGetItemAsync(key, options),
}));

// Imported after the mocks so the module under test sees them.
import {
  parseUnlockLink,
  redeemUnlockLink,
  resetWebFunnel,
  verifyEndpoint,
  type UnlockOutcome,
} from '../webFunnel';

const SESSION = 'cs_live_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5';
const ENDPOINT = 'https://api.example.com/v1/billing/web-unlock';

const ACTIVE: Entitlement = {
  active: true,
  plan: 'monthly',
  tier: 'standard',
  renewsAt: 1_760_000_000_000,
  willRenew: true,
  since: 1_757_000_000_000,
  inGracePeriod: false,
  store: 'app-store',
};

/** A `Response` with only the three members the module touches. */
function reply(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected end of JSON input');
      return body;
    },
  } as unknown as Response;
}

/** Every dependency stubbed: no clock, no network, no keychain, no store. */
function deps(overrides: Partial<Parameters<typeof redeemUnlockLink>[1]> = {}) {
  return {
    readToken: async () => null,
    readEntitlement: async () => ACTIVE,
    wait: async () => {},
    ...overrides,
  };
}

beforeEach(() => {
  resetWebFunnel();
  for (const key of Object.keys(mockExtra)) delete mockExtra[key];
  mockGetItemAsync.mockReset();
  mockGetItemAsync.mockResolvedValue(null);
});

/* ---------------------------------------------------------------------- */

describe('parseUnlockLink — the spellings that have to work', () => {
  it('reads the three-slash form the app scheme produces', () => {
    expect(parseUnlockLink(`ridik:///unlock?session=${SESSION}`)).toEqual({
      kind: 'unlock',
      link: { session: SESSION },
    });
  });

  it('reads the two-slash form, where the route lands in the authority', () => {
    // Both spellings come out of real redirects and the app does not get to
    // choose which one the OS hands over.
    expect(parseUnlockLink(`ridik://unlock?session=${SESSION}`)).toEqual({
      kind: 'unlock',
      link: { session: SESSION },
    });
  });

  it('reads an https universal link, whatever the host and depth', () => {
    expect(parseUnlockLink(`https://ridik.example/app/unlock?session=${SESSION}`)).toEqual({
      kind: 'unlock',
      link: { session: SESSION },
    });
  });

  it("accepts Stripe's own parameter name", () => {
    // `{CHECKOUT_SESSION_ID}` is documented under `session_id`, so most
    // copy-pasted success_urls spell it that way.
    expect(parseUnlockLink(`ridik:///unlock?session_id=${SESSION}`)).toEqual({
      kind: 'unlock',
      link: { session: SESSION },
    });
  });

  it('accepts a backend-minted token instead of a Stripe id', () => {
    const token = 'ridik_one_time_9f8e7d6c5b4a39281706';
    expect(parseUnlockLink(`ridik:///unlock?token=${token}`)).toEqual({
      kind: 'unlock',
      link: { session: token },
    });
  });

  it('ignores the other query parameters a redirect picks up', () => {
    const url = `ridik:///unlock?utm_source=email&session=${SESSION}&plan=yearly`;
    expect(parseUnlockLink(url)).toEqual({ kind: 'unlock', link: { session: SESSION } });
  });

  it('is case-insensitive about the route and the parameter', () => {
    expect(parseUnlockLink(`RIDIK:///Unlock?SESSION=${SESSION}`)).toEqual({
      kind: 'unlock',
      link: { session: SESSION },
    });
  });

  it('drops a fragment before it can be mistaken for a parameter', () => {
    expect(parseUnlockLink(`ridik:///unlock?session=${SESSION}#&session=cs_live_other`)).toEqual({
      kind: 'unlock',
      link: { session: SESSION },
    });
  });

  it('percent-decodes and trims the session', () => {
    expect(parseUnlockLink(`ridik:///unlock?session=%20${SESSION}%20`)).toEqual({
      kind: 'unlock',
      link: { session: SESSION },
    });
  });

  it('tolerates a trailing slash', () => {
    expect(parseUnlockLink(`ridik:///unlock/?session=${SESSION}`)).toEqual({
      kind: 'unlock',
      link: { session: SESSION },
    });
  });
});

describe('parseUnlockLink — links that are not ours', () => {
  it.each([
    ['nothing at all', ''],
    ['undefined', undefined],
    ['the bare scheme, which is every cold start', 'ridik:///'],
    ['another route', 'ridik:///notes?pane=lists&list=Hardware'],
    ['a route that merely contains the word', 'ridik:///unlocked?session=x'],
    ['an unlock nested above another segment', 'ridik:///unlock/thanks'],
    ['no scheme at all', '/unlock?session=abc'],
  ])('leaves %s to expo-router', (_label, url) => {
    expect(parseUnlockLink(url)).toEqual({ kind: 'not-unlock' });
  });
});

describe('parseUnlockLink — fails closed and says why', () => {
  it.each([
    ['no session at all', 'ridik:///unlock', 'no-session'],
    ['an empty session', 'ridik:///unlock?session=', 'no-session'],
    ['a whitespace-only session', 'ridik:///unlock?session=%20%20', 'no-session'],
    ['a session too short to be one', 'ridik:///unlock?session=abc', 'bad-session'],
    [
      'a path smuggled through the session',
      'ridik:///unlock?session=cs_live_aaaaaaaaaaaaaaaaaaaa%2F..%2Fadmin',
      'bad-session',
    ],
    [
      'a url smuggled through the session',
      'ridik:///unlock?session=https%3A%2F%2Fevil.example%2Fxxxxxxxxxxxxxx',
      'bad-session',
    ],
    [
      'a cs_ prefix that is not a checkout session',
      'ridik:///unlock?session=cs_sandbox_aaaaaaaaaaaaaaaaaaaaaa',
      'bad-session',
    ],
    ['undecodable percent-encoding', 'ridik:///unlock?session=%zzaaaaaaaaaaaaaaaaaaaa', 'undecodable'],
    [
      'two different sessions in one link',
      'ridik:///unlock?session=cs_live_aaaaaaaaaaaaaaaaaaaaaa&session_id=cs_live_bbbbbbbbbbbbbbbbbbbbbb',
      'conflicting-session',
    ],
    ['a token in clear text', 'http://ridik.example/unlock?session=cs_live_aaaaaaaaaaaaaaaaaaaa', 'insecure-scheme'],
  ])('rejects %s', (_label, url, reason) => {
    // Malformed, never `not-unlock`: a bad unlock link has to be reported to
    // the user, and the two verdicts are what decides whether it is.
    expect(parseUnlockLink(url)).toEqual({ kind: 'malformed', reason });
  });

  it('accepts the same session written twice, which is not an attack', () => {
    const url = `ridik:///unlock?session=${SESSION}&session_id=${SESSION}`;
    expect(parseUnlockLink(url)).toEqual({ kind: 'unlock', link: { session: SESSION } });
  });
});

/* ---------------------------------------------------------------------- */

describe('verifyEndpoint', () => {
  it('is null when the build has no backend', () => {
    expect(verifyEndpoint()).toBeNull();
  });

  it("hangs off the assistant's backend by convention", () => {
    mockExtra.assistantApiUrl = 'https://api.example.com/';
    expect(verifyEndpoint()).toBe(ENDPOINT);
  });

  it('prefers an explicitly configured url', () => {
    mockExtra.assistantApiUrl = 'https://api.example.com';
    mockExtra.webFunnel = { verifyUrl: 'https://pay.example.com/unlock' };
    expect(verifyEndpoint()).toBe('https://pay.example.com/unlock');
  });

  it('refuses a plaintext endpoint rather than leak the session', () => {
    mockExtra.webFunnel = { verifyUrl: 'http://pay.example.com/unlock' };
    expect(verifyEndpoint()).toBeNull();
  });

  it('allows localhost, which cannot be sniffed', () => {
    mockExtra.webFunnel = { verifyUrl: 'http://localhost:8787/unlock' };
    expect(verifyEndpoint()).toBe('http://localhost:8787/unlock');
  });

  it('treats blank configuration as unset', () => {
    mockExtra.assistantApiUrl = '   ';
    mockExtra.webFunnel = { verifyUrl: '  ' };
    expect(verifyEndpoint()).toBeNull();
  });
});

/* ---------------------------------------------------------------------- */

describe('redeemUnlockLink — when there is no backend', () => {
  it('is a no-op, and sends nothing', async () => {
    const fetchImpl = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>();
    const outcome = await redeemUnlockLink(
      `ridik:///unlock?session=${SESSION}`,
      deps({ fetchImpl }),
    );
    expect(outcome).toEqual({ status: 'unconfigured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not remember the session, so a later build can still redeem it', async () => {
    await redeemUnlockLink(`ridik:///unlock?session=${SESSION}`, deps());

    mockExtra.assistantApiUrl = 'https://api.example.com';
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, { status: 'granted' }));
    const outcome = await redeemUnlockLink(
      `ridik:///unlock?session=${SESSION}`,
      deps({ fetchImpl }),
    );
    expect(outcome.status).toBe('unlocked');
  });
});

describe('redeemUnlockLink', () => {
  beforeEach(() => {
    mockExtra.assistantApiUrl = 'https://api.example.com';
  });

  it('ignores a link that is not ours without touching the network', async () => {
    const fetchImpl = jest.fn();
    expect(await redeemUnlockLink('ridik:///notes', deps({ fetchImpl }))).toEqual({
      status: 'ignored',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a malformed link before it can reach a server', async () => {
    const fetchImpl = jest.fn();
    const outcome = await redeemUnlockLink('ridik:///unlock?session=nope', deps({ fetchImpl }));
    expect(outcome).toMatchObject({ status: 'rejected', reason: 'malformed-link' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts the session and unlocks on a grant', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, { status: 'granted' }));
    const outcome = await redeemUnlockLink(
      `ridik:///unlock?session=${SESSION}`,
      deps({ fetchImpl }),
    );

    expect(outcome).toEqual({ status: 'unlocked', entitlement: ACTIVE });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      session: SESSION,
      platform: 'ios',
      appUserId: null,
    });
  });

  it('returns the entitlement the app already uses, not one of its own making', async () => {
    // The grant happens upstream; the only thing that decides whether the user
    // is subscribed is the same read every other screen makes. If this ever
    // starts synthesising an Entitlement from the response body there are two
    // sources of truth about who has paid.
    const readEntitlement = jest.fn().mockResolvedValue(ACTIVE);
    const fetchImpl = jest.fn().mockResolvedValue(
      reply(200, { status: 'granted', plan: 'yearly', tier: 'unlimited', active: true }),
    );
    const outcome = await redeemUnlockLink(
      `ridik:///unlock?session=${SESSION}`,
      deps({ fetchImpl, readEntitlement }),
    );

    expect(readEntitlement).toHaveBeenCalled();
    expect(outcome).toEqual({ status: 'unlocked', entitlement: ACTIVE });
  });

  it('presents the device token when it has one, and reads it from the assistant slot', async () => {
    mockGetItemAsync.mockResolvedValue('sess-token-123');
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, { status: 'granted' }));

    // `readToken` deliberately left at its default so the keychain slot itself
    // is under test: the funnel and the hosted assistant must present the same
    // identity, and a drifting key name would fail silently as a 401.
    await redeemUnlockLink(`ridik:///unlock?session=${SESSION}`, {
      fetchImpl,
      readEntitlement: async () => ACTIVE,
      wait: async () => {},
    });

    expect(mockGetItemAsync).toHaveBeenCalledWith('ridik.assistant.token', expect.anything());
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sess-token-123');
  });

  it('sends no authorization header when the device has no identity', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, { status: 'granted' }));
    await redeemUnlockLink(`ridik:///unlock?session=${SESSION}`, deps({ fetchImpl }));
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.headers as Record<string, string>).not.toHaveProperty('authorization');
  });
});

describe('redeemUnlockLink — nothing unlocks without an explicit grant', () => {
  beforeEach(() => {
    mockExtra.assistantApiUrl = 'https://api.example.com';
  });

  it.each([
    ['a replayed session', 409, undefined, 'already-redeemed'],
    ['an abandoned checkout', 402, undefined, 'not-paid'],
    ['a stale link', 410, undefined, 'expired'],
    ['somebody else’s session', 401, undefined, 'unauthorised'],
    ['a forbidden session', 403, undefined, 'unauthorised'],
    ['a session the server calls invalid', 400, undefined, 'malformed-link'],
    ['an unprocessable session', 422, undefined, 'malformed-link'],
    ['a broken server', 500, undefined, 'server-error'],
    ['a gateway with no opinion', 502, undefined, 'server-error'],
    ['a 200 that refuses', 200, { status: 'rejected', reason: 'expired' }, 'expired'],
    ['a 200 that refuses without saying why', 200, { status: 'rejected' }, 'server-error'],
    ['a 200 that grants nothing', 200, { status: 'ok' }, 'server-error'],
    ['a 200 with no body', 200, undefined, 'server-error'],
    ['a 200 that is not an object', 200, 'granted', 'server-error'],
  ])('%s ends on the paywall', async (_label, http, body, reason) => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(http, body));
    const outcome = await redeemUnlockLink(
      `ridik:///unlock?session=${SESSION}`,
      deps({ fetchImpl }),
    );
    expect(outcome).toMatchObject({ status: 'rejected', reason });
    expect((outcome as Extract<UnlockOutcome, { status: 'rejected' }>).message).toBeTruthy();
  });

  it('prefers the reason the server names over the status code', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(400, { reason: 'already_redeemed' }));
    const outcome = await redeemUnlockLink(
      `ridik:///unlock?session=${SESSION}`,
      deps({ fetchImpl }),
    );
    expect(outcome).toMatchObject({ status: 'rejected', reason: 'already-redeemed' });
  });

  it('never renders the server’s own words', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(reply(409, { reason: 'already-redeemed', message: '<script>oops</script>' }));
    const outcome = await redeemUnlockLink(
      `ridik:///unlock?session=${SESSION}`,
      deps({ fetchImpl }),
    );
    expect(outcome).toMatchObject({ status: 'rejected' });
    expect((outcome as Extract<UnlockOutcome, { status: 'rejected' }>).message).not.toContain(
      'script',
    );
  });

  it('reports an unreachable server as retryable, not as a refusal', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('Network request failed'));
    const outcome = await redeemUnlockLink(
      `ridik:///unlock?session=${SESSION}`,
      deps({ fetchImpl }),
    );
    expect(outcome).toMatchObject({ status: 'rejected', reason: 'unreachable' });
  });

  it('waits, then says pending rather than claiming an entitlement it cannot see', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, { status: 'granted' }));
    const readEntitlement = jest.fn().mockResolvedValue(FREE);
    const wait = jest.fn().mockResolvedValue(undefined);

    const outcome = await redeemUnlockLink(
      `ridik:///unlock?session=${SESSION}`,
      deps({ fetchImpl, readEntitlement, wait }),
    );

    expect(outcome.status).toBe('pending');
    // It re-read rather than giving up on the first miss: the grant lands
    // upstream a beat before the store SDK will admit to it.
    expect(readEntitlement.mock.calls.length).toBeGreaterThan(1);
    expect(wait).toHaveBeenCalled();
  });

  it('unlocks as soon as a re-read finds the entitlement', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, { status: 'granted' }));
    const readEntitlement = jest
      .fn()
      .mockResolvedValueOnce(FREE)
      .mockResolvedValue(ACTIVE);

    const outcome = await redeemUnlockLink(
      `ridik:///unlock?session=${SESSION}`,
      deps({ fetchImpl, readEntitlement, wait: async () => {} }),
    );
    expect(outcome).toEqual({ status: 'unlocked', entitlement: ACTIVE });
  });

  it('passes a pending payment straight through', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, { status: 'pending' }));
    const readEntitlement = jest.fn();
    const outcome = await redeemUnlockLink(
      `ridik:///unlock?session=${SESSION}`,
      deps({ fetchImpl, readEntitlement }),
    );
    expect(outcome.status).toBe('pending');
    expect(readEntitlement).not.toHaveBeenCalled();
  });
});

describe('redeemUnlockLink — the same link arriving twice', () => {
  beforeEach(() => {
    mockExtra.assistantApiUrl = 'https://api.example.com';
  });

  it('posts once when the same payment is presented twice at once', async () => {
    // A remounted screen, or a launch URL the OS hands over on two channels.
    // Without in-flight collapsing the second post hits a session the server
    // has already burned, gets an honest 409, and a purchase that worked
    // announces itself as already used.
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, { status: 'granted' }));
    const url = `ridik:///unlock?session=${SESSION}`;

    const [first, second] = await Promise.all([
      redeemUnlockLink(url, deps({ fetchImpl })),
      redeemUnlockLink(url, deps({ fetchImpl })),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first.status).toBe('unlocked');
    expect(second).toBe(first);
  });

  it('answers a re-tapped successful link from memory', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, { status: 'granted' }));
    const url = `ridik:///unlock?session=${SESSION}`;

    expect((await redeemUnlockLink(url, deps({ fetchImpl }))).status).toBe('unlocked');
    expect((await redeemUnlockLink(url, deps({ fetchImpl }))).status).toBe('unlocked');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps a refusal refused without asking again', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(409));
    const url = `ridik:///unlock?session=${SESSION}`;

    expect(await redeemUnlockLink(url, deps({ fetchImpl }))).toMatchObject({
      reason: 'already-redeemed',
    });
    expect(await redeemUnlockLink(url, deps({ fetchImpl }))).toMatchObject({
      reason: 'already-redeemed',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an unreachable server', jest.fn().mockRejectedValue(new Error('offline'))],
    ['a broken server', jest.fn().mockResolvedValue(reply(503))],
  ])('lets the user try again after %s', async (_label, failing) => {
    const url = `ridik:///unlock?session=${SESSION}`;
    expect((await redeemUnlockLink(url, deps({ fetchImpl: failing }))).status).toBe('rejected');

    const fetchImpl = jest.fn().mockResolvedValue(reply(200, { status: 'granted' }));
    expect((await redeemUnlockLink(url, deps({ fetchImpl }))).status).toBe('unlocked');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not remember a pending payment either', async () => {
    const url = `ridik:///unlock?session=${SESSION}`;
    const pending = jest.fn().mockResolvedValue(reply(200, { status: 'pending' }));
    expect((await redeemUnlockLink(url, deps({ fetchImpl: pending }))).status).toBe('pending');

    const fetchImpl = jest.fn().mockResolvedValue(reply(200, { status: 'granted' }));
    expect((await redeemUnlockLink(url, deps({ fetchImpl }))).status).toBe('unlocked');
  });

  it('keeps two different sessions apart', async () => {
    const other = 'cs_live_z9y8x7w6v5u4t3s2r1q0p9o8n7m6l5';
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, { status: 'granted' }));

    await redeemUnlockLink(`ridik:///unlock?session=${SESSION}`, deps({ fetchImpl }));
    await redeemUnlockLink(`ridik:///unlock?session=${other}`, deps({ fetchImpl }));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
