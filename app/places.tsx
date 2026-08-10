/**
 * Saved places and the reminders anchored to them.
 *
 * TODO(map): the brief asks for a map picker. `react-native-maps` is not in
 * this build and adding a native dependency is out of scope here, so the picker
 * below is an honest coordinate + radius editor: a one-tap "use my location"
 * shortcut, manual latitude/longitude, and a reverse-geocoded address line so
 * the numbers can be checked against something human. Swap this block for a
 * `<MapView>` with a draggable pin and a `<Circle>` bound to `radiusMeters`
 * once the dependency lands; nothing else on this screen has to change.
 */
import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { now } from '@/core/clock';
import { countLabel } from '@/core/format';
import { formatRelative } from '@/core/time';
import {
  useDeactivateGeofenceTrigger,
  useDeleteGeofenceTrigger,
  useDeletePlace,
  useGeofenceTriggers,
  usePlaces,
  useUpsertPlace,
} from '@/hooks';
import {
  useCurrentPosition,
  useGeofenceStatus,
  useRefreshGeofences,
  useReverseGeocode,
} from '@/hooks/useSystem';
import type { GeofenceTrigger, SavedPlace } from '@/db/schema';
import { MAX_MONITORED_REGIONS } from '@/repositories/geofences';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { useTheme } from '@/ui/ThemeProvider';
import {
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  Input,
  Screen,
  Section,
  Txt,
  useToast,
} from '@/ui/components';

const RADIUS_MIN = 50;
const RADIUS_MAX = 1000;
const RADIUS_STEP = 25;
/** Comfortable walking pace, in metres per minute. */
const WALK_METRES_PER_MINUTE = 80;

type Draft = {
  id: string | null;
  originalLabel: string | null;
  label: string;
  latitude: string;
  longitude: string;
  address: string;
  radiusMeters: number;
};

const blankDraft = (): Draft => ({
  id: null,
  originalLabel: null,
  label: '',
  latitude: '',
  longitude: '',
  address: '',
  radiusMeters: 150,
});

const toDraft = (place: SavedPlace): Draft => ({
  id: place.id,
  originalLabel: place.label,
  label: place.label,
  latitude: String(place.latitude),
  longitude: String(place.longitude),
  address: place.address ?? '',
  radiusMeters: place.radiusMeters,
});

/** "about a 4 minute walk across" — a radius in metres means nothing on foot. */
function describeRadius(radiusMeters: number): string {
  const minutes = Math.max(1, Math.round((radiusMeters * 2) / WALK_METRES_PER_MINUTE));
  return `${radiusMeters * 2} m across the middle — about a ${minutes} minute walk`;
}

export default function PlacesScreen() {
  const { spacing } = useTheme();
  const [draft, setDraft] = useState<Draft | null>(null);

  const places = usePlaces();
  const triggers = useGeofenceTriggers();
  const status = useGeofenceStatus();

  const rows = places.data ?? [];
  const allTriggers = triggers.data ?? [];

  const triggerCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const trigger of allTriggers) {
      if (!trigger.placeId) continue;
      counts.set(trigger.placeId, (counts.get(trigger.placeId) ?? 0) + 1);
    }
    return counts;
  }, [allTriggers]);

  const live = useMemo(
    () => allTriggers.filter((trigger) => isLive(trigger)),
    [allTriggers],
  );
  const overCap = (status.data?.dropped ?? Math.max(0, live.length - MAX_MONITORED_REGIONS)) > 0;

  return (
    <Screen
      title="Places"
      subtitle={
        rows.length > 0 ? `${countLabel(rows.length, 'place')} · ${countLabel(live.length, 'reminder')}` : undefined
      }
      right={
        <Button icon="add" label="Add" size="sm" variant="primary" onPress={() => setDraft(blankDraft())} />
      }
    >
      <ErrorBoundary label="places: list">
        <Section title="Saved places">
          {places.isLoading && rows.length === 0 ? (
            <ListSkeleton rows={3} />
          ) : places.isError ? (
            <RetryCard message="Could not load your places." onRetry={() => places.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon="location-outline"
              title="No places yet"
              hint="Try: 'remind me to buy milk when I get to the supermarket' — then pin it here."
            />
          ) : (
            <Card padded={false}>
              {rows.map((place, index) => (
                <View key={place.id}>
                  {index > 0 ? <Divider inset={spacing.lg} /> : null}
                  <PlaceRow
                    place={place}
                    triggers={triggerCounts.get(place.id) ?? 0}
                    onPress={() => setDraft(toDraft(place))}
                  />
                </View>
              ))}
            </Card>
          )}
        </Section>
      </ErrorBoundary>

      <ErrorBoundary label="places: reminders">
        <Section
          title="Location reminders"
          right={
            status.data ? (
              <Txt variant="micro" tone="tertiary">
                {status.data.monitored} watched by the OS
              </Txt>
            ) : null
          }
        >
          {overCap ? <CapWarning live={live.length} watched={status.data?.monitored ?? 0} /> : null}
          {triggers.isLoading && allTriggers.length === 0 ? (
            <ListSkeleton rows={2} />
          ) : triggers.isError ? (
            <RetryCard message="Could not load your reminders." onRetry={() => triggers.refetch()} />
          ) : live.length === 0 ? (
            <EmptyState
              icon="notifications-outline"
              title="No active reminders"
              hint="Try: 'when I leave the office remind me to call Dad'"
            />
          ) : (
            <Card padded={false}>
              {live.map((trigger, index) => (
                <View key={trigger.id}>
                  {index > 0 ? <Divider inset={spacing.lg} /> : null}
                  <TriggerRow trigger={trigger} />
                </View>
              ))}
            </Card>
          )}
        </Section>
      </ErrorBoundary>

      {draft ? (
        <PlaceSheet
          draft={draft}
          onChange={(update) => setDraft((previous) => (previous ? update(previous) : previous))}
          onClose={() => setDraft(null)}
        />
      ) : null}
    </Screen>
  );
}

