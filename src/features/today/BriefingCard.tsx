import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import type { BriefingBullet, BriefingIcon } from '@/features/briefing';
import { useBriefing, useBriefingSpeech } from '@/hooks/useBriefing';
import { useTheme } from '@/ui/ThemeProvider';
import { AnimatedPressable, usePressScale } from '@/ui/motionHooks';
import { Card, Txt } from '@/ui/components';

import { InlineError } from './Fallbacks';

/** Colour is state, so only the bullets that carry one get a tint. */
type BulletStyle = { icon: keyof typeof Ionicons.glyphMap; tone: 'muted' | 'warning' | 'danger' };

const BULLETS: Record<BriefingIcon, BulletStyle> = {
  calendar: { icon: 'calendar-outline', tone: 'muted' },
  travel: { icon: 'walk-outline', tone: 'warning' },
  task: { icon: 'ellipse-outline', tone: 'muted' },
  overdue: { icon: 'alert-circle-outline', tone: 'danger' },
  streak: { icon: 'flame-outline', tone: 'warning' },
  promise: { icon: 'people-outline', tone: 'muted' },
  focus: { icon: 'timer-outline', tone: 'muted' },
  clear: { icon: 'checkmark-circle-outline', tone: 'muted' },
};

/**
 * The spec's three-bullet visual summary: the schedule, the thing due, and the
 * streak or promise it would be expensive to forget.
 *
 * Exactly three lines, each clipped to one — the card is read on the way out of
 * the door, and the whole briefing is one tap away.
 *
 * The bullets, not the whole card, are the link. A `Pressable` is `accessible`
 * by default, which collapses everything inside it into a single VoiceOver
 * element: wrapping the card would have made the speak button unreachable and
 * the bullets unreadable to exactly the users most likely to want them read
 * out. So the speaker sits outside the pressable region, and the region carries
 * the bullets in its own label.
 */
export function BriefingCard() {
  const router = useRouter();
  const { colors } = useTheme();
  const briefing = useBriefing('today');
  const speech = useBriefingSpeech();
  // Both before the error return: an error is a state this card comes back
  // from, and a hook called only on the happy path changes order when it does.
  // The speaker is a bare 19pt glyph with no fill behind it, so the travel has
  // to be larger for the press to register as anything at all.
  const speakPress = usePressScale({ scale: 0.88, disabled: !briefing.data?.bullets });
  const bodyPress = usePressScale({ scale: 0.98 });

  if (briefing.isError) {
    return (
      <InlineError
        message="Your briefing could not be put together."
        onRetry={() => void briefing.refetch()}
        testID="today-briefing-error"
      />
    );
  }

  const bullets = briefing.data?.bullets;

  return (
    <Card>
      <View style={{ gap: 6 }}>
        <View style={styles.head}>
          <Txt variant="eyebrow" tone="tertiary">
            BRIEFING
          </Txt>
          <AnimatedPressable
            accessibilityRole="button"
            accessibilityLabel={
              speech.isSpeaking ? 'Stop reading the briefing' : 'Read the briefing out loud'
            }
            accessibilityState={{ busy: speech.isSpeaking, disabled: !bullets }}
            hitSlop={14}
            disabled={!bullets}
            onPress={() => (speech.isSpeaking ? speech.stop() : speech.play('today'))}
            {...speakPress.handlers}
            style={speakPress.style}
          >
            <Ionicons
              name={speech.isSpeaking ? 'stop-circle' : 'volume-high-outline'}
              size={19}
              color={speech.isSpeaking ? colors.accent : colors.textSecondary}
            />
          </AnimatedPressable>
        </View>

        <AnimatedPressable
          testID="today-briefing"
          accessibilityRole="button"
          accessibilityLabel={
            bullets ? `Your briefing. ${bullets.map((b) => b.text).join(' ')}` : 'Your briefing'
          }
          accessibilityHint="Opens the full briefing"
          onPress={() => router.push('/briefing')}
          {...bodyPress.handlers}
          style={[styles.body, bodyPress.style]}
        >
          {bullets ? (
            bullets.map((bullet, i) => (
              // The tuple is exactly three entries and never reorders, so the
              // position *is* the identity here.
              <BulletRow key={`${i}:${bullet.icon}`} bullet={bullet} />
            ))
          ) : (
            <Txt variant="caption" tone="tertiary" numberOfLines={1}>
              Putting your day together…
            </Txt>
          )}
        </AnimatedPressable>
      </View>
    </Card>
  );
}

function BulletRow({ bullet }: { bullet: BriefingBullet }) {
  const { colors } = useTheme();
  const style = BULLETS[bullet.icon];
  const tint =
    style.tone === 'danger'
      ? colors.danger
      : style.tone === 'warning'
        ? colors.warning
        : colors.textTertiary;

  return (
    <View style={styles.bullet}>
      <Ionicons name={style.icon} size={14} color={tint} style={styles.bulletIcon} />
      <Txt variant="caption" style={{ flex: 1 }} numberOfLines={1}>
        {bullet.text}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 20,
  },
  // Three bullets clear 44 on their own; the placeholder line does not.
  body: { gap: 6, minHeight: 44, justifyContent: 'center' },
  bullet: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  bulletIcon: { marginTop: 2 },
});
