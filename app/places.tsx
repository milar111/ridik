/**
 * Saved places and the reminders anchored to them.
 *
 * TODO(map): the brief asks for a map picker. `react-native-maps` is not in
 * this build and adding a native dependency is out of scope here, so a pin comes
 * from the phone's own fix and is described by its reverse-geocoded address.
 * Typed coordinates were the earlier stand-in and are gone: one wrong digit puts
 * a geofence in another country, and without a map there is nothing to catch it
 * against. Swap this block for a `<MapView>` with a draggable pin and a
 * `<Circle>` bound to `radiusMeters` once the dependency lands; nothing else on
 * this screen has to change.
 */
import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
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
  useGeocodeAddress,
  useRequestPermission,
  useReverseGeocode,
} from '@/hooks/useSystem';
import type { GeofenceTrigger, SavedPlace } from '@/db/schema';
import { MAX_MONITORED_REGIONS } from '@/repositories/geofences';
import type { Coords } from '@/repositories/places';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { useTheme } from '@/ui/ThemeProvider';
import { Badge, Button, Card, Chip, Divider, EmptyState, Input, Screen, Section, SheetCard, Txt, useToast } from '@/ui/components';

/**
 * Named sizes, not a stepper. Nobody can tell 425 m from 450 m on the ground,
 * and every value the stepper could reach below ~100 m is one a phone misses.
 */
const RADIUS_CHOICES = [
  { label: 'Right here', meters: 150 },
  { label: 'This building', meters: 300 },
  { label: 'This block', meters: 600 },
] as const;

/** Comfortable walking pace, in metres per minute. */
const WALK_METRES_PER_MINUTE = 80;

type Draft = {
  id: string | null;
  label: string;
  coords: Coords | null;
  address: string;
  radiusMeters: number;
};

const blankDraft = (): Draft => ({
  id: null,
  label: '',
  coords: null,
  address: '',
  radiusMeters: RADIUS_CHOICES[0].meters,
});

