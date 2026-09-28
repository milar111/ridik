/**
 * The first run, as an overlay over the navigator rather than in front of it.
 *
 * `app/_layout.tsx` has one hard rule: the `Stack` mounts on the very first
 * render. expo-router resolves the initial URL against whatever tree exists at
 * that moment, so anything that gates the navigator — an async bootstrap, a
 * settings read, a consent check — leaves a cold start from a notification or a
 * deep link on "Unmatched Route". The startup spinner and the failure screen
 * are both drawn this way for exactly that reason, and this is a third of the
 * same kind: the navigator is always mounted and always correct underneath, and
 * what a person sees on their first launch is painted over the top of it.
 *
 * That is also why this is not a redirect from `app/index.tsx`. Home is one of
 * a dozen routes a launch can land on — a reminder opens `/tasks`, a place
 * reminder opens `/places`, the widget opens `/today` — and a first-run gate
 * that only guards the front door is not a gate. Drawn from the layout, it
 * covers every one of them without any of them knowing.
 *
 * It shows for exactly one reason: nobody has answered yet. A person who
 * declined has answered, and must never see this again — the route at
 * `/consent` is where they go if they change their mind.
 *
 * What it draws is `WelcomeFlow`, which *ends* with the same `ConsentScreen`
 * this file used to show directly. The gate condition is unchanged and so is
 * the thing that closes it: answering the disclosure. The welcome and the
 * permission asks are steps in front of that, not a second gate with its own
 * flag — an install that got halfway through the tour and was killed comes back
 * to the start of it rather than to a half-onboarded state nothing can describe.
 */
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';

import { useSetting } from '@/hooks/useSettings';
import { FADE } from '@/ui/motion';
import { useTheme } from '@/ui/ThemeProvider';

import { WelcomeFlow } from '@/features/onboarding';

/**
 * Whether the lid is up.
 *
 * Exported because a lid that only stops fingers is not a lid. The overlay
 * covers the navigator visually and claims its touches, but a screen reader
 * walks the view tree rather than the screen: with VoiceOver or TalkBack on,
 * every control underneath — the microphone included — is still reachable by
 * swipe, which makes the one screen that cannot be skipped skippable by the
 * users least able to notice they had skipped it. iOS is answered by
 * `accessibilityViewIsModal` below; Android has no such prop, and the only
 * answer there is for the tree underneath to hide itself, which is what
 * `app/_layout.tsx` does with this.
 */
export function useConsentGateOpen(): boolean {
  const consent = useSetting('assistantConsent');
  // Not while the row is still being read: see the note in `ConsentGate`.
  return !consent.isLoading && consent.value === 'unset';
}

export function ConsentGate() {
  const { colors } = useTheme();
  const open = useConsentGateOpen();
  const reduced = useReducedMotion();

  // Nothing until the row has actually been read. `useSetting` reports the
  // declared default — `unset` — while the query is in flight, which is the
  // right answer for a switch and precisely the wrong one here: it would put a
  // full-screen consent sheet over the home screen of every launch for as long
  // as SQLite took to answer, on every install that had already answered.
  if (!open) return null;

  return (
    <Animated.View
      testID="consent-gate"
      // Absolute over the navigator, not instead of it. Everything below is
      // mounted, routed and correct; this is a lid.
      style={[styles.overlay, { backgroundColor: colors.bg }]}
      entering={reduced ? undefined : FadeIn.duration(FADE.duration)}
      // The screen-reader half of the same lid: VoiceOver stops at this view
      // and does not walk on into the app underneath it. There is no Android
      // equivalent to set here — `app/_layout.tsx` hides the tree below
      // instead, which is why `useConsentGateOpen` is exported.
      accessibilityViewIsModal
    >
      {/*
        The floor of the lid, and it is a *sibling* of the flow rather than its
        parent — which is the whole point.

        A View with no responder lets touches fall through to whatever is
        underneath, which here is the microphone, so something in this overlay
        has to claim the start of any gesture no child wanted. It used to be
        the wrapper above, and that quietly broke the one step that scrolls: a
        ScrollView deliberately does *not* claim on touch-start (or a tap on a
        button inside it would never land) — it takes over on the first *move*.
        An ancestor that has already become the responder never gives it back,
        so the examples step could not be scrolled at all. Two of nine cards,
        no error, and every test green, because a renderer with no viewport has
        nothing to overflow.

        Behind the flow it still catches anything the flow does not want, and
        it is no longer between the ScrollView and the finger.
      */}
      <View style={StyleSheet.absoluteFill} onStartShouldSetResponder={() => true} />
      <View style={styles.fill}>
        <WelcomeFlow />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  fill: { flex: 1 },
});
