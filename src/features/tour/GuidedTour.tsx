/**
 * The tour, drawn over the real app while it walks through it.
 *
 * Not a slideshow, and the distinction is the whole feature. The same facts
 * were once panels in the welcome flow, where nothing on the screen is real and
 * what a person learns is the shape of an onboarding deck. Here the ring is
 * around the actual microphone, and when the tour says "this is where your
 * spending goes" it has *opened the Money screen* to say it — because a voice
 * app has no menu, and somebody who has never seen that screen will never guess
 * that the microphone takes money.
 *
 * Four things this has to keep:
 *
 *  - **It must not run before there is anything to point at.** `enabled` is the
 *    caller's answer — home passes it once the disclosure is answered and the
 *    day has loaded, because a tour drawn under `ConsentGate` is one nobody
 *    sees that marks itself as seen.
 *  - **Every step shows something.** A step that lands on an empty Habits
 *    screen and says "this is where habits go" has taught nothing. `sample` on
 *    the step is a *faked* two or three lines of what the screen looks like
 *    once it has been used, animated in under the sentence. It is drawn in the
 *    card and written nowhere.
 *  - **The way out is on home only.** Leaving the tour from the middle of a
 *    walk through eight screens would strand somebody on the Places screen with
 *    no idea how they got there, so the close is offered while the tour is
 *    still at home and the walk ends by coming back.
 *  - **It must not be silent to a screen reader.** The spotlight is a *shape*,
 *    so a person who cannot see it gets nothing from it. The card is a live
 *    region and each step is announced.
 */
import { useCallback, useEffect, useState } from 'react';
import { Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeIn, FadeInDown, FadeOut, useReducedMotion } from 'react-native-reanimated';
import { usePathname, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useSetting } from '@/hooks/useSettings';
import { useAnnounceOnIOS } from '@/ui/a11y';
import { Button, Txt } from '@/ui/components';
import { useTheme } from '@/ui/ThemeProvider';

import { RING_PAD, Spotlight } from './Spotlight';
import { TOUR_STEPS, type TourStep } from './steps';
import { useTourFrames, type TourFrame } from './TourContext';

/** Between the ring and the card, so the two read as one object with a gap. */
const CARD_GAP = 14;

