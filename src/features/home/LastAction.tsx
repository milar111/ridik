/**
 * What Ridik just did, on the screen you were already looking at.
 *
 * This is what makes a voice-only home honest. Speaking is fast because you do
 * not have to look — which is exactly why a mis-heard word would otherwise land
 * silently and stay wrong. The receipt is the smallest thing that closes that
 * loop: it names what happened, opens it if you want to check, and takes it
 * back when taking it back is safe.
 */
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, {
  FadeOut,
  useReducedMotion,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/ui/ThemeProvider';
import { Txt } from '@/ui/components/Text';
import { useToast } from '@/ui/components';
import { useVoiceStore } from '@/features/voice/store';
import { useVoiceUndo } from '@/hooks/useVoiceUndo';
import { SPRING_ENTER } from '@/ui/motion';
import { lastUndoable } from './undo';

/**
 * A spring rather than a fade, and from below rather than in place: the card is
 * reporting that something just happened, and only movement says "just".
 */
const SlideInFromBelow = () => {
  'worklet';
  return {
    initialValues: { opacity: 0, transform: [{ translateY: 18 }, { scale: 0.97 }] },
    animations: {
      opacity: withTiming(1, { duration: 200 }),
      transform: [{ translateY: withSpring(0, SPRING_ENTER) }, { scale: withSpring(1, SPRING_ENTER) }],
    },
  };
};

export function LastAction() {
  const { colors, radius, spacing } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const undo = useVoiceUndo();
  const reduced = useReducedMotion();
  const [undone, setUndone] = useState<string | null>(null);

  const outcome = useVoiceStore((s) => s.outcome);
  const open = useVoiceStore((s) => s.open);

  const items = outcome?.items ?? [];
  const applied = items.filter((item) => item.ok);
  if (applied.length === 0) return null;

  const headline = applied[applied.length - 1]!;
  const undoable = lastUndoable(items);
  // Keyed by id: speaking again replaces the outcome, so a stale "Undone" can
  // never sit under a newer action.
  const isUndone = undoable !== null && undone === undoable.id;

  const runUndo = () => {
    if (!undoable) return;
    void undo
      .run(undoable)
      .then(() => {
        setUndone(undoable.id);
        toast.show({ message: 'Undone', tone: 'success' });
      })
      .catch((error: unknown) =>
        toast.show({
          message: error instanceof Error ? error.message : 'That could not be undone.',
          tone: 'danger',
        }),
      );
  };

  return (
    <Animated.View
      // Springs up from below rather than fading in: something arrived, and a
      // fade would read as it having been there all along.
      entering={reduced ? undefined : SlideInFromBelow}
      exiting={reduced ? undefined : FadeOut.duration(160)}
      style={{
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        padding: spacing.md,
        gap: 6,
        shadowColor: '#5A1F00',
        shadowOpacity: 0.1,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 8 },
        elevation: 4,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${headline.summary}. Open it.`}
        // No href is not a dead tap: the sheet still holds the full result, and
        // the rest of what a multi-part sentence did lives there too.
        onPress={() => (headline.href ? router.push(headline.href as never) : open())}
        style={({ pressed }) => [
          { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', opacity: pressed ? 0.6 : 1 },
        ]}
      >
        <Ionicons
          name={isUndone ? 'arrow-undo' : 'checkmark-circle'}
          size={17}
          color={isUndone ? colors.textTertiary : colors.success}
        />
        <View style={{ flex: 1, gap: 1 }}>
          <Txt variant="caption" weight="600" numberOfLines={2} tone={isUndone ? 'tertiary' : undefined}>
            {headline.summary}
          </Txt>
          {applied.length > 1 ? (
            <Txt variant="micro" tone="tertiary">
              and {applied.length - 1} more
            </Txt>
          ) : null}
        </View>
        <Ionicons name="chevron-forward" size={14} color={colors.textTertiary} />
      </Pressable>

      {undoable && !isUndone ? (
        <Pressable
          testID="last-action-undo"
          accessibilityRole="button"
          accessibilityLabel={`Undo ${undoable.summary}`}
          disabled={undo.isPending}
          onPress={runUndo}
          style={({ pressed }) => [{ alignSelf: 'flex-start', opacity: pressed || undo.isPending ? 0.5 : 1 }]}
        >
          <Txt variant="caption" tone="accent" weight="600">
            {undo.isPending ? 'Undoing…' : 'Undo'}
          </Txt>
        </Pressable>
      ) : null}
    </Animated.View>
  );
}
