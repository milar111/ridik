/**
 * The last hop of Google sign-in, which is the one nothing can observe failing.
 *
 * An OAuth redirect is delivered by the operating system, not by this app. The
 * browser reaches Google, the user consents, Google redirects to a custom URI
 * scheme — and if nothing has claimed that scheme, the redirect lands nowhere.
 * There is no error, no rejected promise and no cancelled result: the consent
 * really was granted, Google really did record it, and the app simply never
 * hears. Every part of the flow that can be tested passes.
 *
 * That is what shipped: `redirectUriFor()` sent the reversed client id
 * (`com.googleusercontent.apps.…`), which was registered on neither platform.
 *
 * So this file asserts the one thing the flow depends on and no unit test of
 * either file alone can see — that the scheme the code *sends* is a scheme the
 * app *answers to*. It reads both sources, because the two facts live in
 * different files and drift silently.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..', '..', '..');
const auth = readFileSync(join(__dirname, '..', 'googleAuth.ts'), 'utf8');
const config = readFileSync(join(root, 'app.config.ts'), 'utf8');

/** Every custom scheme an Android intent filter claims for this app. */
function androidFilterSchemes(): string[] {
  return [...config.matchAll(/data:\s*\[\{\s*scheme:\s*'([^']+)'/g)].map((m) => m[1] ?? '');
}

/** The application id both native platforms are built under. */
function applicationIds(): string[] {
  return [
    /bundleIdentifier:\s*'([^']+)'/.exec(config)?.[1],
    /package:\s*'([^']+)'/.exec(config)?.[1],
  ].filter((id): id is string => Boolean(id));
}

describe('the scheme Google redirects into', () => {
  /**
   * `Linking.createURL()` builds from `scheme`, and every deep link in this app
   * — widgets, notifications, the speak intent, `ridik:///plans` — is written
   * against `ridik`. It is a single string on purpose: an array would repoint
   * that builder at whatever ended up first.
   */
  it('leaves ridik as the app scheme', () => {
    expect(config).toMatch(/^\s*scheme:\s*'ridik',\s*$/m);
  });

  /**
   * The assertion the bug would have failed.
   *
   * iOS registers the bundle identifier as a URL type by itself, so a redirect
   * built from the application id works there whatever this file says. Android
   * registers only what it is told about, and the intent filter is the telling.
   */
  it('sends a redirect into a scheme android will route', () => {
    expect(auth).toMatch(/native:\s*`\$\{appIdentifier\(\)\}:\/oauthredirect`/);
    const claimed = androidFilterSchemes();
    const androidPackage = /package:\s*'([^']+)'/.exec(config)?.[1];
    expect(androidPackage).toBeTruthy();
    expect(claimed).toContain(androidPackage);
  });

  /**
   * The reversed client id is Google's *other* accepted scheme and it is a
   * reasonable-looking thing to reach for. It is only safe if something
   * registers it, and nothing here does — the ids are environment variables
   * that are empty in most builds, so the scheme cannot be declared statically.
   */
  it('does not reach for the reversed client id, which nothing registers', () => {
    expect(auth).not.toMatch(/com\.googleusercontent\.apps\./);
  });

  /**
   * A redirect built from `undefined` fails at the end of the flow, after the
   * user has consented — the most expensive place to discover a missing value.
   */
  it('falls back to a literal application id rather than building from undefined', () => {
    const fallback = /return id \|\| '([^']+)'/.exec(auth)?.[1];
    expect(applicationIds()).toContain(fallback);
  });
});

/**
 * Which Android client id gets sent, and why there has to be more than one.
 *
 * An Android OAuth client is bound to exactly ONE SHA-1 fingerprint. This
 * project is signed by two different keys — the Expo template keystore at
 * `android/app/debug.keystore` for `assembleDebug`, and the upload key in
 * `credentials/` for everything `npm run release` produces — so one client id
 * cannot possibly serve both builds.
 *
 * The client originally registered was bound to a *third* key: Android Studio's
 * own `~/.android/debug.keystore`, which signs nothing in this repository.
 * Google checks the certificate on its own side, so the app sees only a redirect
 * that never arrives — the same symptom as the scheme bug fixed the same day,
 * from an unrelated cause. Two failures that look identical from inside the app
 * is why this is a test and not a comment.
 */
describe('the android client id and the key that signed the build', () => {
  it('chooses the debug client only in a debug build', () => {
    expect(auth).toMatch(/__DEV__ && config\.androidClientIdDebug/);
  });

  /* The release id is the fallback, so a build with no debug id configured
     still sends something valid rather than nothing. */
  it('falls back to the release client when no debug client is configured', () => {
    expect(auth).toMatch(/\|\|\s*config\.androidClientId\b/);
  });

  /* iOS clients key off the bundle identifier, which is identical in both
     configurations — forking it there would imply a difference that does not
     exist. */
  it('does not fork the ios client, which is bound to a bundle id', () => {
    expect(auth).not.toMatch(/iosClientIdDebug/);
  });

  it('is wired through app.config so both ids actually reach the app', () => {
    expect(config).toMatch(
      /androidClientId:\s*process\.env\.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID\b/,
    );
    expect(config).toMatch(
      /androidClientIdDebug:\s*process\.env\.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID_DEBUG\b/,
    );
  });
});