export function GuidedTour({ enabled }: { enabled: boolean }) {
  const insets = useSafeAreaInsets();
  const screen = useWindowDimensions();
  const frames = useTourFrames();
  const seen = useSetting('tourSeen');
  const router = useRouter();
  const pathname = usePathname();
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);

  /*
   * Not while the row is still being read. `useSetting` reports the declared
   * default — `false` — until SQLite answers, which here means "never seen", so
   * without this the tour flashes over the first frame of every launch on every
   * install that has already walked it. `ConsentGate` has the same guard for
   * the same reason.
   */
  /*
   * Two facts, not one, and the local one is what closes the tour.
   *
   * `seen.set(true)` is a mutation: it writes SQLite and updates a query cache,
   * and until one of those lands `seen.value` is still `false`. Ending the tour
   * on that alone left the card on screen for as long as the round trip took —
   * and because `finish` also puts the index back to zero, what the user saw
   * was the tour *restarting from step one* after they pressed Got it. The
   * setting is persistence; `done` is the dismissal.
   */
  const [done, setDone] = useState(false);
  const active = enabled && !done && !seen.isLoading && seen.value === false;
  const step: TourStep | undefined = TOUR_STEPS[index];

  const finish = useCallback(() => {
    setDone(true);
    seen.set(true);
    // Never leave somebody on the Places screen wondering how they got there.
    if (router.canGoBack()) router.dismissAll();
  }, [router, seen]);

  /*
   * The walk, and it goes **straight to the screen**.
   *
   * It went through `/menu` for a while, on the reasoning that somebody shown
   * nine screens learns nothing about how to reach them. True, and it was still
   * the wrong trade: the menu is a presented sheet, so every hop was a sheet
   * rising, a row lighting, a press, the sheet falling and then the screen —
   * five moves and about three seconds to say one sentence about Habits. Nine
   * of those is a tour nobody finishes. The last step names the menu and the
   * fourth step rings it on home, which is where somebody actually looks for
   * it; the walk itself just goes.
   *
   * Home is the hinge: pushed from home, replaced between screens, dismissed
   * back to home at the end. One frame for home and one for whatever is being
   * looked at, however many screens it visits.
   */
  useEffect(() => {
    if (!active || !step || pathname === step.route) return;

    if (step.route === '/') {
      /*
       * `dismissAll` alone is not enough to get home: it is a no-op on a stack
       * with nothing under it, and that is exactly what "Show me around" is
       * pressed on when `/examples` was opened cold. The tour then sat on the
       * examples list with no card and no way forward.
       */
      if (router.canGoBack()) router.dismissAll();
      else router.replace('/' as never);
      return;
    }

    if (pathname === '/') router.push(step.route as never);
    else router.replace(step.route as never);
  }, [active, step, pathname, router]);

  // Drawn only once the screen it is about is actually on top, or the card
  // rides over the outgoing screen for the length of a push animation.
  const arrived = Boolean(step && pathname === step.route);
  /*
   * Somewhere the walk actually goes: the screen this step is about, or home,
   * which every hop starts and ends on. Anywhere else the tour has only just
   * been switched on and is still on its way to step one — and dimming a screen
   * it is merely leaving reads as a freeze.
   */
  const onWalk = arrived || pathname === '/';

  /*
   * On the menu the subject is the row this step is heading for; everywhere
   * else it is whatever the step named.
   */
  const frame = step?.target ? frames[step.target] : undefined;
  /*
   * "Nothing to ring by design" and "there is nothing to ring *yet*" are
   * different steps and must not be drawn the same way.
   *
   * A screen step — "this is the Money screen" — softens the scrim on purpose,
   * because its whole job is to let somebody look at the screen behind it. A
   * step that *names* a control is about that control, and on a fresh install
   * one of them is missing: there is no receipt until something has been said.
   * Softening there dimmed nothing anybody was meant to look at and left a card
   * floating over a live, undimmed home screen with no indication of why. The
   * card is the subject in that case, so the scrim stays at full strength.
   *
   *
   * And it is `arrived`, not just the step: softening starts the moment the
   * index moves, which is *before* the menu opens — so the scrim lifted off
   * home for the quarter second between the card leaving and the sheet
   * arriving, and the dimming visibly went away and came back on every hop. A
   * step's own lighting belongs to the screen it is about, once that screen is
   * there.
   */
  const soft = Boolean(arrived && step && !step.target);
  /*
   * "Nothing to ring by design" and "the thing is not on screen" are different
   * steps and must not be drawn the same way.
   *
   * A screen step — "this is the Money screen" — softens the scrim on purpose,
   * because its whole job is to let somebody look at the screen behind it. A
   * step that *names* a control is about that control, and on a fresh install
   * two of them are missing: there is no receipt until something has been said.
   * Softening there dimmed nothing anybody was meant to look at and left a card
   * floating over a live, undimmed home screen with no indication of why. The
   * card is the subject in that case, so the scrim stays at full strength.
   */

  useAnnounceOnIOS(active && step && arrived ? `${step.title}. ${step.body}` : null);

  if (!active || !step) return null;

  const last = index === TOUR_STEPS.length - 1;

  return (
    <View
      testID="guided-tour"
      style={StyleSheet.absoluteFill}
      // Blocking for the whole walk, not only where the card is: the menu is on
      // screen for a second with a ring travelling across it, and a tap landing
      // on a row then would take the tour somewhere it is not going.
      pointerEvents="auto"
      // The overlay is the only thing on screen while it is up: a tap must not
      // reach the microphone underneath it. Unlike `ConsentGate` this claim is
      // safe on the wrapper — there is no ScrollView below it to silence.
      onStartShouldSetResponder={() => true}
      accessibilityViewIsModal
    >
      {/*
        The dimming never lifts, and that is the whole difference between a
        walk and a slideshow. It used to be drawn only where the card was, so
        every hop flashed the full-brightness app for the length of two screen
        transitions — twice a step, nine steps — which is what made a
        deliberate tour read as a glitch. One scrim, held, with the hole
        travelling from the menu button to the row to whatever the next screen
        is about.
      */}
      {onWalk ? <Spotlight frame={frame} soft={soft} reduced={reduced} /> : null}


      {arrived ? (
        <Card
          key={index}
          step={step}
          index={index}
          frame={frame}
          screen={screen}
          insets={insets}
          reduced={reduced}
          last={last}
          onNext={() => (last ? finish() : setIndex((current) => current + 1))}
        />
      ) : null}
    </View>
  );
}

/* -------------------------------------------------------------------- card -- */

