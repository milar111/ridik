/**
 * The way back to something that was said and never landed.
 *
 * The counterpart to `LastAction`: that one says what the assistant *did*, this
 * one says what it failed to do and still has. Both exist for the same reason —
 * on a voice-first screen a turn that fails silently is a turn the user finds
 * out about days later, except this failure costs them the words as well.
 *
 * Deliberately not a toast. A toast is gone in four seconds and this has to
 * survive being ignored: the user is mid-corridor, the model timed out, and the
 * paragraph they dictated has to still be there when they get somewhere they
 * can look at a screen. It leaves only when they take it back or throw it away.
 */
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/ui/ThemeProvider';
import { Txt } from '@/ui/components/Text';
import { Button } from '@/ui/components/Button';
import { elevate } from '@/ui/shadow';
import { useVoiceStore } from './store';

/**
 * `width` is for the floating dock, whose container is anchored to the right
 * edge and therefore sizes itself to its content — a card left to do that would
 * be as wide as the longest word in the transcript.
 */
export function UnsentTranscript({ maxWidth }: { maxWidth?: number }) {
  const { colors, radius, spacing } = useTheme();
  const recovered = useVoiceStore((s) => s.recovered);
  const recover = useVoiceStore((s) => s.recoverTranscript);
  const discard = useVoiceStore((s) => s.discardRecovered);

  if (!recovered) return null;

  return (
    <View
      testID="unsent-transcript"
      // Assertive rather than polite: the words are the thing at risk, and a
      // screen reader that mentions them after everything else on the screen
      // has been read is one the user has already navigated away from.
      accessibilityLiveRegion="assertive"
      style={{
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        padding: spacing.md,
        gap: 6,
        ...(maxWidth ? { width: maxWidth } : {}),
        ...elevate('card'),
      }}
    >
      <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' }}>
        <Ionicons name="archive-outline" size={17} color={colors.warning} />
        {/* `flex: 1` and never its own content: Android measures a text inside
            a flex row short and clips it rather than wrapping it. */}
        <View style={{ flex: 1, gap: 2 }}>
          <Txt variant="micro" tone="warning" weight="600">
            {recovered.reason === 'failed'
              ? 'NOT SENT — KEPT'
              : recovered.reason === 'unanswered'
                ? 'NOT ANSWERED — KEPT'
                : 'UNSENT — KEPT'}
          </Txt>
          <Txt variant="caption" numberOfLines={3}>
            {recovered.text}
          </Txt>
        </View>
      </View>

      <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
        <Button
          label="Put it back"
          size="sm"
          variant="primary"
          icon="arrow-undo-outline"
          onPress={() => recover()}
        />
        <Button label="Discard" size="sm" variant="ghost" onPress={discard} />
      </View>
    </View>
  );
}
