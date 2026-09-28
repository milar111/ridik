import { useEffect, useState } from 'react';
import { StyleSheet, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useTheme } from '../ThemeProvider';
import { inkOn, plateOf } from '../ink';
import { fade } from '../motion';
import { AnimatedPressable, useCheckPop, usePressScale } from '../motionHooks';
import { Txt } from './Text';

/**
 * A layer that fades with a flag — `Toggle`'s lit track, generalised one file.
 *
 * Local on purpose: it is two lines over `FADE` rather than a new curve, and
 * the two callers here (a segment's pill, a chip's fill) are the only places
 * that need a *fill* to arrive rather than a transform. Anything with physics
 * in it belongs in `motionHooks`, not here.
 */
function useLit(on: boolean) {
  const lit = useSharedValue(on ? 1 : 0);
  useEffect(() => {
    lit.value = fade(on ? 1 : 0);
  }, [on, lit]);
  return useAnimatedStyle(() => ({ opacity: lit.value }));
}

/* --------------------------------------------------------------- Checkbox -- */

export function Checkbox({
  checked,
  onToggle,
  label,
  sublabel,
  disabled,
  strikeWhenChecked = true,
  right,
  testID,
  accessibilityLabel,
}: {
  checked: boolean;
  onToggle: (next: boolean) => void;
  label?: string;
  sublabel?: string;
  disabled?: boolean;
  strikeWhenChecked?: boolean;
  right?: React.ReactNode;
  testID?: string;
  /**
   * Overrides the announced text. The urgency of a row usually lives in what is
   * rendered *beside* the label — "2 days late", a due time — and a screen
   * reader hears only the label unless the caller says otherwise.
   */
  accessibilityLabel?: string;
}) {
  const { colors, spacing } = useTheme();
  // 0.98 because the touchable is a full-width row, not the 21pt box inside it.
  const press = usePressScale({ scale: 0.98, disabled: !!disabled });
  // The tick is a receipt. Ticking something off is one of two things this app
  // asks of you every day and it used to change four properties in one frame.
  const pop = useCheckPop(checked);
  return (
    <AnimatedPressable
      testID={testID}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled: !!disabled }}
      accessibilityLabel={accessibilityLabel ?? [label, sublabel].filter(Boolean).join(', ')}
      disabled={disabled}
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        onToggle(!checked);
      }}
      {...press.handlers}
      // 44pt minimum target: these rows are tapped while walking. The scale is
      // visual only — `minHeight` and `hitSlop` are untouched by a transform.
      style={[styles.checkRow, { paddingVertical: spacing.sm }, press.style]}
      hitSlop={6}
    >
      {/* A ticked box is cool, not warm — the same slate `TaskRow` fills with,
          and the same thing the palette means by cool everywhere else: settled,
          kept, done. It was the accent, which made the two controls that both
          tick something off disagree about what "done" looks like, and spent the
          brand colour on the one row that is asking nothing of anybody. */}
      <Animated.View
        style={[
          styles.box,
          {
            borderColor: checked ? colors.success : colors.borderStrong,
            backgroundColor: checked ? colors.success : 'transparent',
          },
          pop,
        ]}
      >
        {checked ? <Ionicons name="checkmark" size={14} color={inkOn(colors.success)} /> : null}
      </Animated.View>
      <View style={{ flex: 1, gap: 1 }}>
        {label ? (
          <Txt
            variant="body"
            tone={checked ? 'tertiary' : 'primary'}
            style={checked && strikeWhenChecked ? styles.struck : undefined}
          >
            {label}
          </Txt>
        ) : null}
        {sublabel ? (
          <Txt variant="caption" tone="tertiary">
            {sublabel}
          </Txt>
        ) : null}
      </View>
      {right}
    </AnimatedPressable>
  );
}

/* ------------------------------------------------------------------ Chip -- */

