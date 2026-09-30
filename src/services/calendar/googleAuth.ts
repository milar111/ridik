/**
 * Google OAuth2, imperative.
 *
 * `useAuthRequest` is a hook, and the thing that needs a fresh access token
 * most often is a background sync worker with no React tree around it. So the
 * flow is built out of plain functions: the interactive half (`signIn`) is the
 * only part that needs a browser, everything after it is a POST.
 *
 * Tokens live in SecureStore and nowhere else — never in `app_settings`, never
 * in AsyncStorage. Only the account email is mirrored into settings, because
 * the Settings screen has to render something and an email is not a credential.
 */
import * as AuthSession from 'expo-auth-session';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { now } from '@/core/clock';
import { createLogger } from '@/core/logger';
import { err, fail, ok, toAppError, type Result } from '@/core/result';
import { getRepositories } from '@/repositories';

import { googleApiError } from './googleApi';

const log = createLogger('google-auth');

/**
 * The narrowest scopes that do everything Ridik actually does.
 *
 * `.../auth/calendar.events` rather than `.../auth/calendar`. Both are
 * "sensitive" and both need Google's review to leave Testing, so this costs
 * nothing procedurally — but the wider one's own description, shown to every user
 * on the consent screen and to every reviewer, is *"See, edit, share, and
 * permanently delete all the calendars you can access using Google Calendar"*.
 * The narrow one grants events on existing calendars and nothing else: no
 * creating or deleting calendars, no sharing, no altering ACLs.
 *
 * Ridik only ever reads and writes *events* — `googleApi.ts` touches
 * `/calendars/{id}/events` and the calendar list, never a calendar's own
 * settings, sharing or lifecycle. So the wider scope was asking for powers the
 * app has no code to use, which is the single most common reason a sensitive-scope
 * review comes back rejected.
 *
 * Kept as a list rather than a constant string because the review submission has
 * to justify each one separately.
 */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  /*
   * And the calendar *list*, read-only, because `calendar.events` does not cover
   * it. `googleApi.ts` calls `users/me/calendarList` to find which calendars
   * exist before it can sync events into one — narrowing to events alone would
   * have made that 403 and broken setup, which is the failure mode a scope
   * reduction invites. Google classifies this one as **non-sensitive**, so
   * `calendar.events` is the only scope the review has to be argued for.
   */
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'openid',
  'email',
] as const;

export const GOOGLE_DISCOVERY = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
  userInfoEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
} as const;

const SESSION_KEY = 'ridik.google.session';
/** Refresh this far ahead of expiry so a request never starts on a dead token. */
export const TOKEN_EXPIRY_SKEW_MS = 60_000;
/** Google's default when the response omits `expires_in`. */
const FALLBACK_LIFETIME_MS = 3_600_000;

const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  // The sync worker runs while the phone is locked; WHEN_UNLOCKED would make
  // every background pass fail with an unreadable keychain item.
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

export type GoogleSession = {
  accessToken: string;
  /** Absent when Google withheld one (a re-consent without `prompt=consent`). */
  refreshToken: string | null;
  /** UTC epoch ms. */
  expiresAt: number;
  scope: string | null;
  email: string | null;
};

export type GoogleOAuthConfig = {
  iosClientId: string;
  androidClientId: string;
  /**
   * Android, but for a build signed with the debug keystore.
   *
   * An Android OAuth client is bound to exactly ONE SHA-1, and this project is
   * signed by two keys — the Expo template keystore for `assembleDebug`, the
   * upload key in `credentials/` for anything shippable. So a single id cannot
   * cover both builds, and the one that does not match is a sign-in that fails
   * at Google's fingerprint check rather than at anything the app can see.
   *
   * Empty is allowed and falls back to `androidClientId`.
   */
  androidClientIdDebug: string;
  webClientId: string;
};

/* ------------------------------------------------------------------ config -- */

