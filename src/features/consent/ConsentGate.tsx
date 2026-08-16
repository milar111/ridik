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
 */
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';

import { useSetting } from '@/hooks/useSettings';
import { FADE } from '@/ui/motion';
import { useTheme } from '@/ui/ThemeProvider';

import { ConsentScreen } from './ConsentScreen';

export function ConsentGate() {
  const { colors } = useTheme();
  const consent = useSetting('assistantConsent');
  const reduced = useReducedMotion();

  // Nothing until the row has actually been read. `useSetting` reports the
  // declared default — `unset` — while the query is in flight, which is the
  // right answer for a switch and precisely the wrong one here: it would put a
  // full-screen consent sheet over the home screen of every launch for as long
  // as SQLite took to answer, on every install that had already answered.
  if (consent.isLoading || consent.value !== 'unset') return null;

  return (
    <Animated.View
      testID="consent-gate"
      // Absolute over the navigator, not instead of it. Everything below is
      // mounted, routed and correct; this is a lid.
      style={[styles.overlay, { backgroundColor: colors.bg }]}
      entering={reduced ? undefined : FadeIn.duration(FADE.duration)}
      // A View with no responder lets touches fall through to whatever is
      // underneath it, which here is the microphone. Claiming the start of any
      // gesture no child wanted is what makes this a lid rather than a picture
      // of one; children negotiate first, so the buttons and the scroll still
      // work.
      onStartShouldSetResponder={() => true}
    >
      <View style={styles.fill}>
        <ConsentScreen />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  fill: { flex: 1 },
});