export function Chip({
  label,
  color,
  selected,
  fill = 'solid',
  onPress,
  icon,
  size = 'md',
  accessibilityHint,
}: {
  label: string;
  color?: string;
  selected?: boolean;
  /**
   * What a selected chip looks like, and it is a question about *meaning*.
   *
   * `solid` is a **choice** — one of these is on and the others are off, and the
   * fill is the answer to "which". It is the loudest thing a chip can be and
   * that is right when the row is a picker.
   *
   * `soft` is a **state** the chip is reporting about itself: logged, done,
   * finished. It draws the colour as a plate with the colour as ink, the same
   * treatment `Badge` uses. The distinction is not decoration — a done habit
   * rendered `solid` put a full-strength pale fill in a dark room, which made
   * "you already did this" the brightest thing on the screen and the ember it
   * sat beside the second brightest. Completion should recede.
   */
  fill?: 'solid' | 'soft';
  onPress?: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
  size?: 'sm' | 'md';
  /** For a chip whose label alone does not say what tapping it does. */
  accessibilityHint?: string;
}) {
  const { colors, radius, scheme } = useTheme();
  /* A chip with no colour of its own is quiet until it is the chosen one.
     The default used to be the accent in both states, which drew a row of
     identical ember outlines where nothing was chosen yet — every tag, every
     category, every project kind the same brand colour, saying nothing. Colour
     here answers one question, "which of these is on", and a row where the
     answer is "none" should be able to say so. */
  const tint = color ?? (selected ? colors.accent : colors.textSecondary);
  // A solid chip is the one fill in the app whose colour does not follow the
  // scheme — `colorForTag()` answers a scheme-appropriate hue, but an ember
  // chosen in Settings does not. One constant ink cannot serve both, so it picks.
  const solid = selected && fill === 'solid';
  const plate = selected && fill === 'soft';
  const ink = solid ? inkOn(tint) : tint;
  // A chip is small, so it takes the full press travel.
  const press = usePressScale();
  const body = (
    <View
      style={[
        styles.chip,
        {
          borderRadius: radius.pill,
          backgroundColor: solid ? tint : plate ? plateOf(tint, scheme) : 'transparent',
          // A plate carries its own edge. Keeping `colors.border` there would
          // draw a neutral hairline around a tinted shape, which reads as the
          // outline chip it is meant to be distinguishable from.
          borderColor: solid ? tint : plate ? 'transparent' : colors.border,
          paddingVertical: size === 'sm' ? 2 : 5,
          paddingHorizontal: size === 'sm' ? 8 : 11,
        },
      ]}
    >
      {icon ? <Ionicons name={icon} size={size === 'sm' ? 11 : 13} color={ink} /> : null}
      <Txt variant={size === 'sm' ? 'micro' : 'caption'} style={{ color: ink }}>
        {label}
      </Txt>
    </View>
  );
  if (!onPress) return body;
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      // Selection is the whole point of a pressable chip; without this a screen
      // reader cannot tell which kind, section or date is currently chosen.
      accessibilityState={{ selected: !!selected }}
      onPress={onPress}
      // A small chip is ~18pt tall. Vertical-only slop, because chips sit in
      // horizontal rows and a sideways expansion would steal a neighbour's tap.
      // Slop is measured on the layout box, which a transform does not move.
      hitSlop={{ top: 8, bottom: 8 }}
      {...press.handlers}
      style={press.style}
    >
      {body}
    </AnimatedPressable>
  );
}

/* ----------------------------------------------------------------- Input -- */

export function Input({
  label,
  error,
  containerStyle,
  ...rest
}: TextInputProps & { label?: string; error?: string; containerStyle?: ViewStyle }) {
  const { colors, radius, spacing, typography } = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View style={[{ gap: 4 }, containerStyle]}>
      {label ? (
        <Txt variant="micro" tone="tertiary" style={{ letterSpacing: 0.6 }}>
          {label.toUpperCase()}
        </Txt>
      ) : null}
      <TextInput
        placeholderTextColor={colors.textTertiary}
        // An `EditText` keeps the platform's own Material underline behind
        // whatever this draws; iOS has nothing of the kind.
        underlineColorAndroid="transparent"
        {...rest}
        onFocus={(e) => {
          setFocused(true);
          rest.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          rest.onBlur?.(e);
        }}
        style={[
          typography.body,
          {
            // Same reason as `Txt`: Android's font padding would make the
            // field a few points taller than the identical one on iOS, and the
            // text inside it sit low.
            includeFontPadding: false,
            color: colors.text,
            backgroundColor: colors.surfaceSunken,
            borderColor: error ? colors.danger : focused ? colors.accent : colors.border,
            borderWidth: StyleSheet.hairlineWidth,
            borderRadius: radius.sm,
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.sm + 2,
          },
          rest.style,
        ]}
      />
      {error ? (
        <Txt variant="micro" tone="danger">
          {error}
        </Txt>
      ) : null}
    </View>
  );
}

