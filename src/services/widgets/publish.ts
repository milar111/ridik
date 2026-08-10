/**
 * Getting the snapshot out of the app and into the widget's process.
 *
 * A real home-screen widget needs native code on both platforms, and it is the
 * *transport* that needs it, not the data: an iOS widget reads a shared App
 * Group container, an Android one reads SharedPreferences, and JavaScript can
 * reach neither. So this is a capability-detected adapter in the same shape as
 * `focus/liveActivity.ts` — it looks for the module at runtime, uses it when it
 * is there, and is a well-behaved no-op when it is not.
 *
 * Everything above this file is finished and tested. What is missing is only:
 *
 *   iOS      a WidgetKit extension target (`@bacons/apple-targets` can generate
 *            one from this project without ejecting), an App Group shared by
 *            the app and the extension, and a Swift `TimelineProvider` that
 *            decodes `WidgetSnapshot` from the group's defaults. The same
 *            target unblocks Live Activities, which have been waiting on
 *            exactly this piece.
 *   Android  an `AppWidgetProvider` plus RemoteViews, or
 *            `react-native-android-widget`, which renders JSX to RemoteViews
 *            and would let the widget's face be written in this codebase.
 *
 * `isSupported()` starts returning true once one exists, and nothing here
 * changes. Until then the app publishes into a void, which costs nothing and
 * keeps the producing side honest — it runs on every real data change, so the
 * day the transport lands it is already being fed correct data.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

import { createLogger } from '@/core/logger';
import { widgetSnapshotChanged, type WidgetSnapshot } from './snapshot';

const log = createLogger('widgets');

type WidgetModule = {
  /** Writes the payload to the shared container and asks the OS to reload. */
  setSnapshot(json: string): Promise<void>;
};

const native = requireOptionalNativeModule<WidgetModule>('RidikWidgets');

/** True once a widget extension is compiled into the build. */
export function isSupported(): boolean {
  return native !== null;
}

/**
 * The last thing published, so an unchanged snapshot does not spend a reload.
 *
 * Process-local on purpose. It is a cache for rationing OS wake-ups, not a
 * record of anything — a cold start republishing once is correct, because the
 * widget may well have been showing yesterday while the process was dead.
 */
let lastPublished: WidgetSnapshot | null = null;

/**
 * Hand the widget a new face, if it has one and anything actually changed.
 *
 * Never throws: this is a garnish on every write path in the app, and a widget
 * that cannot be reached must not fail the task the user was actually doing.
 */
export async function publishWidgetSnapshot(snapshot: WidgetSnapshot): Promise<boolean> {
  if (!widgetSnapshotChanged(lastPublished, snapshot)) return false;
  lastPublished = snapshot;

  if (!native) return false;
  try {
    await native.setSnapshot(JSON.stringify(snapshot));
    return true;
  } catch (error) {
    log.warn('could not hand the snapshot to the widget', { error });
    return false;
  }
}

/** Test seam, and the reset a sign-out or a wipe should perform. */
export function forgetPublishedSnapshot(): void {
  lastPublished = null;
}
