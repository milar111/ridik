/**
 * Side-effect imports.
 *
 * Several services announce themselves to the bootstrap sequence at module
 * evaluation time (`registerBootstrapStep`). Nothing else imports them — the UI
 * reaches them through their facades — so without this barrel their steps would
 * never be registered and timers, geofences and background work would silently
 * never resume. Imported once, at the top of the root layout.
 */
import '@/services/focus';
import '@/services/geofence';
import '@/services/background';
import '@/features/voice/pipeline';

export {};