/** Mirrors the service's own rule so the list and the OS agree on what is live. */
function isLive(trigger: GeofenceTrigger, at = now()): boolean {
  if (!(trigger.isActive ?? true)) return false;
  if (trigger.expiresAt !== null && at >= trigger.expiresAt) return false;
  return !(trigger.oneShot && trigger.lastTriggeredAt !== null);
}

/* -------------------------------------------------------------- place row */

function PlaceRow({
  place,
  triggers,
  onPress,
}: {
  place: SavedPlace;
  triggers: number;
  onPress: () => void;
}) {
  const { colors, spacing } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Edit ${place.label}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { paddingHorizontal: spacing.md, opacity: pressed ? 0.6 : 1 }]}
    >
      <Ionicons name="location" size={18} color={colors.accent} />
      <View style={{ flex: 1, gap: 1 }}>
        <Txt variant="bodyStrong">{place.label}</Txt>
        <Txt variant="caption" tone="tertiary" numberOfLines={1}>
          {place.address ?? `${place.latitude.toFixed(4)}, ${place.longitude.toFixed(4)}`}
        </Txt>
        <Txt variant="micro" tone="tertiary">
          {place.radiusMeters} m
          {triggers > 0 ? ` · ${countLabel(triggers, 'reminder')} here` : ''}
        </Txt>
      </View>
      <Ionicons name="chevron-forward" size={15} color={colors.textTertiary} />
    </Pressable>
  );
}

/* ------------------------------------------------------------ trigger row */

