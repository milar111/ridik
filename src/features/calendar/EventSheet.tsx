import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  addMinutes,
  formatDayHeading,
  formatDuration,
  formatTime,
  localDateOf,
  type LocalDate,
} from '@/core/time';
import type { CalendarEvent } from '@/db/schema';
import { useCalendarEvent, useDeleteEvent, useUpdateEvent } from '@/hooks';
import { Badge, Button, Divider, Input, SheetCard, Txt, useToast } from '@/ui/components';
import { useTheme } from '@/ui/ThemeProvider';
import type { Colors } from '@/ui/theme';

import { describeSync, durationMinutes, type SyncTone } from './agenda';

/** Nudges, not a picker: the whole point is to reschedule in one tap. */
const NUDGES = [
  { label: '−1h', minutes: -60 },
  { label: '−15m', minutes: -15 },
  { label: '+15m', minutes: 15 },
  { label: '+1h', minutes: 60 },
] as const;

const DURATION_PRESETS = [15, 30, 60, 90] as const;
const MIN_DURATION = 5;
const MAX_DURATION = 12 * 60;
const DURATION_STEP = 15;

export type EventSheetTarget = { event: CalendarEvent; buffer: CalendarEvent | null };

export type EventSheetProps = {
  target: EventSheetTarget | null;
  zone: string;
  googleConnected: boolean;
  onClose: () => void;
  /** So a save can move the agenda to the day the event landed on. */
  onMoved?: (date: LocalDate) => void;
};

export function EventSheet({ target, zone, googleConnected, onClose, onMoved }: EventSheetProps) {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={target !== null}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close event"
        style={[styles.backdrop, { backgroundColor: colors.overlay }]}
        onPress={onClose}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.sheetWrap}
      >
        <SheetCard
          style={[
            styles.sheet,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
              borderTopLeftRadius: radius.xl,
              borderTopRightRadius: radius.xl,
              paddingBottom: insets.bottom + spacing.lg,
              gap: spacing.md,
            },
          ]}
        >
          <View style={[styles.grabber, { backgroundColor: colors.borderStrong }]} />
          {target ? (
            // Keyed by row so opening a second event never inherits the first
            // one's half-finished edit.
            <SheetBody
              key={target.event.id}
              target={target}
              zone={zone}
              googleConnected={googleConnected}
              onClose={onClose}
              onMoved={onMoved}
            />
          ) : null}
        </SheetCard>
      </KeyboardAvoidingView>
    </Modal>
  );
}

type Mode = 'view' | 'edit' | 'confirm';