const toDraft = (place: SavedPlace): Draft => ({
  id: place.id,
  label: place.label,
  coords: { latitude: place.latitude, longitude: place.longitude },
  address: place.address ?? '',
  // Kept exactly as stored, even when no chip matches it. `place_save` lets the
  // voice path set anything from 50 m to 5 km, and snapping to the nearest name
  // would show "This block" over a 2 km circle and then shrink it for real on
  // the next save — a save the user made to move the pin, not to resize it.
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
  // A missing permission stops every region, so it is checked before the cap:
  // otherwise a user with one reminder and no "Always" access is told to switch
  // off the reminders they no longer need, of which they have none.
  const blockedByPermission = live.length > 0 && status.data?.permission.granted === false;
  const overCap =
    !blockedByPermission &&
    (status.data?.dropped ?? Math.max(0, live.length - MAX_MONITORED_REGIONS)) > 0;

  return (
    <Screen
      back
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
          {/* Permission first: when the OS is watching nothing at all, the cap
              is not what is wrong, and only one of these two is ever true. */}
          {blockedByPermission ? (
            <PermissionWarning live={live.length} canAsk={status.data?.permission.canAskAgain ?? false} />
          ) : overCap ? (
            <CapWarning live={live.length} watched={status.data?.monitored ?? 0} />
          ) : null}
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
  const [confirming, setConfirming] = useState(false);

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
        {confirming ? (
          <Txt variant="caption" tone="danger" numberOfLines={1}>
            Delete this reminder for good?
          </Txt>
        ) : (
          <Txt variant="caption" tone="tertiary" numberOfLines={1}>
            {trigger.triggerType === 'ENTER' ? 'Arriving at' : 'Leaving'} {trigger.label}
          </Txt>
        )}
        {trigger.lastTriggeredAt && !confirming ? (
          <Txt variant="micro" tone="tertiary">
            Last fired {formatRelative(trigger.lastTriggeredAt)}
          </Txt>
        ) : null}
      </View>
      {confirming ? (
        <>
          <Button
            label="Delete"
            size="sm"
            variant="danger"
            loading={remove.isPending}
            accessibilityLabel={`Yes, delete the reminder at ${trigger.label}`}
            onPress={() =>
              remove.mutate(trigger.id, {
                onSuccess: () => {
                  rearm();
                  toast.show({ message: 'Reminder deleted', tone: 'neutral' });
                },
                onError: (error) => {
                  setConfirming(false);
                  toast.show({ message: error.message, tone: 'danger' });
                },
              })
            }
          />
          <Button label="Keep" size="sm" variant="ghost" onPress={() => setConfirming(false)} />
        </>
      ) : (
        <>
          <Badge
            label={trigger.registered ? 'WATCHING' : 'QUEUED'}
            tone={trigger.registered ? 'success' : 'warning'}
          />
          {/* 17pt glyphs centred in a 44pt box: these two sit next to each other
              and one is destructive, so the target has to be the full minimum. */}
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
            onPress={() => setConfirming(true)}
          >
            <Ionicons name="trash-outline" size={17} color={colors.danger} />
          </Pressable>
        </>
      )}
    </View>
  );
}

/**
 * Nothing is being watched because the OS will not let it be — not because
 * Ridik ran out of room. Saying "the rest wait their turn" here would send a
 * user to prune reminders that were never the problem.
 */
function PermissionWarning({ live, canAsk }: { live: number; canAsk: boolean }) {
  const { colors } = useTheme();
  const request = useRequestPermission();
  return (
    <Card accent={colors.warning} style={{ gap: 8 }}>
      <Txt variant="bodyStrong" tone="warning">
        {countLabel(live, 'reminder')} waiting on location access
      </Txt>
      <Txt variant="caption" tone="secondary">
        A place reminder has to be watched while Ridik is closed, which needs
        location set to "Always". Until then nothing here will fire.
      </Txt>
      {canAsk ? (
        <Button
          label="Allow always"
          size="sm"
          variant="secondary"
          loading={request.isPending}
          onPress={() => request.mutate('location')}
        />
      ) : (
        <Button
          label="Open settings"
          size="sm"
          variant="secondary"
          onPress={() => void Linking.openSettings()}
        />
      )}
    </Card>
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
        Ridik watches {MAX_MONITORED_REGIONS} places at a time — the most a phone will track
        reliably. It keeps the ones that have never fired, then the soonest to expire, then the
        nearest; the rest wait their turn. Switch off the ones you no longer need.
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
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [search, setSearch] = useState('');
  const addressSearch = useGeocodeAddress();

  const runSearch = () => {
    addressSearch.mutate(search, {
      onSuccess: (found) => {
        if (!found) {
          toast.show({ message: 'No place found by that name.', tone: 'warning' });
          return;
        }
        onChange((previous) => ({ ...previous, coords: found.coords, address: found.address }));
        setSearch('');
      },
      onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
    });
  };

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    onChange((previous) => ({ ...previous, [key]: value }));

  const coords = draft.coords;
  const labelError = draft.label.trim() ? null : 'A place needs a name.';
  const invalid = Boolean(labelError) || coords === null;

  const useMyLocation = () => {
    locate.mutate(undefined, {
      onSuccess: (fix) => {
        // The old address described the old pin, and there is no longer a field
        // to correct it in: it goes with the pin that earned it, so a lookup
        // that fails leaves coordinates on screen rather than the wrong street.
        onChange((previous) => ({ ...previous, coords: fix, address: '' }));
        // The address is a nicety; a failed lookup must not cost the pin.
        geocode.mutate(fix, {
          onSuccess: (address) => {
            if (address) set('address', address);
          },
        });
      },
      onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
    });
  };

  const save = () => {
    if (invalid || !coords) return;
    upsert.mutate(
      {
        label: draft.label.trim(),
        latitude: coords.latitude,
        longitude: coords.longitude,
        radiusMeters: draft.radiusMeters,
        address: draft.address.trim() || null,
      },
      {
        onSuccess: () => {
          refreshRegions.mutate();
          toast.show({ message: 'Place saved', tone: 'success' });
          onClose();
        },
        onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
      },
    );
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={[styles.backdrop, { backgroundColor: colors.overlay }]}
        onPress={onClose}
      />
      {/* A Modal is its own window on Android, so the activity's adjustResize
          never reaches it and the keyboard covered the address field it had
          just opened for. */}
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

          {draft.id ? (
            <View style={{ gap: 2 }}>
              <Txt variant="micro" tone="tertiary" style={{ letterSpacing: 0.6 }}>
                NAME
              </Txt>
              <Txt variant="bodyStrong">{draft.label}</Txt>
              <Txt variant="micro" tone="tertiary">
                Reminders are anchored to this name, so it cannot be changed here. Add the place
                again under the name you want, then delete this one.
              </Txt>
            </View>
          ) : (
            <Input
              label="Name"
              testID="place-name"
              value={draft.label}
              onChangeText={(text) => set('label', text)}
              placeholder="the lab"
              autoFocus
              error={draft.label.length > 0 ? (labelError ?? undefined) : undefined}
            />
          )}

          <View style={{ gap: spacing.sm }}>
            <Txt variant="micro" tone="tertiary" style={{ letterSpacing: 0.6 }}>
              PIN
            </Txt>
            <Txt variant="caption" tone={coords ? 'secondary' : 'tertiary'}>
              {coords
                ? draft.address.trim() ||
                  `${coords.latitude.toFixed(4)}, ${coords.longitude.toFixed(4)}`
                : 'Not pinned yet.'}
            </Txt>
            <Button
              label="Use my current location"
              icon="navigate-outline"
              variant="secondary"
              fullWidth
              loading={locate.isPending}
              onPress={useMyLocation}
            />
            {/*
              The other half of pinning: you are rarely standing in the place
              you want to be reminded about. An address is something a person
              can read back and check, which is exactly what a latitude was not.
            */}
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm }}>
              <Input
                containerStyle={{ flex: 1 }}
                label="Or search an address"
                testID="place-address-search"
                value={search}
                onChangeText={setSearch}
                placeholder="Technical University, Sofia"
                autoCapitalize="words"
                returnKeyType="search"
                onSubmitEditing={runSearch}
              />
              <Button
                label="Find"
                icon="search-outline"
                loading={addressSearch.isPending}
                disabled={search.trim().length === 0}
                onPress={runSearch}
              />
            </View>
          </View>

          {coords ? (
            <View style={{ gap: spacing.sm }}>
              <Txt variant="micro" tone="tertiary" style={{ letterSpacing: 0.6 }}>
                SIZE
              </Txt>
              <View style={styles.choices}>
                {RADIUS_CHOICES.map((choice) => (
                  <Chip
                    key={choice.meters}
                    label={`${choice.label} · ${choice.meters} m`}
                    selected={draft.radiusMeters === choice.meters}
                    onPress={() => set('radiusMeters', choice.meters)}
                  />
                ))}
              </View>
              <Txt variant="micro" tone="tertiary">
                {describeRadius(draft.radiusMeters)}.
              </Txt>
            </View>
          ) : null}

          {confirmingDelete ? (
            <View style={{ gap: spacing.sm }}>
              <Txt variant="caption" tone="secondary">
                Delete “{draft.label}”? Reminders you set here keep firing at their own coordinates,
                but nothing points at this pin any more.
              </Txt>
              <View style={styles.actions}>
                <Button
                  label="Delete"
                  variant="danger"
                  icon="trash-outline"
                  loading={removePlace.isPending}
                  onPress={() =>
                    removePlace.mutate(draft.id!, {
                      onSuccess: () => {
                        refreshRegions.mutate();
                        toast.show({ message: 'Place deleted', tone: 'neutral' });
                        onClose();
                      },
                      onError: (error) => {
                        setConfirmingDelete(false);
                        toast.show({ message: error.message, tone: 'danger' });
                      },
                    })
                  }
                />
                <Button label="Keep" variant="ghost" onPress={() => setConfirmingDelete(false)} />
              </View>
            </View>
          ) : (
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
                  icon="trash-outline"
                  onPress={() => setConfirmingDelete(true)}
                />
              ) : null}
            </View>
          )}
        </ScrollView>
      </SheetCard>
      </KeyboardAvoidingView>
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
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
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
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
});
