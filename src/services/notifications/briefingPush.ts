/**
 * What a briefing push says, and where tapping it goes.
 *
 * Pure, and importable under plain Node — everything in this file is a decision
 * rather than a call, which is what lets the wording of a push be tested
 * without a device, a network or an OneSignal account.
 *
 * The shape of the feature, because it is not obvious from the code alone:
 * OneSignal composes and sends the message, but it has no idea what is on
 * anybody's calendar. So the app publishes the facts as **data tags** — the
 * briefing line the card is already showing, plus the handful of counts worth
 * segmenting on — and the dashboard's message is a Liquid template over them:
 *
 *     {{ briefing_line | default: "Here's your day." }}
 *
 * That split is the same one the rest of the app holds to: the device owns the
 * facts, the dashboard owns the copy and the schedule, and neither is compiled
 * in. It is also the only way the push can speak in the app's own voice —
 * `briefingPushBody` takes the bullets `composeVisual` produced, so a push can
 * never word the day differently from the screen it opens.
 */
import type { Briefing, BriefingBullets } from '@/features/briefing';

/** Where a briefing push lands. */
export const BRIEFING_HREF = '/briefing';

/**
 * The OneSignal App ID for this build, or null when there is no push project.
 *
 * Lives here rather than next to the SDK call so that "an unset App ID is a
 * silent no-op" is a fact a plain-Node test can assert. It takes
 * `Constants.expoConfig?.extra` — never reads it — because `expo-constants` is
 * native and this module must stay loadable without it.
 *
 * Whitespace counts as unset: an environment variable set to `""` in a CI
 * matrix is somebody saying "no push here", not an App ID.
 */
export function pushAppId(extra: unknown): string | null {
  if (typeof extra !== 'object' || extra === null) return null;
  const configured = (extra as { oneSignal?: { appId?: unknown } }).oneSignal?.appId;
  const trimmed = typeof configured === 'string' ? configured.trim() : '';
  return trimmed === '' ? null : trimmed;
}

/**
 * How long a body may run before a whole bullet is dropped from the end.
 *
 * Both platforms collapse a notification to roughly two lines and expand on a
 * long press, so this is the point past which a sentence is only read by
 * someone who already cared enough to pull the shade down.
 */
export const PUSH_BODY_CHAR_CAP = 180;

/** Tag keys the app owns. Anything else on the user is somebody else's. */
export const BRIEFING_TAG_KEYS = [
  'briefing_line',
  'briefing_headline',
  'briefing_date',
  'briefing_zone',
  'briefing_events',
  'briefing_due',
  'briefing_overdue',
  'briefing_streak_risk',
  'briefing_quiet',
] as const;

export type BriefingTagKey = (typeof BRIEFING_TAG_KEYS)[number];

/** OneSignal stores every tag as a string; numbers come back as strings too. */
export type BriefingTags = Record<BriefingTagKey, string>;

/**
 * The push body, built out of the card's three bullets.
 *
 * `composeVisual` always returns exactly three so the card has a fixed height,
 * which means an empty day produces "Nothing on your calendar today. Nothing
 * due today. No promises outstanding." — true, and the fastest way to teach
 * somebody to swipe every Ridik notification away unread. Two rules cut it back
 * to something worth reading:
 *
 *   - the schedule bullet always leads, because "do I have to be somewhere" is
 *     the question a glance at a lock screen is asking;
 *   - the other two are dropped when they carry the `clear` icon, which is how
 *     `compose.ts` marks a line that exists only to fill the card.
 *
 * A day with nothing in it is left as one honest sentence, and `briefing_quiet`
 * below is how the dashboard avoids sending it at all.
 *
 * Bullets are kept whole. A title is already truncated by `composeVisual`, so
 * the only way to exceed the cap is a genuinely full day, and dropping its last
 * clause reads better than cutting a sentence in half.
 */
export function briefingPushBody(
  bullets: BriefingBullets,
  cap: number = PUSH_BODY_CHAR_CAP,
): string {
  const [lead, ...rest] = bullets;
  const lines = [lead.text, ...rest.filter((b) => b.icon !== 'clear').map((b) => b.text)];

  let body = lines[0] ?? '';
  for (const line of lines.slice(1)) {
    const next = `${body} ${line}`;
    if (next.length > cap) break;
    body = next;
  }
  return body;
}

/**
 * Everything the dashboard is allowed to know about the day.
 *
 * Counts as well as prose, because the useful half of "smart" is not sending
 * the push at all: `briefing_quiet` is what lets a segment skip the mornings
 * where the honest message is "nothing", and `briefing_streak_risk` is what
 * lets the one push worth interrupting somebody for go out on its own.
 */
