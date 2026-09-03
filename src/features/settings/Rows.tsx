/**
 * The row vocabulary Settings is built from.
 *
 * Extracted so the customer-facing screen and the hidden developer screen use
 * the same shapes: a knob that only engineers should see still deserves to look
 * and behave like the rest of the app, and a second set of near-identical rows
 * is how two screens quietly drift apart.
 */
import { Children, createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

import { useSetSecret, type SecretSlot } from '@/hooks/useSystem';
import { useStaggeredEntry , AnimatedPressable, usePressScale } from '@/ui/motionHooks';
import { useTheme } from '@/ui/ThemeProvider';
import { still, tap } from '@/ui/motion';
import { Button, Card, Divider, Input, Section, Toggle, Txt, useToast } from '@/ui/components';

/**
 * Every row on Settings and on the developer screen goes through here, so the
 * arrival is written once — the same reasoning as `RowCard` on the task lists.
 *
 * Each card runs its own wave from zero. Settings is read heading by heading,
 * and a single count across the whole screen would leave the last group waiting
 * on twenty rows above it that the user is not looking at.
 *
 * `entering` and no `layout`: these rows are keyed by *position*, because a
 * settings row has no id of its own. A row appearing or disappearing — a
 * permission warning resolving, a group growing a field — therefore renumbers
 * its neighbours, and a layout transition on identities that shuffle animates
 * the wrong rows towards the wrong places.
 */
/**
 * The leading column, and the reason every label on a settings screen starts at
 * the same x.
 *
 * A row used to size its own leading slot from whatever was in it — 19dp for an
 * `Ionicons` glyph, 42 for the ember swatch, **nothing at all** for a row with
 * no icon. Inside one card that is invisible, because a card tends to be all
 * one kind. Down a whole screen it is not: Settings put `Free`, `Microphone`
 * and `Where your words go` at 61dp, `Speak replies` at 30 and `Ember` at 80,
 * so the eye had three left edges to track in one list.
 *
 * 22 is the widest thing that has to sit in it — a 19dp glyph with a point of
 * air each side — and the ember swatch is drawn to that width rather than the
 * column being widened to the swatch, because a 42dp column would push every
 * label on the screen a finger's width right to accommodate one row.
 */
export const ROW_LEAD = 22;

/**
 * Whether rows in this subtree reserve the leading column even without an icon.
 *
 * It is a property of the *screen*, not of the row and not of the card: a
 * screen where some cards have icons has to reserve it in the cards that do
 * not, or the labels step in and out as you scroll past. Screens with no icons
 * anywhere never turn it on and keep their labels against the card padding,
 * which is why this is not simply always-on — 314 of the app's 711 rows have no
 * icon and would gain an indent that means nothing.
 */
const LeadContext = createContext(false);

export function ReserveRowLead({ children }: { children: ReactNode }) {
  return <LeadContext.Provider value>{children}</LeadContext.Provider>;
}

/**
 * The same indent a `Row`'s label gets, for the things in a card that are not
 * rows.
 *
 * A card is rarely all rows. Developer's Assistant card is `Mode` (a row), then
 * a `MODEL` heading with its chips, then two sliders, then three more rows —
 * and only the rows knew about the leading column, so the card had its labels
 * at **64pt** and its headings, chips, sliders and captions at **29pt**. That
 * is the identical defect `ReserveRowLead` was written for, one level further
 * in: it lined the rows up with each other and left everything between them
 * behind.
 *
 * It is the column plus the row's own gap, because that is the distance from
 * the card's padding to where a label actually starts. Zero when the screen has
 * not reserved the column, so a card of plain rows is untouched.
 */
export function useRowLeadInset(): number {
  const { spacing } = useTheme();
  return useContext(LeadContext) ? ROW_LEAD + spacing.md : 0;
}

export function Group({ title, children }: { title: string; children: ReactNode }) {
  const { spacing } = useTheme();
  const arrive = useStaggeredEntry({ from: 'below' });
  const rows = Children.toArray(children);
  return (
    <Section title={title}>
      <Card padded={false}>
        {rows.map((row, index) => (
          <Animated.View key={index} entering={arrive(index)}>
            {index > 0 ? <Divider inset={spacing.md} /> : null}
            {row}
          </Animated.View>
        ))}
      </Card>
    </Section>
  );
}

export function Row({
  icon,
  label,
  value,
  hint,
  right,
  tone,
  onPress,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  label: string;
  value?: string;
  hint?: string;
  right?: ReactNode;
  tone?: 'danger' | 'warning';
  onPress?: () => void;
}) {
  const { colors, spacing } = useTheme();
  const reserve = useContext(LeadContext);
  // A settings row runs the full width of a card; 0.98 is as far as something
  // that wide can travel before the card looks like it is being squeezed.
  const press = usePressScale({ scale: 0.98 });
  const body = (
    <View style={[styles.row, { paddingHorizontal: spacing.md, gap: spacing.md }]}>
      {icon || reserve ? (
        <View style={styles.lead}>
          {icon ? (
            <Ionicons name={icon} size={19} color={tone ? colors[tone] : colors.textSecondary} />
          ) : null}
        </View>
      ) : null}
      <View style={{ flex: 1, gap: 1 }}>
        <Txt variant="body">{label}</Txt>
        {value ? (
          <Txt variant="caption" tone={tone ?? 'secondary'}>
            {value}
          </Txt>
        ) : null}
        {hint ? (
          <Txt variant="micro" tone="tertiary">
            {hint}
          </Txt>
        ) : null}
      </View>
      {/*
        A slot, not the bare node.

        `Button` sets `alignSelf: 'flex-start'` so it does not stretch to full
        width when it is stacked in a column — which is right there and wrong
        here, because this row's cross axis is *vertical*: the same declaration
        means "hug the top", and it overrides the row's own `alignItems`. The
        result was a `Change` button level with the title of a six-line row with
        a hand's width of empty card under it, next to an icon that was
        correctly centred, on the one screen where a stranger forms their first
        opinion of the app.

        Wrapping restores a column context, so the Button's `alignSelf` means
        the horizontal thing it was written to mean and this row's
        `alignItems: 'center'` decides the vertical.
      */}
      {right ? <View style={styles.rowRight}>{right}</View> : null}
    </View>
  );
  if (!onPress) return body;
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      {...press.handlers}
      style={press.style}
    >
      {body}
    </AnimatedPressable>
  );
}

