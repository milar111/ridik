/**
 * Home: a microphone, lit from behind by the thing it does.
 *
 * The whole app used to be five tabs and a floating button. It is one screen
 * now — you talk, and you see what that did. Everything else is behind the menu
 * in the corner, which is where those screens belong: you go to them to check
 * or correct something, not to start.
 *
 * The layout is fixed, not scrolling, and deliberately so. The mic sits in the
 * same place every time the app opens, and nothing above or below it can push
 * it out from under your thumb.
 */
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

import {
  HomeMic,
  HomePanel,
  LastAction,
  NextUpLine,
  nextUp,
  useDailyBriefing,
} from '@/features/home';
// Imported from the modules rather than `@/features/today`: that barrel pulls
// in every section of the old Today screen, and with them the briefing's
// text-to-speech and the focus runtime. Home needs three pure things from it,
// and should not be loading a speech stack to draw a clock.
import { buildAgenda } from '@/features/today/agenda';
import { SectionBoundary } from '@/features/today/Fallbacks';
import { useNow } from '@/features/today/useNow';
import { useTourTarget } from '@/features/tour';
import { useSpeakIntent } from '@/features/voice/speakIntent';
import { useVoiceStore } from '@/features/voice/store';
// The one component, not the dock: `VoiceDock` hides its whole floating column
// on home, and the offer to restore an unsent transcript has to survive that.
import { UnsentTranscript } from '@/features/voice/Unsent';
import { useSetting, useToday } from '@/hooks';
// The pure predicate, not `@/features/consent` — that barrel carries the
// disclosure screen, and home may not pull a HeatField, the billing hooks and
// expo-constants in to answer a yes/no question.
import { hasAnsweredConsent } from '@/llm/consent';
import { HeatField, type HeatState } from '@/ui/HeatField';
import { useTheme } from '@/ui/ThemeProvider';
import { useFontsReady } from '@/ui/fonts';
import { STAGGER_MS } from '@/ui/motion';
import { AnimatedPressable, usePressScale } from '@/ui/motionHooks';
import { useNavigateOnce } from '@/ui/useNavigateOnce';

/**
 * The field answers to the voice session; speaking and thinking look alike.
 *
 * `sending` is `thinking` and must never fall through to the `idle` default:
 * that state covers the couple of seconds between the user finishing and the
 * turn starting, and cooling the field there made the screen go quiet at the
 * exact moment the app had just been handed a sentence — which reads as the
 * words having been dropped.
 */
const FIELD_STATE: Record<string, HeatState> = {
  idle: 'idle',
  listening: 'listening',
  sending: 'thinking',
  thinking: 'thinking',
  speaking: 'thinking',
  error: 'error',
};

/*
 * The tour's provider and overlay are in `app/_layout.tsx`, not here.
 *
 * They lived on this screen while the tour was four steps and all four were on
 * it. The tour now walks the calendar, the lists, the money screen and five
 * more, and a provider inside home unmounts the moment it navigates off —
 * taking the step it was on with it. What stays here is the *targets*: this
 * screen is the only one with controls worth ringing.
 */