export function briefingPushTags(briefing: Briefing): BriefingTags {
  const { data, bullets } = briefing;

  const events = data.events.filter((event) => !event.isBuffer).length;
  const overdue = data.overdueTasks.length;
  const due = data.dueTasks.length + overdue;
  const streakRisk = data.streaksAtRisk.length > 0;

  return {
    briefing_line: briefingPushBody(bullets),
    // The schedule bullet alone: short enough to be a title, and the one line
    // that answers "do I need to be somewhere".
    briefing_headline: bullets[0].text,
    // The local day the line describes, so a stale tag is visible in the
    // dashboard rather than being discovered by a user reading yesterday.
    briefing_date: data.date,
    // Ridik's own zone, which is a setting and can differ from the device's —
    // OneSignal's per-user local-time delivery only knows the device's.
    briefing_zone: data.zone,
    briefing_events: String(events),
    briefing_due: String(due),
    briefing_overdue: String(overdue),
    briefing_streak_risk: streakRisk ? '1' : '0',
    briefing_quiet:
      events === 0 && due === 0 && !streakRisk && data.commitments.length === 0 ? '1' : '0',
  };
}

/** True when re-uploading would tell OneSignal something it does not know. */
export function tagsChanged(previous: BriefingTags | null, next: BriefingTags): boolean {
  if (!previous) return true;
  return BRIEFING_TAG_KEYS.some((key) => previous[key] !== next[key]);
}

/**
 * iOS reports `inactive` on the way into and out of the background, and again
 * for a control-centre pull or an incoming call, so a listener that refreshed
 * on every change would re-read the whole briefing several times per switch.
 */
export const MIN_TAG_REFRESH_INTERVAL_MS = 60_000;

export function dueForRefresh(
  lastAt: number | null,
  at: number,
  minIntervalMs: number = MIN_TAG_REFRESH_INTERVAL_MS,
): boolean {
  if (lastAt === null) return true;
  // A clock that has gone backwards (a manual change, an NTP correction) must
  // not lock refreshing out until it catches up.
  if (at < lastAt) return true;
  return at - lastAt >= minIntervalMs;
}

/**
 * Whether to opt this device into push, given what the OS has already granted.
 *
 * The rule is one line and it is the whole reason this is a named function:
 * **`OneSignal.User.pushSubscription.optIn()` raises the system permission
 * dialog when permission has not been granted.** Calling it on a hunch at
 * startup is exactly the "never ask at launch" failure, and it does not look
 * like a permission request at the call site.
 *
 * When permission *is* already granted the SDK opts in on its own, so this is
 * only ever repairing a device that opted out under an earlier build.
 */
export function shouldOptIn(permissionGranted: boolean, optedIn: boolean): boolean {
  return permissionGranted && !optedIn;
}

/* ------------------------------------------------------------------ href -- */

/**
 * The routes a push is allowed to open. Deny by default: a notification payload
 * is remote input, and `router.navigate` will follow anything it is handed.
 *
 * Kept in step with `app/` by `__tests__/briefingPush.test.ts`, which reads the
 * directory — a new screen is otherwise unreachable from a push and nothing
 * anywhere fails.
 */
export const PUSH_ROUTE_SEGMENTS: readonly string[] = [
  '',
  'activity',
  'briefing',
  'calendar',
  'curriculum',
  'focus',
  'habits',
  // Read-only, and it shows the user their own words. A sender learns nothing
  // by opening it, which is the test every entry on this list has to pass.
  'history',
  'ledger',
  'menu',
  'note',
  'notes',
  'people',
  'person',
  'places',
  'plans',
  'project',
  'projects',
  'settings',
  'tasks',
  'today',
  // The usage ledger. Read-only, it holds counters rather than content, and a
  // sender who opens it learns nothing they did not already send — the same
  // test 'history' passes above.
  'usage',
];

/**
 * Reachable in `app/` and deliberately not from a push.
 *
 * `developer` is the engineering surface behind seven taps on the version row —
 * model override, spend caps, the raw log. It is hidden because every knob on
 * it can make the app worse, and a link somebody can send you is not a way in.
 *
 * `unlock` redeems a web payment: it takes a session id straight off the URL and
 * posts it to the billing backend. That exchange belongs to Stripe's own
 * `success_url` and to nothing else. A push is a message from a server the user
 * did not choose to trust in that moment, and letting one drive a redemption
 * would hand any sender a free attempt at somebody else's checkout session —
 * and, on a stolen link, at their subscription.
 *
 * `consent` is where the user decides whether their words may be sent to a
 * third party. A push is a message from a server they did not choose to trust
 * at that moment, and a message that can open a full-screen "Allow" is the
 * shape of every consent-farming attack there is. The screen is reached from
 * the first run, from Settings, and from the app's own refusal notice — all
 * three of which are the user already looking at Ridik.
 *
 * `backup` writes the entire database to a file and hands it to the share
 * sheet. Every path on it needs a deliberate tap and the restore needs a
 * confirmation as well, so nothing is one tap from leaving the phone — but the
 * screen is *about* the whole database leaving the phone, and there is no
 * reason a message from a server would ever need to open it. Deny by default is
 * the rule; this is what the rule is for.
 *
 * `oauthredirect` is where Google's sign-in browser comes home. It is the same
 * argument as `unlock` and it is the sharper version of it: the URL carries an
 * authorization code, and a route that can be driven by a message is a route
 * somebody else can arrive at with a code of their own. This particular screen
 * reads nothing from the query and would simply bounce — but the reason it is
 * safe today is one line of implementation, and a push must not be the thing
 * standing on it.
 */
