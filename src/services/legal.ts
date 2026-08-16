/**
 * The two links a subscription screen is required to carry.
 *
 * Apple's Developer Program Licence Agreement, Schedule 2 §3.8(b), requires an
 * auto-renewing subscription to be sold beside functional links to a privacy
 * policy and to the terms it is sold under. Review enforces it: a paywall
 * without both is a routine 3.1.2 rejection, and it is one of the cheapest
 * rejections to avoid and the easiest to forget, because the links live in
 * Settings where a developer sees them daily and a buyer never does.
 *
 * ## Why there is a fallback for terms and not for privacy
 *
 * Apple publishes a standard EULA and explicitly allows an app to be sold under
 * it. So a build with no terms URL is still compliant, and pointing at Apple's
 * own document is better than rendering a row that opens nothing — the failure
 * mode this replaces is an inert link, which reviewers do tap.
 *
 * A privacy policy has no such fallback. Nobody else can host a truthful
 * statement of what *this* app collects, and a link to a generic one would be a
 * false disclosure rather than a missing one. So when it is unset the paywall
 * says so plainly instead of pretending, and `releaseBlockers()` reports it —
 * a store build without a privacy policy is not shippable and should fail
 * before somebody spends twenty minutes discovering it at upload.
 */
import Constants from 'expo-constants';
import { Platform } from 'react-native';

/** Apple's standard EULA. Allowed as the terms an app is sold under. */
export const APPLE_STANDARD_EULA =
  'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';

type LegalConfig = { privacy?: string; terms?: string };

function configured(): LegalConfig {
  const extra = (Constants.expoConfig?.extra ?? {}) as { legal?: LegalConfig };
  return extra.legal ?? {};
}

function trimmed(value: string | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

/** The privacy policy, or null when this build has none. Never guessed at. */
export function privacyPolicyUrl(): string | null {
  return trimmed(configured().privacy);
}

/**
 * The terms, falling back to Apple's standard EULA on iOS.
 *
 * Only on iOS: the fallback is a document Apple publishes for apps sold through
 * *their* store, and offering it to a Play buyer would be pointing them at
 * somebody else's agreement about somebody else's storefront.
 */
export function termsUrl(): string | null {
  return trimmed(configured().terms) ?? (Platform.OS === 'ios' ? APPLE_STANDARD_EULA : null);
}

/**
 * What is missing before this build may be sold, in the words the operator
 * needs. Empty means nothing is blocking.
 *
 * Read by the release script rather than by a screen: the app degrades
 * gracefully in every one of these cases, and it is the person about to upload
 * who needs to be stopped.
 */
export function legalBlockers(): string[] {
  const missing: string[] = [];
  if (!privacyPolicyUrl()) {
    missing.push(
      'EXPO_PUBLIC_PRIVACY_URL is unset. Both stores require a reachable privacy policy, ' +
        'and the paywall has to link to it.',
    );
  }
  if (!trimmed(configured().terms)) {
    missing.push(
      'EXPO_PUBLIC_TERMS_URL is unset. iOS falls back to Apple’s standard EULA; ' +
        'Google Play has no equivalent fallback and needs a real one.',
    );
  }
  return missing;
}