export default function HomeScreen() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavigateOnce();
  const today = useToday();
  const at = useNow();
  const reduced = useReducedMotion();
  const status = useVoiceStore((s) => s.status);
  const fontsReady = useFontsReady();

  // `ridik:///?speak=1` — how a widget, the launcher long-press, a Control
  // Center button or a Quick Settings tile asks for the microphone. Everything
  // that makes that safe to do once (and only once) is in the hook.
  //
  // The consent answer is what orders the two: `ConsentGate` draws its
  // disclosure *over* this screen, which stays mounted and live underneath, so
  // an unwired speak intent would open the microphone behind the lid and make
  // a widget the one way past the one screen that cannot be skipped. Held
  // rather than dropped — the tap fires the moment the question is answered.
  //
  // No `isLoading` guard, unlike the gate: `useSetting` reports the declared
  // default while the read is in flight and that default is `unset`, which is
  // the safe end here. The gate needs the guard for the opposite reason — for
  // it, `unset` is the value that draws a lid over every launch.
  const consent = useSetting('assistantConsent');
  const tourSeen = useSetting('tourSeen');
  useSpeakIntent({ consentAnswered: hasAnsweredConsent(consent.value) });

  const menuTarget = useTourTarget('menu');
  const nextUpTarget = useTourTarget('next-up');
  const receiptTarget = useTourTarget('receipt');

  const snapshot = today.data;

  /**
   * Shown once a day, on the first open — it replaced the scheduled
   * notification. Held until the day has loaded: expo-router silently drops a
   * push made before the navigator mounts.
   *
   * And held until consent has been answered, which is not the same guard. The
   * briefing is a `presentation: 'modal'` route, so the navigator presents it
   * in a native view controller ABOVE the React tree — including above the lid
   * `ConsentGate` draws. On a fresh install the two raced and the briefing won:
   * the first thing a new user saw was a day summary, with the screen naming
   * the third party their voice goes to hidden underneath it. Nothing billable
   * happens there — the briefing composes from local data and calls no model —
   * so this is a first-run defect rather than a bypass. It is still the one
   * screen that has to come first, and it is what an app reviewer doing a
   * clean install sees.
   *
   * And it waits for the tour for the same reason one step further on. The
   * briefing is a modal route, so it is presented above `GuidedTour` too: on a
   * fresh install the disclosure was answered and a day summary slid up over
   * the tour that was about to explain what the microphone underneath it was
   * for. `tourSeen` reads `false` while the row is still being read, which is
   * the safe end of that guard — a briefing held for a second is nothing, and
   * a briefing over the tour is the first thing a new user sees.
   */
  useDailyBriefing(
    snapshot != null && hasAnsweredConsent(consent.value) && tourSeen.value === true,
  );

  const next = useMemo(() => {
    if (!snapshot) return null;
    const agenda = buildAgenda({
      events: snapshot.events,
      classes: snapshot.classes,
      window: { start: snapshot.dayStart, end: snapshot.dayEnd },
      now: at,
    });
    return nextUp(agenda, at);
  }, [snapshot, at]);

  // One arrival, ordered the way the eye should travel: corners, then what is
  // next, then the mic. Skipped entirely under reduced motion — a shorter
  // animation is not the accommodation, no animation is.
  const arrive = (index: number) =>
    reduced ? undefined : FadeIn.duration(320).delay(index * STAGGER_MS);

  // See `useFontsReady`: Android caches text measurements, so nothing may be
  // laid out before the faces resolve.
  if (!fontsReady) return <View style={[styles.root, { backgroundColor: colors.bg }]} />;

  return (
    <View style={styles.root}>
      <HeatField state={FIELD_STATE[status] ?? 'idle'} />

      <View
        style={{
          flex: 1,
          paddingTop: insets.top,
          paddingBottom: insets.bottom + spacing.lg,
          paddingHorizontal: spacing.lg,
        }}
      >
        <Animated.View entering={arrive(0)} style={styles.corners}>
          {/* Wrapped rather than measured through `CornerButton`: the wrapper
              has the same box, and this keeps the button ignorant of the tour. */}
          <View {...menuTarget}>
            <CornerButton
              icon="menu"
              label="Menu"
              testID="home-menu"
              onPress={() => nav.push('/menu')}
            />
          </View>
          <CornerButton
            icon="person"
            label="Profile and settings"
            testID="home-profile"
            onPress={() => nav.push('/settings')}
          />
        </Animated.View>

        {/* Only rendered once the day has loaded: a "Nothing left today" that
            turns into a 15:00 meeting a moment later is worse than a blank. */}
        <View style={{ paddingTop: spacing.xl, minHeight: 132 }}>
          {snapshot ? (
            <Animated.View entering={arrive(1)} {...nextUpTarget}>
              <SectionBoundary label="next up">
                <NextUpLine next={next} zone={snapshot.zone} />
              </SectionBoundary>
            </Animated.View>
          ) : null}
        </View>

        <Animated.View entering={arrive(2)} style={styles.stage}>
          <HomeMic />
        </Animated.View>

        {/* What the bottom of this screen can say: the conversation so far,
            what the last utterance did, and what it failed to do and still
            has. In the flow rather than floating, so none of them can land on
            top of another — they are not mutually exclusive, a typed turn can
            fail over a receipt that is still on screen.

            `HomePanel` is above the receipt and has two sides: the
            conversation, which reads downwards into the receipt below it and
            is working from the same ten minutes the model is, and the notes,
            which are what this app mostly produces and were two taps away
            behind the menu. The receipt is outside the panel and is never
            hidden by either side, which is what lets the panel open on
            whichever one is useful. Nothing at all on an install with neither,
            so a first run is still a microphone. */}
        <View style={{ gap: spacing.sm }} {...receiptTarget}>
          <SectionBoundary label="panel">
            <HomePanel />
          </SectionBoundary>
          <SectionBoundary label="unsent">
            <UnsentTranscript />
          </SectionBoundary>
          <SectionBoundary label="last action">
            <LastAction />
          </SectionBoundary>
        </View>
      </View>
    </View>
  );
}

/**
 * The two ways off this screen, as the darkest objects on it after the mic.
 *
 * Filled discs rather than bare glyphs: on a field this saturated an unfilled
 * icon has no ground of its own and its contrast drifts with whatever the
 * gradient is doing underneath it.
 */
function CornerButton({
  icon,
  label,
  testID,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  testID: string;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  // Was a shared value and a `tap()` written out by hand here; `usePressScale`
  // is the same spring with the same 0.9 travel, and it is interruptible for
  // free — a second tap inside the release now carries the current velocity
  // instead of restarting from wherever the first one had got to.
  const press = usePressScale({ scale: 0.9 });

  return (
    <AnimatedPressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...press.handlers}
      onPress={onPress}
      hitSlop={10}
      style={[styles.corner, { backgroundColor: colors.text }, press.style]}
    >
      <Ionicons name={icon} size={19} color={colors.surface} />
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  corners: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  corner: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