export function googleOAuthConfig(): GoogleOAuthConfig {
  const extra = (Constants.expoConfig?.extra ?? {}) as {
    googleOAuth?: Partial<GoogleOAuthConfig>;
  };
  const configured = extra.googleOAuth ?? {};
  return {
    iosClientId: configured.iosClientId ?? '',
    androidClientId: configured.androidClientId ?? '',
    androidClientIdDebug: configured.androidClientIdDebug ?? '',
    webClientId: configured.webClientId ?? '',
  };
}

/**
 * The client id for this platform and this build, falling back to the web one.
 *
 * The Android branch reads `__DEV__` because the fingerprint Google checks is
 * the one that actually signed the APK, and that differs between a Metro debug
 * build (Expo's template keystore) and anything from `npm run release` (the
 * upload key). Sending the wrong id fails inside Google with a certificate
 * mismatch — the app only ever sees a redirect that does not arrive.
 *
 * iOS needs none of this: its client is bound to a bundle identifier, which
 * does not change between debug and release.
 */
export function activeClientId(config = googleOAuthConfig()): string | null {
  const android = (__DEV__ && config.androidClientIdDebug) || config.androidClientId;
  const platform =
    Platform.OS === 'ios'
      ? config.iosClientId
      : Platform.OS === 'android'
        ? android
        : config.webClientId;
  return platform || config.webClientId || null;
}

export function isConfigured(): boolean {
  return activeClientId() !== null;
}

/**
 * The application id, which is also a URL scheme this app answers to.
 *
 * Read from the embedded manifest rather than hard-coded so a rename cannot
 * leave a redirect pointing at the old identifier — but with the literal as a
 * fallback, because a redirect built from `undefined` fails at the very end of
 * the flow, after the user has already consented.
 */
export function appIdentifier(): string {
  const config = Constants.expoConfig;
  const id =
    Platform.OS === 'ios' ? config?.ios?.bundleIdentifier : config?.android?.package;
  return id || 'ai.dby.ridik';
}

/**
 * Where Google sends the browser back to.
 *
 * Installed-app clients redirect through a custom URI scheme, and the scheme
 * has to be one the OS will actually route to *this* app. There are two Google
 * accepts — the application id and the reversed client id. A scheme the OS
 * has not registered fails at the last hop: Google takes the consent,
 * redirects, and the OS has nowhere to deliver it, with no error and no token.
 *
 * So it is the application id, which is what `expo-auth-session`'s own Google
 * provider defaults to. iOS registers it automatically; Android registers it
 * only because `app.config.ts` lists it in `scheme`, and those two facts are
 * the whole reason this function is one line of policy rather than a guess.
 */
export function redirectUriFor(): string {
  return Platform.OS === 'web'
    ? AuthSession.makeRedirectUri({ scheme: 'ridik', path: 'oauthredirect' })
    : AuthSession.makeRedirectUri({ native: `${appIdentifier()}:/oauthredirect` });
}

/* ----------------------------------------------------------------- storage -- */

let cached: GoogleSession | null | undefined;

async function readSession(): Promise<GoogleSession | null> {
  if (cached !== undefined) return cached;

  let raw: string | null;
  try {
    raw = await SecureStore.getItemAsync(SESSION_KEY, SECURE_STORE_OPTIONS);
  } catch (error) {
    // Deliberately *not* cached. A keychain that was unreadable once — the
    // first background wake after a reboot, a device that has never been
    // unlocked — would otherwise pin the whole process to "no session", which
    // every caller reads as "the user never connected Google": the sync worker
    // would then mark rows synced having pushed them nowhere.
    log.warn('could not read the stored Google session; will retry', error);
    return null;
  }

  try {
    cached = raw ? (JSON.parse(raw) as GoogleSession) : null;
  } catch (error) {
    // Corrupt JSON is permanent, so this one is safe to remember.
    log.warn('the stored Google session is unreadable; treating it as signed out', error);
    cached = null;
  }
  return cached;
}

/**
 * A keychain write that fails leaves the session in memory: the token still
 * works for this process, it just will not survive a restart. It must not throw
 * — `getAccessToken` hands this promise straight back to callers that expect a
 * `Result` and would otherwise get a rejection.
 */
