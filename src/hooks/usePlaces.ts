/**
 * Saved places and the location reminders anchored to them.
 *
 * One file because they are one screen and one write path: a trigger is created
 * by naming a place, and moving or deleting a pin changes which regions the OS
 * should be watching. `listActiveTriggers` already applies the iOS 20-region
 * budget, so the "active" query is what the registration service should read.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { unwrap } from '@/core/result';
import type { GeofenceTrigger, SavedPlace } from '@/db/schema';
import { getRepositories } from '@/repositories';
import type {
  CreateTriggerForPlaceInput,
  CreateTriggerInput,
  TriggerOutcome,
} from '@/repositories/geofences';
import type { Coords, PlaceInput } from '@/repositories/places';

import { invalidateKeys, qk } from './keys';

/** A moved pin changes the regions monitored for it. */
const PLACE_WRITE_KEYS = [qk.places.all, qk.geofences.all] as const;
const TRIGGER_WRITE_KEYS = [qk.geofences.all] as const;

/* ------------------------------------------------------------------ places */

export function usePlaces(): UseQueryResult<SavedPlace[]> {
  return useQuery({
    queryKey: qk.places.list(),
    queryFn: () => getRepositories().places.listPlaces(),
  });
}

export function usePlace(
  id: string | undefined,
  options: { enabled?: boolean } = {},
): UseQueryResult<SavedPlace | null> {
  return useQuery({
    queryKey: qk.places.detail(id ?? ''),
    queryFn: () => getRepositories().places.getPlace(id!),
    enabled: (options.enabled ?? true) && Boolean(id),
  });
}

/** Saving a name that already exists moves the pin rather than forking it. */
export function useUpsertPlace(): UseMutationResult<SavedPlace, Error, PlaceInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: PlaceInput) => getRepositories().places.upsertPlace(input),
    onSettled: () => invalidateKeys(client, PLACE_WRITE_KEYS),
  });
}

export function useDeletePlace(): UseMutationResult<boolean, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getRepositories().places.deletePlace(id),
    onSettled: () => invalidateKeys(client, PLACE_WRITE_KEYS),
  });
}

export function useResolvePlace(): UseMutationResult<SavedPlace, Error, string> {
  return useMutation({
    mutationFn: async (query: string) =>
      unwrap(await getRepositories().places.resolvePlace(query)),
  });
}

/* -------------------------------------------------------------- geofences */

export function useGeofenceTriggers(): UseQueryResult<GeofenceTrigger[]> {
  return useQuery({
    queryKey: qk.geofences.list(),
    queryFn: () => getRepositories().geofences.listAllTriggers(),
  });
}

/**
 * The set worth handing the OS — live, unexpired, and never more than 20.
 * `currentLocation` only reorders the shortlist, so it stays out of the key.
 */
export function useActiveGeofenceTriggers(
  options: { currentLocation?: Coords; enabled?: boolean } = {},
): UseQueryResult<GeofenceTrigger[]> {
  return useQuery({
    queryKey: qk.geofences.active(),
    queryFn: () =>
      getRepositories().geofences.listActiveTriggers({
        currentLocation: options.currentLocation,
      }),
    enabled: options.enabled ?? true,
  });
}

export function useGeofenceTrigger(
  id: string | undefined,
  options: { enabled?: boolean } = {},
): UseQueryResult<GeofenceTrigger | null> {
  return useQuery({
    queryKey: qk.geofences.detail(id ?? ''),
    queryFn: () => getRepositories().geofences.getTrigger(id!),
    enabled: (options.enabled ?? true) && Boolean(id),
  });
}

export function useCreateGeofenceTrigger(): UseMutationResult<
  GeofenceTrigger,
  Error,
  CreateTriggerInput
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTriggerInput) => getRepositories().geofences.createTrigger(input),
    onSettled: () => invalidateKeys(client, TRIGGER_WRITE_KEYS),
  });
}

/** The voice path: the user names a place instead of giving coordinates. */
export function useCreateGeofenceTriggerForPlace(): UseMutationResult<
  GeofenceTrigger,
  Error,
  CreateTriggerForPlaceInput
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateTriggerForPlaceInput) =>
      unwrap(await getRepositories().geofences.createTriggerForPlace(input)),
    onSettled: () => invalidateKeys(client, TRIGGER_WRITE_KEYS),
  });
}

export function useRecordGeofenceTrigger(): UseMutationResult<
  TriggerOutcome,
  Error,
  { id: string; at?: number }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; at?: number }) =>
      unwrap(await getRepositories().geofences.recordTrigger(input.id, input.at)),
    onSettled: () => invalidateKeys(client, TRIGGER_WRITE_KEYS),
  });
}

export function useDeactivateGeofenceTrigger(): UseMutationResult<boolean, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getRepositories().geofences.deactivateTrigger(id),
    onSettled: () => invalidateKeys(client, TRIGGER_WRITE_KEYS),
  });
}

export function useDeleteGeofenceTrigger(): UseMutationResult<boolean, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getRepositories().geofences.deleteTrigger(id),
    onSettled: () => invalidateKeys(client, TRIGGER_WRITE_KEYS),
  });
}