export const PUSH_BLOCKED_SEGMENTS: readonly string[] = [
  'backup',
  'consent',
  'developer',
  'oauthredirect',
  'unlock',
];

/**
 * Query parameters a push may not carry, whatever route it names.
 *
 * `speak` is the app's one *verb*. `ridik:///?speak=1` is home with a flag on
 * it, and the flag opens the microphone — it is how a widget, the launcher
 * long-press, the Control Center button and the Quick Settings tile all ask to
 * start listening. A blocked *segment* cannot express that, because the segment
 * is home and home has to stay openable; a briefing that could not open the
 * screen it is about would be the wrong fix.
 *
 * So the flag is refused wherever it appears. A message from a server the user
 * did not choose to trust must not be able to switch their microphone on, and
 * nobody tapping a notification believes they are starting a recording. This
 * was harmless right up until the URL grew a verb — the parameter used to be
 * meaningless on home, which is why it stood in this file's own test as an
 * example of a query string surviving.
 *
 * Spelled here rather than imported from `@/features/voice/speakIntent`: that
 * module is a hook over expo-router and this file is pure by contract. The two
 * spellings are asserted to agree in `speak-intent.test.tsx`.
 */
export const PUSH_BLOCKED_PARAMS: readonly string[] = ['speak'];

const ALLOWED = new Set(PUSH_ROUTE_SEGMENTS);
const BLOCKED = new Set(PUSH_BLOCKED_SEGMENTS);
const BLOCKED_PARAMS = new Set(PUSH_BLOCKED_PARAMS);

/** The app's own scheme, as it appears in a `ridik:///briefing` launch URL. */
const SCHEME = 'ridik://';

/**
 * Where a tapped push should go.
 *
 * Three sources in order: the `href` the dashboard put in the notification's
 * additional data, the launch URL OneSignal itself resolved, and finally the
 * fallback. The fallback is the briefing rather than nothing because the
 * briefing is the only thing Ridik pushes — a message that arrives without a
 * payload is one somebody forgot to fill in, not an invitation to do nothing.
 *
 * Anything that is not one of this app's own routes returns null, and the tap
 * merely opens the app. An `https://` link, a route that no longer exists and
 * `/developer` all take that path.
 */
export function resolvePushHref(
  source: { data?: unknown; url?: unknown },
  fallback: string | null = BRIEFING_HREF,
): string | null {
  const fromData = normaliseHref(readHref(source.data));
  if (fromData) return fromData;

  const fromUrl = normaliseHref(typeof source.url === 'string' ? source.url : null);
  if (fromUrl) return fromUrl;

  // The fallback is ours, not the payload's, so it is trusted — but running it
  // through the same gate means a typo here fails closed too.
  return fallback === null ? null : normaliseHref(fallback);
}

function readHref(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const href = (data as { href?: unknown }).href;
  return typeof href === 'string' ? href : null;
}

/**
 * A raw string to a route this app will actually open, or null.
 *
 * Query strings survive — `/notes?pane=lists&list=Hardware` is a real deep link
 * the app already handles — but the segment they hang off has to be known.
 */
function normaliseHref(raw: string | null): string | null {
  if (raw === null) return null;
  let href = raw.trim();
  if (href === '') return null;

  if (href.toLowerCase().startsWith(SCHEME)) {
    href = href.slice(SCHEME.length);
    // `ridik:///briefing` leaves a leading slash, `ridik://briefing` does not.
    if (!href.startsWith('/')) href = `/${href}`;
  }

  // Anything still carrying a scheme is somewhere else entirely, and `//host`
  // is a protocol-relative URL rather than a path.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null;
  if (!href.startsWith('/')) return null;

  const path = href.split(/[?#]/, 1)[0] ?? '';
  const segment = path.split('/')[1] ?? '';
  if (BLOCKED.has(segment) || !ALLOWED.has(segment)) return null;
  // Refused rather than stripped: a payload that names a verb is either hostile
  // or wrong, and both deserve the same answer as an unknown route — the tap
  // still opens the app, which is where a plain launch lands anyway.
  if (carriesBlockedParam(href)) return null;

  return href;
}

/**
 * Whether a query string mentions a parameter a push may not set.
 *
 * The presence of the name is what is refused, not a particular value: nothing
 * a dashboard sends has any business naming `speak`, and reading `speak=0` as
 * benign would be a gate that can be talked round with an encoding.
 */
function carriesBlockedParam(href: string): boolean {
  const start = href.indexOf('?');
  if (start === -1) return false;

  const query = href.slice(start + 1).split('#', 1)[0] ?? '';
  return query.split('&').some((pair) => BLOCKED_PARAMS.has(decodeKey(pair.split('=', 1)[0] ?? '')));
}

/**
 * A query-string key as the router will read it.
 *
 * Decoded, because `%73peak=1` is `speak=1` to every query parser there is and
 * comparing the raw bytes would be a gate with a documented way past it. A
 * malformed escape throws, and something that cannot be decoded is not a key
 * anybody meant — it is left as it is, where it matches nothing.
 */
function decodeKey(raw: string): string {
  try {
    return decodeURIComponent(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}