function TriggerRow({ trigger }: { trigger: GeofenceTrigger }) {
  const { colors, spacing } = useTheme();
  const toast = useToast();
  const deactivate = useDeactivateGeofenceTrigger();
  const remove = useDeleteGeofenceTrigger();
  // The row disappearing from the list is not the same as the OS letting the
  // region go: without this the phone keeps watching a reminder the user just
  // switched off, and fires it on the next crossing.
  const refreshRegions = useRefreshGeofences();
  const rearm = () => refreshRegions.mutate();

  return (
    <View style={[styles.row, { paddingHorizontal: spacing.md }]}>
      <Ionicons
        name={trigger.triggerType === 'ENTER' ? 'enter-outline' : 'exit-outline'}
        size={18}
        color={trigger.registered ? colors.success : colors.textTertiary}
      />
      <View style={{ flex: 1, gap: 1 }}>
        <Txt variant="body" numberOfLines={2}>
          {trigger.actionDescription}
        </Txt>
        <Txt variant="caption" tone="tertiary" numberOfLines={1}>
          {trigger.triggerType === 'ENTER' ? 'Arriving at' : 'Leaving'} {trigger.label}
        </Txt>
        {trigger.lastTriggeredAt ? (
          <Txt variant="micro" tone="tertiary">
            Last fired {formatRelative(trigger.lastTriggeredAt)}
          </Txt>
        ) : null}
      </View>
      <Badge
        label={trigger.registered ? 'WATCHING' : 'QUEUED'}
        tone={trigger.registered ? 'success' : 'warning'}
      />
      {/* 17pt glyphs centred in a 44pt box: these two sit next to each other and
          one is destructive, so the target has to be the full minimum. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Switch off the reminder at ${trigger.label}`}
        style={({ pressed }) => [styles.iconButton, { opacity: pressed ? 0.6 : 1 }]}
        onPress={() =>
          deactivate.mutate(trigger.id, {
            onSuccess: () => {
              rearm();
              toast.show({ message: 'Reminder switched off', tone: 'neutral' });
            },
            onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
          })
        }
      >
        <Ionicons name="power" size={17} color={colors.textSecondary} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Delete the reminder at ${trigger.label}`}
        style={({ pressed }) => [styles.iconButton, { opacity: pressed ? 0.6 : 1 }]}
        onPress={() =>
          remove.mutate(trigger.id, {
            onSuccess: () => {
              rearm();
              toast.show({ message: 'Reminder deleted', tone: 'neutral' });
            },
            onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
          })
        }
      >
        <Ionicons name="trash-outline" size={17} color={colors.danger} />
      </Pressable>
    </View>
  );
}

function CapWarning({ live, watched }: { live: number; watched: number }) {
  const { colors } = useTheme();
  return (
    <Card accent={colors.warning} style={{ gap: 4 }}>
      <Txt variant="bodyStrong" tone="warning">
        {live - watched} of {live} reminders are not being watched
      </Txt>
      <Txt variant="caption" tone="secondary">
        iOS lets an app monitor {MAX_MONITORED_REGIONS} regions at once. Ridik keeps the ones that
        have never fired, then the soonest to expire, then the nearest — the rest wait their turn.
        Switch off the ones you no longer need.
      </Txt>
    </Card>
  );
}

/* ----------------------------------------------------------- place editor */

function PlaceSheet({
  draft,
  onChange,
  onClose,
}: {
  draft: Draft;
  /**
   * An updater, never a value. The reverse geocode below lands a beat after the
   * fix that triggered it, and a callback holding `{...draft}` from its own
   * render would put the old, empty coordinates back over the ones it was
   * looking up.
   */
  onChange: (update: (previous: Draft) => Draft) => void;
  onClose: () => void;
}) {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const upsert = useUpsertPlace();
  const removePlace = useDeletePlace();
  const locate = useCurrentPosition();
  const geocode = useReverseGeocode();
  // A pin that moved is a region in the wrong place until the OS is told.
  const refreshRegions = useRefreshGeofences();

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    onChange((previous) => ({ ...previous, [key]: value }));

  const latitude = Number(draft.latitude);
  const longitude = Number(draft.longitude);
  const labelError = draft.label.trim() ? null : 'A place needs a name.';
  const latError =
    draft.latitude.trim() && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
      ? null
      : 'Latitude runs from −90 to 90.';
  const lonError =
    draft.longitude.trim() && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
      ? null
      : 'Longitude runs from −180 to 180.';
  const invalid = Boolean(labelError || latError || lonError);

  const renamed =
    draft.originalLabel !== null &&
    draft.label.trim().toLowerCase() !== draft.originalLabel.toLowerCase();

  const useMyLocation = () => {
    locate.mutate(undefined, {
      onSuccess: (coords) => {
        onChange((previous) => ({
          ...previous,
          latitude: coords.latitude.toFixed(6),
          longitude: coords.longitude.toFixed(6),
        }));
        // The address is a nicety; a failed lookup must not cost the pin.
        geocode.mutate(coords, {
          onSuccess: (address) => {
            if (address) set('address', address);
          },
        });
      },
      onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
    });
  };

  const lookUpAddress = () => {
    if (latError || lonError) return;
    geocode.mutate(
      { latitude, longitude },
      {
        onSuccess: (address) =>
          address
            ? set('address', address)
            : toast.show({ message: 'No address at those coordinates', tone: 'neutral' }),
        onError: (error) => toast.show({ message: error.message, tone: 'warning' }),
      },
    );
  };

  const save = () => {
    if (invalid) return;
    upsert.mutate(
      {
        label: draft.label.trim(),
        latitude,
        longitude,
        radiusMeters: draft.radiusMeters,
        address: draft.address.trim() || null,
      },
      {
        onSuccess: () => {
          // `upsertPlace` keys on the label, so a rename inserts rather than
          // renames; the row that used to hold this pin has to go by hand.
          // Reminders already made keep their own coordinates, so none of them
          // move — they only lose the link back to the place.
          if (renamed && draft.id) removePlace.mutate(draft.id);
          refreshRegions.mutate();
          toast.show({ message: 'Place saved', tone: 'success' });
          onClose();
        },
        onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
      },
    );
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={[styles.backdrop, { backgroundColor: colors.overlay }]}
        onPress={onClose}
      />
      <View
        style={[
          styles.sheet,
          {
            backgroundColor: colors.surface,
            borderColor: colors.border,
            borderTopLeftRadius: radius.xl,
            borderTopRightRadius: radius.xl,
          },
        ]}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            padding: spacing.lg,
            // Delete lives at the bottom of this sheet; the home indicator must
            // not sit on top of it.
            paddingBottom: insets.bottom + spacing.lg,
            gap: spacing.md,
          }}
        >
          <View style={styles.sheetHead}>
            <Txt variant="heading">{draft.id ? 'Edit place' : 'New place'}</Txt>
            <Button icon="close" size="sm" variant="ghost" accessibilityLabel="Close" onPress={onClose} />
          </View>

          <Input
            label="Name"
            value={draft.label}
            onChangeText={(text) => set('label', text)}
            placeholder="the lab"
            autoFocus={!draft.id}
            error={draft.label.length > 0 ? (labelError ?? undefined) : undefined}
          />
          {renamed ? (
            <Txt variant="micro" tone="warning">
              Renaming replaces the old pin. Reminders you already made keep firing at their own
              coordinates.
            </Txt>
          ) : null}

          <Button
            label="Use my current location"
            icon="navigate-outline"
            variant="secondary"
            fullWidth
            loading={locate.isPending}
            onPress={useMyLocation}
          />

          <View style={{ flexDirection: 'row', gap: spacing.md }}>
            <Input
              label="Latitude"
              containerStyle={{ flex: 1 }}
              value={draft.latitude}
              onChangeText={(text) => set('latitude', text)}
              placeholder="42.6977"
              keyboardType="numbers-and-punctuation"
              error={draft.latitude.length > 0 ? (latError ?? undefined) : undefined}
            />
            <Input
              label="Longitude"
              containerStyle={{ flex: 1 }}
              value={draft.longitude}
              onChangeText={(text) => set('longitude', text)}
              placeholder="23.3219"
              keyboardType="numbers-and-punctuation"
              error={draft.longitude.length > 0 ? (lonError ?? undefined) : undefined}
            />
          </View>

          <Input
            label="Address"
            value={draft.address}
            onChangeText={(text) => set('address', text)}
            placeholder="Looked up from the coordinates"
          />
          <Button
            label="Look up address"
            icon="search-outline"
            size="sm"
            variant="ghost"
            disabled={Boolean(latError || lonError)}
            loading={geocode.isPending}
            onPress={lookUpAddress}
          />

          <View style={{ gap: spacing.sm }}>
            <Txt variant="micro" tone="tertiary" style={{ letterSpacing: 0.6 }}>
              RADIUS
            </Txt>
            <View style={styles.stepper}>
              <Button
                icon="remove"
                size="md"
                accessibilityLabel="Smaller radius"
                disabled={draft.radiusMeters <= RADIUS_MIN}
                onPress={() => set('radiusMeters', Math.max(RADIUS_MIN, draft.radiusMeters - RADIUS_STEP))}
              />
              <Txt variant="mono" tone="accent" style={{ flex: 1, textAlign: 'center' }}>
                {draft.radiusMeters} m
              </Txt>
              <Button
                icon="add"
                size="md"
                accessibilityLabel="Larger radius"
                disabled={draft.radiusMeters >= RADIUS_MAX}
                onPress={() => set('radiusMeters', Math.min(RADIUS_MAX, draft.radiusMeters + RADIUS_STEP))}
              />
            </View>
            <Txt variant="micro" tone="tertiary">
              {describeRadius(draft.radiusMeters)}. Under about 100 m a phone often misses the
              crossing entirely.
            </Txt>
          </View>

          <View style={styles.actions}>
            <Button
              label={draft.id ? 'Save place' : 'Add place'}
              variant="primary"
              disabled={invalid}
              loading={upsert.isPending}
              onPress={save}
            />
            {draft.id ? (
              <Button
                label="Delete"
                variant="danger"
                loading={removePlace.isPending}
                onPress={() =>
                  removePlace.mutate(draft.id!, {
                    onSuccess: () => {
                      refreshRegions.mutate();
                      toast.show({ message: 'Place deleted', tone: 'neutral' });
                      onClose();
                    },
                    onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
                  })
                }
              />
            ) : null}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

/* --------------------------------------------------------------- fallback */

function ListSkeleton({ rows }: { rows: number }) {
  const { colors, radius, spacing } = useTheme();
  return (
    <Card padded={false}>
      {Array.from({ length: rows }, (_, index) => (
        <View key={index} style={{ padding: spacing.md, gap: 6 }}>
          <View
            style={{ height: 12, width: '40%', borderRadius: radius.sm, backgroundColor: colors.surfaceSunken }}
          />
          <View
            style={{ height: 10, width: '65%', borderRadius: radius.sm, backgroundColor: colors.surfaceSunken }}
          />
        </View>
      ))}
    </Card>
  );
}

function RetryCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Txt variant="caption" tone="danger" style={{ flex: 1 }}>
          {message}
        </Txt>
        <Button label="Retry" size="sm" variant="ghost" onPress={onRetry} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, minHeight: 48 },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '88%',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
});