function Card({
  step,
  index,
  frame,
  screen,
  insets,
  reduced,
  last,
  onNext,
}: {
  step: TourStep;
  index: number;
  frame: TourFrame | undefined;
  screen: { width: number; height: number };
  insets: { top: number; bottom: number };
  reduced: boolean;
  last: boolean;
  onNext: () => void;
}) {
  const { colors, radius, spacing } = useTheme();

  /*
   * Above the target or below it, whichever leaves the target visible.
   *
   * Measured against the middle of the screen rather than against the card's
   * own height, which is not known until it has been laid out: a card that
   * flipped sides after its first render would move under the reader's eye.
   */
  const below = frame ? frame.y + frame.height < screen.height / 2 : step.fallback === 'top';
  const anchor = frame
    ? below
      ? { top: frame.y + frame.height + RING_PAD + CARD_GAP }
      : { bottom: screen.height - frame.y + RING_PAD + CARD_GAP }
    : step.fallback === 'top'
      ? { top: insets.top + 96 }
      : { bottom: insets.bottom + 96 };

  return (
    <Animated.View
      testID="guided-tour-card"
      entering={reduced ? undefined : FadeInDown.duration(260)}
      // It has to leave, not vanish. The card is unmounted the moment the walk
      // starts moving — nine times over — and a card that blinks out is the
      // other half of what made this read as a glitch rather than a tour.
      exiting={reduced ? undefined : FadeOut.duration(160)}
      // Android's own mechanism; iOS has none and is answered by the announce
      // in the parent. Both together is how a sentence gets read out twice.
      accessibilityLiveRegion={Platform.OS === 'android' ? 'polite' : 'none'}
      style={[
        styles.abs,
        anchor,
        {
          left: spacing.lg,
          right: spacing.lg,
          backgroundColor: colors.surface,
          borderRadius: radius.md,
          padding: spacing.lg,
          gap: 6,
        },
      ]}
    >
      <Txt variant="heading">{step.title}</Txt>
      <Txt variant="body" tone="secondary">
        {step.body}
      </Txt>

      {step.sample ? <Sample sample={step.sample} reduced={reduced} /> : null}

      <View style={[styles.footer, { marginTop: spacing.sm }]}>
        <Txt variant="micro" tone="tertiary">
          {index + 1} of {TOUR_STEPS.length}
        </Txt>
        <Button
          testID="guided-tour-next"
          label={last ? 'Got it' : 'Next'}
          variant="primary"
          size="sm"
          onPress={onNext}
        />
      </View>
    </Animated.View>
  );
}

/**
 * What the screen behind this card looks like once it has been used.
 *
 * Faked, and that is the point: a tour that opens an empty Habits screen and
 * says "this is where your habits go" has shown nothing at all. Nothing here is
 * written anywhere, nothing is read from the database, and it cannot mix with
 * real rows — it is a picture of the app, drawn inside the card that is
 * describing it.
 *
 * The quoted line is what you would *say*; the rest is what comes back. They
 * arrive in order, at reading speed, so the second half reads as a consequence
 * of the first rather than as a list that was always there.
 */
function Sample({
  sample,
  reduced,
}: {
  sample: { say?: string; lines: string[] };
  reduced: boolean;
}) {
  const { colors, radius, spacing } = useTheme();
  const at = (n: number) => (reduced ? undefined : FadeIn.duration(220).delay(180 + n * 220));

  return (
    <View
      // One picture, not a list of strings: a screen reader that walked these
      // separately would read a mocked-up receipt as though it had happened.
      accessible
      accessibilityLabel={`For example: ${sample.say ? `say ${sample.say}. ` : ''}${sample.lines.join(', ')}`}
      style={{
        marginTop: spacing.xs,
        padding: spacing.md,
        gap: 6,
        borderRadius: radius.sm,
        backgroundColor: colors.surfaceSunken,
      }}
    >
      {sample.say ? (
        <Animated.View entering={at(0)} style={styles.sayRow}>
          <Ionicons name="mic" size={12} color={colors.accent} style={styles.mic} />
          <Txt variant="caption" tone="accent" style={{ flex: 1 }}>
            “{sample.say}”
          </Txt>
        </Animated.View>
      ) : null}
      {sample.lines.map((line, i) => (
        <Animated.View key={line} entering={at(i + (sample.say ? 1 : 0))}>
          <Txt variant="caption" tone={i === 0 ? 'primary' : 'tertiary'}>
            {line}
          </Txt>
        </Animated.View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  abs: { position: 'absolute' },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sayRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  // Nudged onto the first line's optical centre rather than its box top.
  mic: { marginTop: 3 },
});
