/**
 * The row vocabulary Settings is built from.
 *
 * Extracted so the customer-facing screen and the hidden developer screen use
 * the same shapes: a knob that only engineers should see still deserves to look
 * and behave like the rest of the app, and a second set of near-identical rows
 * is how two screens quietly drift apart.
 */
import { Children, useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useSetSecret, type SecretSlot } from '@/hooks/useSystem';
import { useTheme } from '@/ui/ThemeProvider';
import { Button, Card, Divider, Input, Section, Toggle, Txt, useToast } from '@/ui/components';

export function Group({ title, children }: { title: string; children: ReactNode }) {
  const { spacing } = useTheme();
  const rows = Children.toArray(children);
  return (
    <Section title={title}>
      <Card padded={false}>
        {rows.map((row, index) => (
          <View key={index}>
            {index > 0 ? <Divider inset={spacing.md} /> : null}
            {row}
          </View>
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
  const body = (
    <View style={[styles.row, { paddingHorizontal: spacing.md, gap: spacing.md }]}>
      {icon ? <Ionicons name={icon} size={19} color={tone ? colors[tone] : colors.textSecondary} /> : null}
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
      {right}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      {body}
    </Pressable>
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
    <View style={{ paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2, gap: 6 }}>
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
          <View
            style={{
              height: 4,
              borderRadius: radius.pill,
              backgroundColor: colors.accent,
              width: `${Math.round(fraction * 100)}%`,
            }}
          />
        </View>
        <View
          pointerEvents="none"
          style={[
            styles.sliderThumb,
            {
              backgroundColor: colors.accent,
              borderColor: colors.bg,
              left: Math.max(0, Math.min(Math.max(0, width - 16), fraction * width - 8)),
            },
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
  const [draft, setDraft] = useState<string | null>(null);
  const current = draft ?? value;
  const error = draft === null ? null : validate(draft.trim());

  return (
    <View style={{ padding: spacing.md, gap: spacing.sm }}>
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
      <View style={{ padding: spacing.md, gap: spacing.sm }}>
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
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
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
