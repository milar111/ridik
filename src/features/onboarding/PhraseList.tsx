/**
 * The phrase catalogue, drawn.
 *
 * One component, two homes: the last step of the first run, and `/examples`
 * reached from the menu. That is deliberate rather than convenient — a tour
 * shown once is a tour nobody remembers, and the question "what can I say?"
 * arrives on day three, not day one.
 */
import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Txt } from '@/ui/components';
import { useTheme } from '@/ui/ThemeProvider';

import { PHRASE_GROUPS, SAFETY_POINTS, type PhraseGroup } from './phrases';

export function PhraseList() {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing.sm }}>
      {PHRASE_GROUPS.map((group) => (
        <Group key={group.key} group={group} />
      ))}
      <Safety />
    </View>
  );
}

/**
 * What happens when it mishears — the card that is not examples.
 *
 * Last rather than first on purpose: somebody who has not yet seen what the
 * app is for has no use for what happens when it goes wrong. But it has to be
 * on the same screen, because the reason people dictate short, careful,
 * low-value sentences is that nobody told them.
 */
function Safety() {
  const { colors, radius, spacing } = useTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md },
      ]}
    >
      <View style={styles.head}>
        <View
          style={[styles.glyph, { backgroundColor: colors.accentMuted, borderRadius: radius.sm }]}
        >
          <Ionicons name="shield-checkmark-outline" size={17} color={colors.accent} />
        </View>
        <Txt variant="heading" style={{ flex: 1 }}>
          If it hears you wrong
        </Txt>
      </View>

      <View style={{ gap: 6, marginTop: 2 }}>
        {SAFETY_POINTS.map((point) => (
          <View key={point} style={styles.line}>
            <Ionicons name="ellipse" size={5} color={colors.accent} style={styles.bullet} />
            <Txt variant="caption" tone="secondary" style={{ flex: 1 }}>
              {point}
            </Txt>
          </View>
        ))}
      </View>
    </View>
  );
}

function Group({ group }: { group: PhraseGroup }) {
  const { colors, radius, spacing } = useTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md },
      ]}
    >
      <View style={styles.head}>
        <View
          style={[styles.glyph, { backgroundColor: colors.accentMuted, borderRadius: radius.sm }]}
        >
          <Ionicons name={group.icon as never} size={17} color={colors.accent} />
        </View>
        {/* `flex: 1` rather than its own content: Android measures a Text in a
            flex row short and clips rather than wrapping. */}
        <Txt variant="heading" style={{ flex: 1 }}>
          {group.title}
        </Txt>
      </View>

      <Txt variant="caption" tone="secondary">
        {group.blurb}
      </Txt>

      <View style={{ gap: 6, marginTop: 2 }}>
        {group.phrases.map((phrase) => (
          /*
            Quoted and in the accent, so it reads as *speech* rather than as a
            feature bullet. The distinction matters: a bullet says what the app
            has, a quote says what to do with your mouth, and the second is the
            only one that helps somebody holding a microphone.
          */
          <View key={phrase.say} style={styles.line}>
            <Ionicons name="mic" size={12} color={colors.accent} style={styles.mic} />
            <Txt variant="body" tone="accent" style={{ flex: 1 }}>
              “{phrase.say}”
            </Txt>
          </View>
        ))}
      </View>

      {group.note ? (
        <Txt variant="micro" tone="tertiary" style={{ marginTop: 2 }}>
          {group.note}
        </Txt>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: 6 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  glyph: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  // Nudged onto the first line's optical centre rather than its box top.
  mic: { marginTop: 4 },
  bullet: { marginTop: 6 },
});