function SheetBody({
  target,
  zone,
  googleConnected,
  onClose,
  onMoved,
}: {
  target: EventSheetTarget;
  zone: string;
  googleConnected: boolean;
  onClose: () => void;
  onMoved?: (date: LocalDate) => void;
}) {
  const { colors, spacing } = useTheme();
  const toast = useToast();

  // The snapshot the row was rendered from stays on screen until the read
  // lands, so the sheet never opens on a spinner.
  const query = useCalendarEvent(target.event.id);
  const event = query.data ?? target.event;

  const update = useUpdateEvent();
  const remove = useDeleteEvent();

  const [mode, setMode] = useState<Mode>('view');
  const [title, setTitle] = useState(event.title);
  const [location, setLocation] = useState(event.location ?? '');
  const [startsAt, setStartsAt] = useState(event.startsAt);
  const [duration, setDuration] = useState(
    Math.max(MIN_DURATION, durationMinutes(event.startsAt, event.endsAt)),
  );

  const endsAt = addMinutes(startsAt, duration);
  const sync = describeSync(event, { googleConnected });

  const nudge = (minutes: number) => {
    void Haptics.selectionAsync().catch(() => {});
    setStartsAt((current) => addMinutes(current, minutes));
  };

  const setDurationClamped = (minutes: number) =>
    setDuration(Math.min(MAX_DURATION, Math.max(MIN_DURATION, minutes)));

  const save = () => {
    const trimmed = title.trim();
    update.mutate(
      {
        id: event.id,
        patch: {
          title: trimmed || event.title,
          location: location.trim() || null,
          ...(event.allDay ? {} : { startsAt, endsAt }),
        },
      },
      {
        onSuccess: (saved) => {
          // Closing first: a toast fired behind an open Modal is invisible on
          // iOS, and the agenda underneath is the real confirmation.
          onClose();
          onMoved?.(localDateOf(saved.startsAt, zone));
          toast.show({
            message: 'Event updated',
            detail: saved.allDay
              ? undefined
              : `${formatTime(saved.startsAt, zone)} · ${formatDuration(duration)}`,
            tone: 'success',
          });
        },
        onError: (error) =>
          toast.show({ message: 'Could not save that', detail: error.message, tone: 'danger' }),
      },
    );
  };

  const confirmDelete = () => {
    remove.mutate(
      { id: event.id },
      {
        onSuccess: () => {
          onClose();
          toast.show({ message: 'Event deleted', tone: 'neutral' });
        },
        onError: (error) =>
          toast.show({ message: 'Could not delete that', detail: error.message, tone: 'danger' }),
      },
    );
  };

  return (
    <>
      <ScrollView style={{ maxHeight: 420 }} keyboardShouldPersistTaps="handled">
        <View style={{ gap: spacing.md }}>
          {mode === 'edit' ? (
            <View style={{ gap: spacing.sm }}>
              <Input label="Title" value={title} onChangeText={setTitle} testID="event-title" />
              <Input
                label="Location"
                value={location}
                onChangeText={setLocation}
                placeholder="Where?"
              />
            </View>
          ) : (
            <View style={{ gap: 4 }}>
              <View style={styles.titleRow}>
                <Txt variant="title" style={{ flex: 1 }}>
                  {event.title}
                </Txt>
                {event.kind !== 'event' ? <Badge label={event.kind} tone="neutral" /> : null}
              </View>
              {event.location ? (
                <View style={styles.metaRow}>
                  <Ionicons name="location-outline" size={14} color={colors.textTertiary} />
                  <Txt variant="caption" tone="secondary" style={{ flex: 1 }}>
                    {event.location}
                  </Txt>
                </View>
              ) : null}
            </View>
          )}

          <View style={{ gap: 2 }}>
            <Txt variant="caption" tone="tertiary">
              {formatDayHeading(mode === 'edit' ? startsAt : event.startsAt, zone)}
            </Txt>
            {event.allDay ? (
              <Txt variant="heading">All day</Txt>
            ) : (
              <Txt variant="heading" testID="event-time">
                {formatTime(mode === 'edit' ? startsAt : event.startsAt, zone)} –{' '}
                {formatTime(mode === 'edit' ? endsAt : event.endsAt, zone)}
                <Txt variant="caption" tone="tertiary">
                  {'  '}
                  {formatDuration(
                    mode === 'edit' ? duration : durationMinutes(event.startsAt, event.endsAt),
                  )}
                </Txt>
              </Txt>
            )}
          </View>

          {mode === 'edit' && !event.allDay ? (
            <View style={{ gap: spacing.md }}>
              <View style={{ gap: 5 }}>
                <FieldLabel>Start</FieldLabel>
                <View style={styles.buttonRow}>
                  {NUDGES.map((n) => (
                    <Button
                      key={n.label}
                      label={n.label}
                      size="sm"
                      style={styles.tapTarget}
                      onPress={() => nudge(n.minutes)}
                      accessibilityLabel={`Move start ${n.label}`}
                    />
                  ))}
                </View>
              </View>
              <View style={{ gap: 5 }}>
                <FieldLabel>Duration</FieldLabel>
                <View style={styles.buttonRow}>
                  <Button
                    icon="remove"
                    size="sm"
                    style={styles.tapTarget}
                    accessibilityLabel="Fifteen minutes shorter"
                    onPress={() => setDurationClamped(duration - DURATION_STEP)}
                  />
                  <Txt variant="bodyStrong" style={styles.durationValue}>
                    {formatDuration(duration)}
                  </Txt>
                  <Button
                    icon="add"
                    size="sm"
                    style={styles.tapTarget}
                    accessibilityLabel="Fifteen minutes longer"
                    onPress={() => setDurationClamped(duration + DURATION_STEP)}
                  />
                  <View style={styles.presets}>
                    {DURATION_PRESETS.map((minutes) => (
                      <Button
                        key={minutes}
                        label={formatDuration(minutes)}
                        size="sm"
                        variant={duration === minutes ? 'primary' : 'ghost'}
                        style={styles.tapTarget}
                        onPress={() => setDurationClamped(minutes)}
                      />
                    ))}
                  </View>
                </View>
              </View>
            </View>
          ) : null}

          {mode !== 'edit' && event.description ? (
            <Txt variant="body" tone="secondary">
              {event.description}
            </Txt>
          ) : null}

          {target.buffer ? (
            <View style={styles.metaRow}>
              <Ionicons name="walk-outline" size={14} color={colors.textTertiary} />
              <Txt variant="caption" tone="tertiary" style={{ flex: 1 }}>
                {formatDuration(durationMinutes(target.buffer.startsAt, target.buffer.endsAt))} block
                before this, from {formatTime(target.buffer.startsAt, zone)}
              </Txt>
            </View>
          ) : null}

          <Divider />

          <View style={styles.metaRow}>
            <Ionicons name={sync.icon} size={14} color={toneColor(sync.tone, colors)} />
            <Txt variant="caption" style={{ color: toneColor(sync.tone, colors) }}>
              {sync.label}
            </Txt>
            {sync.detail ? (
              <Txt variant="micro" tone="tertiary" numberOfLines={1} style={{ flex: 1 }}>
                {sync.detail}
              </Txt>
            ) : null}
          </View>
        </View>
      </ScrollView>

      {mode === 'confirm' ? (
        <View style={{ gap: spacing.sm }}>
          <Txt variant="caption" tone="secondary">
            Delete “{event.title}”?{target.buffer ? ' Its travel block goes with it.' : ''}
          </Txt>
          <View style={styles.actions}>
            <Button
              label="Delete"
              variant="danger"
              icon="trash-outline"
              loading={remove.isPending}
              onPress={confirmDelete}
              testID="event-delete-confirm"
            />
            <Button label="Keep" variant="ghost" onPress={() => setMode('view')} />
          </View>
        </View>
      ) : mode === 'edit' ? (
        <View style={styles.actions}>
          <Button
            label="Save"
            variant="primary"
            icon="checkmark"
            loading={update.isPending}
            onPress={save}
            testID="event-save"
          />
          <Button label="Cancel" variant="ghost" onPress={() => setMode('view')} />
        </View>
      ) : (
        <View style={styles.actions}>
          <Button
            label="Edit"
            icon="create-outline"
            onPress={() => setMode('edit')}
            testID="event-edit"
          />
          <Button
            label="Delete"
            variant="danger"
            icon="trash-outline"
            onPress={() => setMode('confirm')}
          />
          <Button label="Close" variant="ghost" onPress={onClose} />
        </View>
      )}
    </>
  );
}

/** Matches the label Input draws above its field, so the sheet reads as one form. */
function FieldLabel({ children }: { children: string }) {
  return (
    <Txt variant="micro" tone="tertiary" style={{ letterSpacing: 0.6 }}>
      {children.toUpperCase()}
    </Txt>
  );
}

function toneColor(tone: SyncTone, colors: Colors): string {
  if (tone === 'success') return colors.success;
  if (tone === 'warning') return colors.warning;
  if (tone === 'danger') return colors.danger;
  return colors.textTertiary;
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: { paddingHorizontal: 18, paddingTop: 10, borderWidth: StyleSheet.hairlineWidth },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(128,128,140,0.5)',
    marginBottom: 4,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  buttonRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  // Small buttons still have to be hit while walking.
  tapTarget: { minHeight: 44, minWidth: 44 },
  durationValue: { minWidth: 46, textAlign: 'center' },
  presets: { flexDirection: 'row', gap: 6, flex: 1, justifyContent: 'flex-end' },
  actions: { flexDirection: 'row', gap: 8, alignItems: 'center' },
});