async function writeSession(session: GoogleSession): Promise<void> {
  cached = session;
  try {
    await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session), SECURE_STORE_OPTIONS);
  } catch (error) {
    log.error('could not persist the Google session; it will not survive a restart', error);
  }
}

async function clearSession(): Promise<void> {
  cached = null;
  await SecureStore.deleteItemAsync(SESSION_KEY, SECURE_STORE_OPTIONS).catch(() => {});
}

/** Test/logout hook — drops the in-memory copy without touching the keychain. */
export function resetSessionCache(): void {
  cached = undefined;
}

async function rememberEmail(email: string | null): Promise<void> {
  try {
    await getRepositories().settings.set('googleAccountEmail', email);
  } catch (error) {
    // Display sugar only; a failure here must not fail the sign-in.
    log.warn('could not store the Google account email', error);
  }
}

/* ------------------------------------------------------------------- flows -- */

/**
 * Builds a PKCE authorization request. Exported so a screen can pre-warm the
 * request (it generates a code verifier, which costs a round trip to crypto)
 * before the user taps "Connect".
 */
export async function buildAuthRequest(): Promise<Result<AuthSession.AuthRequest>> {
  const clientId = activeClientId();
  if (!clientId) {
    return fail('unsupported', 'Google sign-in is not configured in this build.');
  }
  try {
    const request = new AuthSession.AuthRequest({
      clientId,
      redirectUri: redirectUriFor(),
      scopes: [...GOOGLE_SCOPES],
      usePKCE: true,
      extraParams: {
        // Without both of these Google returns no refresh token on a repeat
        // consent, and the worker silently loses background access after an hour.
        access_type: 'offline',
        prompt: 'consent',
      },
    });
    await request.makeAuthUrlAsync(GOOGLE_DISCOVERY);
    return ok(request);
  } catch (error) {
    log.error('could not build the auth request', error);
    return err(toAppError(error, 'Could not start Google sign-in.'));
  }
}

export async function signIn(
  options: { request?: AuthSession.AuthRequest } = {},
): Promise<Result<GoogleSession>> {
  const clientId = activeClientId();
  if (!clientId) return fail('unsupported', 'Google sign-in is not configured in this build.');

  const built = options.request ? ok(options.request) : await buildAuthRequest();
  if (!built.ok) return built;
  const request = built.value;

  try {
    const result = await request.promptAsync(GOOGLE_DISCOVERY);
    if (result.type !== 'success') {
      if (result.type === 'error') {
        return fail('permission_denied', result.error?.message ?? 'Google refused the sign-in.');
      }
      return fail('permission_denied', 'Google sign-in was cancelled.');
    }

    const code = result.params.code;
    if (!code) return fail('upstream', 'Google returned no authorization code.');

    const exchanged = await AuthSession.exchangeCodeAsync(
      {
        clientId,
        code,
        redirectUri: request.redirectUri,
        extraParams: request.codeVerifier ? { code_verifier: request.codeVerifier } : {},
      },
      GOOGLE_DISCOVERY,
    );

    const email = await fetchEmail(exchanged.accessToken);
    const session: GoogleSession = {
      accessToken: exchanged.accessToken,
      refreshToken: exchanged.refreshToken ?? null,
      expiresAt: expiryOf(exchanged.issuedAt, exchanged.expiresIn),
      scope: exchanged.scope ?? null,
      email,
    };
    await writeSession(session);
    await rememberEmail(email);
    log.info('connected to Google', { email });
    return ok(session);
  } catch (error) {
    log.error('google sign-in failed', error);
    return err(toAppError(error, 'Google sign-in failed.'));
  }
}

export async function signOut(): Promise<Result<void>> {
  const session = await readSession();
  const clientId = activeClientId();

  if (session && clientId) {
    // Best effort: a revoke that fails must not leave the user stuck signed in.
    await AuthSession.revokeAsync(
      { clientId, token: session.refreshToken ?? session.accessToken },
      GOOGLE_DISCOVERY,
    ).catch((error: unknown) => log.warn('token revoke failed', error));
  }

  await clearSession();
  try {
    await getRepositories().settings.setMany({ googleAccountEmail: null, googleCalendarId: null });
  } catch (error) {
    log.warn('could not clear the stored Google account', error);
  }
  return ok(undefined);
}