export function SwitchRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Row
      label={label}
      hint={hint}
      // `Toggle` takes its colours from the theme rather than from here: the
      // `trackColor`/`thumbColor` pair only existed to recolour two unrelated
      // native switches, and could never make them the same control.
      right={<Toggle value={value} onValueChange={onChange} accessibilityLabel={label} />}
    />
  );
}

/**
 * A slider with no slider dependency: a track that reads its own width and maps
 * a touch to a value.
 *
 * The drag is local and only the release is written. A finger crossing this
 * track emits a move event per frame, and persisting each one would put sixty
 * upserts through SQLite to change one number. Registered as `adjustable` so
 * VoiceOver can step it, which a bare pan responder would not be.
 */
export function SliderRow({
  label,
  hint,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (next: number) => void;
}) {
  const { colors, radius, spacing } = useTheme();
  const lead = useRowLeadInset();
  const [width, setWidth] = useState(0);
  const [shown, setShown] = useState(value);
  const [dragging, setDragging] = useState(false);

  // The stored value wins whenever the finger is off the track — including the
  // moment a rollback puts the old number back.
  useEffect(() => {
    if (!dragging) setShown(value);
  }, [value, dragging]);

  const clamp = (next: number) => {
    const snapped = Math.round(next / step) * step;
    return Math.min(max, Math.max(min, Number(snapped.toFixed(4))));
  };
  const fraction = max === min ? 0 : (shown - min) / (max - min);

  // The fill and the thumb are driven from one shared value so they cannot
  // disagree by a frame. While the finger is down it lands instantly — a spring
  // under a drag reads as lag, not as weight. Everywhere else it springs: the
  // snap to the nearest step on release, a rollback putting the old number
  // back, and a VoiceOver increment, none of which have a finger to follow.
  const travel = useSharedValue(fraction);
  useEffect(() => {
    travel.value = dragging ? still(fraction) : tap(fraction);
  }, [fraction, dragging, travel]);

  const fillStyle = useAnimatedStyle(() => ({ width: `${travel.value * 100}%` as `${number}%` }));
  const thumbStyle = useAnimatedStyle(() => ({
    left: Math.max(0, Math.min(Math.max(0, width - 16), travel.value * width - 8)),
  }));

  const handleTouch = (x: number) => {
    if (width <= 0) return;
    setDragging(true);
    setShown(clamp(min + (Math.min(Math.max(x, 0), width) / width) * (max - min)));
  };
  const release = () => {
    setDragging(false);
    if (shown !== value) onChange(shown);
  };

  return (
    <View
      style={{
        paddingLeft: spacing.md + lead,
        paddingRight: spacing.md,
        paddingVertical: spacing.sm + 2,
        gap: 6,
      }}
    >
      <View style={styles.sliderHead}>
        <Txt variant="body">{label}</Txt>
        <Txt variant="mono" tone="accent">
          {format(shown)}
        </Txt>
      </View>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ min, max, now: shown, text: format(shown) }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(event) =>
          onChange(clamp(value + (event.nativeEvent.actionName === 'increment' ? step : -step)))
        }
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={(event) => handleTouch(event.nativeEvent.locationX)}
        onResponderMove={(event) => handleTouch(event.nativeEvent.locationX)}
        onResponderRelease={release}
        onResponderTerminate={release}
        // 32pt of touchable height around a 4pt rule: this is dragged with a thumb.
        style={styles.sliderTrackArea}
      >
        <View style={{ height: 4, borderRadius: radius.pill, backgroundColor: colors.surfaceSunken }}>
          <Animated.View
            style={[
              { height: 4, borderRadius: radius.pill, backgroundColor: colors.accent },
              fillStyle,
            ]}
          />
        </View>
        <Animated.View
          pointerEvents="none"
          style={[
            styles.sliderThumb,
            { backgroundColor: colors.accent, borderColor: colors.bg },
            thumbStyle,
          ]}
        />
      </View>
      {hint ? (
        <Txt variant="micro" tone="tertiary">
          {hint}
        </Txt>
      ) : null}
    </View>
  );
}

