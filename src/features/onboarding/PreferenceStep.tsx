/**
 * The three questions that are about the person, asked once, before the tour.
 *
 * ## Why any of this is on the first run at all
 *
 * `AGENTS.md` is hard on onboarding questions, and rightly: the app is one
 * microphone and one answer, and every switch in front of that is a decision
 * taken before anything gets done. The test that survives is whether the
 * *default* can be wrong for somebody in a way they will not find out about.
 *
 * These three can:
 *
 * - **Speaking replies** is off for the life of the app, so a person who wants
 *   to be answered out loud has to go looking for a switch they have no reason
 *   to believe exists.
 * - **The confirmation gate** shipped with no UI at all and a default that asks
 *   before anything irreversible. Somebody who finds that one question too many
 *   spends the whole first session being asked.
 * - **The clock** reads the device, which on Android does not carry the
 *   24-hour switch at all — so an American on a Galaxy sees `21:00` with no
 *   idea it is a setting.
 *
 * Each is one tap, each is reversible from Profile, and the screen says so. It
 * is deliberately not four: colour is on Settings and is not wrong by default,
 * and anything the assistant can be told in a sentence does not belong here.
 *
 * ## It writes as you tap
 *
 * No Save. There is nothing to lose by leaving early — the defaults are the
 * defaults — and a form that has to be submitted turns a preference into a
 * commitment. The mutation is optimistic, so the tick moves under the finger
 * rather than after a round trip to SQLite.
 */
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { clockFormatOptions, sampleClock, type ClockFormat } from '@/core/time';
import { now } from '@/core/clock';
import { useSetting } from '@/hooks';
import type { ConfirmMode } from '@/llm/confirm';
import { useTheme } from '@/ui/ThemeProvider';
import { Toggle } from '@/ui/components/Toggle';
import { Txt } from '@/ui/components/Text';
import { AnimatedPressable, usePressScale } from '@/ui/motionHooks';

const CONFIRM_CHOICES: { value: ConfirmMode; label: string; note: string }[] = [
  { value: 'never', label: 'Just do it', note: 'No questions. The receipt catches mistakes.' },
  {
    value: 'irreversible',
    label: 'Only what cannot be undone',
    note: 'Deletes and money get a question.',
  },
  { value: 'always', label: 'Every time', note: 'Show me every write first.' },
];

export function PreferenceStep() {
  const { colors, spacing } = useTheme();
  const speak = useSetting('ttsEnabled');
  const confirm = useSetting('confirmMode');
  const clock = useSetting('clockFormat');
  const at = now();

  return (
    <View style={{ gap: spacing.md }} testID="welcome-preferences">
      <View
        style={{
          width: 52,
          height: 52,
          borderRadius: 26,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.accentMuted,
        }}
      >
        <Ionicons name="options-outline" size={26} color={colors.accent} />
      </View>
      <Txt variant="eyebrow" tone="tertiary">
        HOW YOU LIKE IT
      </Txt>
      <Txt variant="display">Three quick ones.</Txt>
      <Txt variant="body" tone="secondary">
        All three live in Profile afterwards, so nothing here is final.
      </Txt>

      <Question title="Answers out loud">
        <AnimatedPressable
          accessibilityRole="switch"
          accessibilityState={{ checked: speak.value }}
          accessibilityLabel="Read answers out loud"
          onPress={() => speak.set(!speak.value)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}
        >
          <View style={{ flex: 1 }}>
            <Txt variant="body">Read answers out loud</Txt>
            <Txt variant="micro" tone="tertiary">
              Off is quieter and faster. On is better with your hands full.
            </Txt>
          </View>
          <Toggle value={speak.value} onValueChange={speak.set} />
        </AnimatedPressable>
      </Question>

      <Question title="Before it writes">
        {CONFIRM_CHOICES.map((option) => (
          <Choice
            key={option.value}
            label={option.label}
            note={option.note}
            selected={confirm.value === option.value}
            onSelect={() => confirm.set(option.value)}
          />
        ))}
      </Question>

      <Question title="Clock">
        {clockFormatOptions().map((option) => (
          <Choice
            key={option.value}
            label={option.label}
            // The instant, rendered that way. "12-hour" is a specification and
            // `9:41 PM` is the answer — and for `auto` it is the only honest
            // label there is, because the row cannot promise what the device
            // will say, only show what it *is* saying.
            note={sampleClock(option.value as ClockFormat, at)}
            selected={clock.value === option.value}
            onSelect={() => clock.set(option.value)}
          />
        ))}
      </Question>
    </View>
  );
}

function Question({ title, children }: { title: string; children: React.ReactNode }) {
  const { colors, radius, spacing } = useTheme();
  return (
    <View style={{ gap: spacing.xs, marginTop: spacing.sm }}>
      <Txt variant="eyebrow" tone="tertiary">
        {title.toUpperCase()}
      </Txt>
      <View
        style={{
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface,
          padding: spacing.md,
          gap: spacing.sm,
        }}
      >
        {children}
      </View>
    </View>
  );
}

function Choice({
  label,
  note,
  selected,
  onSelect,
}: {
  label: string;
  note: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const { colors, spacing } = useTheme();
  const press = usePressScale({ scale: 0.98 });

  return (
    <AnimatedPressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${label}. ${note}`}
      onPress={onSelect}
      {...press.handlers}
      style={[
        { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
        press.style,
      ]}
    >
      <View style={{ flex: 1 }}>
        <Txt variant="body" tone={selected ? undefined : 'secondary'}>
          {label}
        </Txt>
        <Txt variant="micro" tone="tertiary">
          {note}
        </Txt>
      </View>
      {/* A tick, not a colour: the selected row is also the only one at full
          ink, and one signal that is only a shade is no signal at all. */}
      {selected ? <Ionicons name="checkmark" size={18} color={colors.accent} /> : null}
    </AnimatedPressable>
  );
}