export async function isSignedIn(): Promise<boolean> {
  const session = await readSession();
  return session !== null;
}

export async function getAccountEmail(): Promise<string | null> {
  return (await readSession())?.email ?? null;
}

/* ----------------------------------------------------------------- refresh -- */

let inFlightRefresh: Promise<Result<string>> | null = null;

/**
 * A valid access token, refreshing when the current one expires within a
 * minute.
 *
 * Every queued sync entry asks for a token, so without the shared promise a
 * drained outbox would fire twenty simultaneous refreshes — and Google
 * invalidates the previous access token on each one, so most of them would
 * come back holding a token that was already dead.
 */
export async function getAccessToken(): Promise<Result<string>> {
  const session = await readSession();
  if (!session) {
    return fail('permission_denied', 'Connect your Google account in Settings to sync your calendar.');
  }
  if (session.expiresAt - TOKEN_EXPIRY_SKEW_MS > now()) return ok(session.accessToken);

  if (!inFlightRefresh) {
    // Every sync entry awaits this promise; one of them getting a rejection
    // instead of an `Err` would escape the worker's per-entry guard.
    inFlightRefresh = refreshSession(session)
      .catch((error: unknown) => err(toAppError(error, 'Could not refresh your Google session.')))
      .finally(() => {
        inFlightRefresh = null;
      });
  }
  return inFlightRefresh;
}

async function refreshSession(session: GoogleSession): Promise<Result<string>> {
  const clientId = activeClientId();
  if (!clientId) return fail('unsupported', 'Google sign-in is not configured in this build.');
  if (!session.refreshToken) {
    await clearSession();
    return fail('permission_denied', 'Your Google session expired. Reconnect it in Settings.');
  }

  let response: Response;
  try {
    response = await fetch(GOOGLE_DISCOVERY.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        refresh_token: session.refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
  } catch (error) {
    return err(googleApiError('offline', { cause: error }));
  }

  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    scope?: string;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok) {
    // The grant is dead — revoked, password changed, or six months idle. No
    // amount of retrying fixes it, so drop the session and make the UI ask.
    if (body.error === 'invalid_grant') {
      await clearSession();
      await rememberEmail(null);
      log.warn('google refresh token rejected; session cleared');
      return fail('permission_denied', 'Your Google session expired. Reconnect it in Settings.', {
        details: { reason: 'invalid_grant' },
      });
    }
    return err(
      googleApiError(response.status === 429 ? 'rate_limited' : response.status >= 500 ? 'server' : 'unauthorized', {
        status: response.status,
        detail: body.error_description ?? body.error,
      }),
    );
  }

  if (!body.access_token) {
    return err(googleApiError('unknown', { detail: 'Google returned no access token.' }));
  }

  const refreshed: GoogleSession = {
    ...session,
    accessToken: body.access_token,
    // Google only re-issues a refresh token when rotation is enabled.
    refreshToken: body.refresh_token ?? session.refreshToken,
    expiresAt: now() + (body.expires_in ? body.expires_in * 1000 : FALLBACK_LIFETIME_MS),
    scope: body.scope ?? session.scope,
  };
  await writeSession(refreshed);
  return ok(refreshed.accessToken);
}

/* ------------------------------------------------------------------ helpers -- */

function expiryOf(issuedAtSeconds: number | undefined, expiresIn: number | undefined): number {
  const issuedAt = issuedAtSeconds !== undefined ? issuedAtSeconds * 1000 : now();
  return issuedAt + (expiresIn ? expiresIn * 1000 : FALLBACK_LIFETIME_MS);
}

async function fetchEmail(accessToken: string): Promise<string | null> {
  try {
    const info = await AuthSession.fetchUserInfoAsync({ accessToken }, GOOGLE_DISCOVERY);
    const email = info.email;
    return typeof email === 'string' ? email : null;
  } catch (error) {
    log.warn('could not read the Google account email', error);
    return null;
  }
}