/* ----------------------------------------------------- SegmentedControl --- */

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const { colors, radius } = useTheme();
  return (
    <View
      style={[
        styles.segmented,
        {
          backgroundColor: colors.surfaceSunken,
          borderRadius: radius.sm,
          borderColor: colors.border,
        },
      ]}
    >
      {options.map((o) => (
        <Segment
          key={o.value}
          label={o.label}
          active={o.value === value}
          onPress={() => onChange(o.value)}
        />
      ))}
    </View>
  );
}

/**
 * One segment, extracted because each needs its own animation state and a hook
 * cannot be called from inside a `map`.
 *
 * The active pill used to jump between segments. It is drawn here as a layer
 * *per segment* that fades, rather than one indicator that slides: sliding
 * needs every segment measured through `onLayout` and re-measured on rotation,
 * and a two-frame crossfade of a background is honest about what changed
 * without a whole geometry to keep in step. The label's tone changes with it —
 * its `weight` cannot be animated, because that swaps the font family.
 */
function Segment({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const { colors, radius } = useTheme();
  const lit = useLit(active);
  const press = usePressScale({ scale: 0.97 });
  return (
    <AnimatedPressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      {...press.handlers}
      style={[styles.segment, press.style]}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: colors.surfaceRaised, borderRadius: radius.sm - 2 },
          lit,
        ]}
      />
      <Txt variant="caption" tone={active ? 'primary' : 'tertiary'} weight={active ? '600' : '400'}>
        {label}
      </Txt>
    </AnimatedPressable>
  );
}

/* ------------------------------------------------------------ EmptyState -- */

export function EmptyState({
  icon = 'sparkles-outline',
  title,
  hint,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  hint?: string;
}) {
  const { colors, spacing } = useTheme();
  return (
    <View style={{ alignItems: 'center', paddingVertical: spacing.xxl, gap: spacing.sm }}>
      <Ionicons name={icon} size={30} color={colors.textTertiary} />
      <Txt variant="bodyStrong" tone="secondary" center>
        {title}
      </Txt>
      {hint ? (
        <Txt variant="caption" tone="tertiary" center style={{ maxWidth: 280 }}>
          {hint}
        </Txt>
      ) : null}
    </View>
  );
}

/* ---------------------------------------------------------------- Badge --- */

export function Badge({
  label,
  tone = 'accent',
}: {
  label: string;
  tone?: 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';
}) {
  const { colors, radius } = useTheme();
  const map = {
    accent: [colors.accentMuted, colors.accent],
    success: [colors.successMuted, colors.success],
    warning: [colors.warningMuted, colors.warning],
    danger: [colors.dangerMuted, colors.danger],
    info: [colors.infoMuted, colors.info],
    neutral: [colors.surfaceSunken, colors.textSecondary],
  } as const;
  const [bg, fg] = map[tone];
  return (
    <View
      style={{
        backgroundColor: bg,
        borderRadius: radius.sm,
        paddingHorizontal: 6,
        paddingVertical: 2,
      }}
    >
      <Txt variant="micro" style={{ color: fg }}>
        {label}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  box: {
    width: 21,
    height: 21,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  struck: { textDecorationLine: 'line-through' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  segmented: { flexDirection: 'row', padding: 2, borderWidth: StyleSheet.hairlineWidth },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 6 },
});
