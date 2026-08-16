/**
 * Saying out loud what the app has just drawn.
 *
 * Ridik is safe because it *shows* you what it did: the receipt names the
 * action, the review gate previews a write before it lands, and undo sits on
 * the receipt. Every one of those is a card that springs up silently — which
 * means that with VoiceOver or TalkBack switched on the whole safety model is
 * missing rather than degraded. A screen reader does not read a view because it
 * appeared; it reads what has focus, and focus does not move.
 *
 * There are two mechanisms for that and they belong to different platforms:
 *
 *  - **Android: `accessibilityLiveRegion`.** Put it on the element whose own
 *    words are the news, and TalkBack speaks them when they change. This is the
 *    mechanism Android wants — `View.announceForAccessibility` is discouraged
 *    from API 34 and can simply be dropped.
 *  - **iOS: an announcement.** `accessibilityLiveRegion` is not a thing UIKit
 *    has; RN accepts the prop and ignores it. `announceForAccessibility` is the
 *    equivalent, and it is a call rather than a prop — hence a hook.
 *
 * So a surface that needs to speak carries the prop *and* calls
 * `useAnnounceOnIOS` with the same sentence. Doing both on both platforms is
 * the one mistake to avoid: Android would say it twice, once for the region and
 * once for the announcement, which is worse than saying it once badly.
 *
 * `useAnnounce` is the other half of the rule, for state that no element's text
 * carries verbatim — the mic's caption becomes the partial transcript while you
 * speak, so a live region on it would interrupt TalkBack on every syllable.
 * There the announcement is the only mechanism, and it is made on both.
 */
import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

/**
 * Speak `message` once, on both platforms, whenever it changes.
 *
 * Empty resets the memory rather than being ignored, so the *same* sentence
 * arriving twice in a row — two identical receipts, "Listening" after a turn
 * that ended back at "Listening" — is said both times. Deduping on the string
 * alone would swallow the second one, and the second one is the one that says
 * the app heard you.
 *
 * A no-op when no screen reader is running: both platforms drop the
 * notification, so there is nothing to gate on and no round trip to make.
 */
export function useAnnounce(message: string | null | undefined): void {
  const said = useRef<string | null>(null);

  useEffect(() => {
    const text = message?.trim() ?? '';
    if (!text) {
      said.current = null;
      return;
    }
    if (text === said.current) return;
    said.current = text;
    AccessibilityInfo.announceForAccessibility(text);
  }, [message]);
}

/**
 * The iOS half of a live region.
 *
 * Pair it with `accessibilityLiveRegion` on the element that carries the same
 * words. Android is deliberately silent here — the region has already spoken,
 * and this would be the second time.
 */
export function useAnnounceOnIOS(message: string | null | undefined): void {
  useAnnounce(Platform.OS === 'android' ? null : message);
}