/** A free-text setting written on blur rather than on every keystroke. */
export function DraftInput({
  value,
  onCommit,
  placeholder,
  accessibilityLabel,
}: {
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
  accessibilityLabel?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      value={draft ?? value}
      onChangeText={setDraft}
      onBlur={() => {
        const next = draft?.trim();
        if (next && next !== value) onCommit(next);
        setDraft(null);
      }}
      autoCapitalize="none"
      autoCorrect={false}
      placeholder={placeholder}
      accessibilityLabel={accessibilityLabel}
    />
  );
}

/**
 * A text setting that is only written once it is valid — a half-typed zone name
 * would otherwise be saved on every keystroke and break every date on screen.
 */
export function ValidatedTextRow({
  label,
  value,
  hint,
  placeholder,
  transform,
  validate,
  onCommit,
}: {
  label: string;
  value: string;
  hint?: string;
  placeholder?: string;
  transform?: (text: string) => string;
  validate: (value: string) => string | null;
  onCommit: (value: string) => void;
}) {
  const { spacing } = useTheme();
  const lead = useRowLeadInset();
  const [draft, setDraft] = useState<string | null>(null);
  const current = draft ?? value;
  const error = draft === null ? null : validate(draft.trim());

  return (
    <View
      style={{ paddingLeft: spacing.md + lead, paddingRight: spacing.md, paddingVertical: spacing.md, gap: spacing.sm }}
    >
      <Input
        label={label}
        value={current}
        onChangeText={(text) => setDraft(transform ? transform(text) : text)}
        onBlur={() => {
          if (draft !== null && validate(draft.trim()) === null) onCommit(draft.trim());
          setDraft(null);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={placeholder}
        error={error ?? undefined}
      />
      {draft !== null && !error && draft.trim() !== value ? (
        <Button
          label="Save"
          size="sm"
          variant="primary"
          onPress={() => {
            onCommit(draft.trim());
            setDraft(null);
          }}
        />
      ) : hint ? (
        <Txt variant="micro" tone="tertiary">
          {hint}
        </Txt>
      ) : null}
    </View>
  );
}

export function GroupSkeleton({ title, rows }: { title: string; rows: number }) {
  const { colors, radius, spacing } = useTheme();
  return (
    <Section title={title}>
      <Card padded={false}>
        {Array.from({ length: rows }, (_, index) => (
          <View key={index} style={{ padding: spacing.md, gap: 6 }}>
            <View
              style={{ height: 12, width: '45%', borderRadius: radius.sm, backgroundColor: colors.surfaceSunken }}
            />
            <View
              style={{ height: 10, width: '70%', borderRadius: radius.sm, backgroundColor: colors.surfaceSunken }}
            />
          </View>
        ))}
      </Card>
    </Section>
  );
}

export function RetryRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Txt variant="caption" tone="danger">
            {message}
          </Txt>
        </View>
        <Button label="Retry" size="sm" variant="ghost" onPress={onRetry} />
      </View>
    </Card>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SecretRow({
  slot,
  label,
  hint,
  state,
}: {
  slot: SecretSlot;
  label: string;
  hint: string;
  state: { present: boolean; preview: string | null } | undefined;
}) {
  const { spacing } = useTheme();
  const toast = useToast();
  const save = useSetSecret();
  const lead = useRowLeadInset();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const commit = (value: string | null) => {
    save.mutate(
      { slot, value },
      {
        onSuccess: () => {
          setEditing(false);
          setDraft('');
          toast.show({ message: value ? 'Key saved' : 'Key removed', tone: value ? 'success' : 'neutral' });
        },
        onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
      },
    );
  };

  if (editing) {
    return (
      <View
        style={{ paddingLeft: spacing.md + lead, paddingRight: spacing.md, paddingVertical: spacing.md, gap: spacing.sm }}
      >
        <Input
          label={label}
          value={draft}
          onChangeText={setDraft}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Paste the key"
          autoFocus
        />
        <View style={styles.chips}>
          <Button
            label="Save"
            size="sm"
            variant="primary"
            disabled={draft.trim().length === 0}
            loading={save.isPending}
            onPress={() => commit(draft)}
          />
          <Button
            label="Cancel"
            size="sm"
            variant="ghost"
            onPress={() => {
              setEditing(false);
              setDraft('');
            }}
          />
          {state?.present ? (
            <Button label="Remove" size="sm" variant="danger" onPress={() => commit(null)} />
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <Row
      icon="key-outline"
      label={label}
      value={state?.preview ?? 'Not set'}
      hint={hint}
      right={<Button label={state?.present ? 'Change' : 'Add'} size="sm" onPress={() => setEditing(true)} />}
    />
  );
}

/* ---------------------------------------------------------------- schedule */

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingVertical: 10, gap: 12 },
  lead: { width: ROW_LEAD, alignItems: 'center' },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  /** See the comment at the `right` slot. Column direction is the whole point. */
  rowRight: { alignItems: 'flex-end' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  sliderHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sliderTrackArea: { justifyContent: 'center', height: 32 },
  sliderThumb: {
    position: 'absolute',
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
  },
});
