import * as Crypto from 'expo-crypto';
import { setRandomSource } from '@/db/ids';
import { getClient, openDatabase } from '@/db';
import { createLogger } from '@/core/logger';
import { setZoneOverride, setClockFormat, isValidZone, type ClockFormat } from '@/core/time';

const log = createLogger('bootstrap');

// Runs at import time, before any screen can mint an id: React Native has no
// global WebCrypto and ids must never silently fall back to Math.random.
setRandomSource((bytes) => Crypto.getRandomValues(bytes));

export type BootstrapStep = {
  name: string;
  /** A failed critical step blocks the app; anything else degrades silently. */
  critical?: boolean;
  run: () => Promise<void> | void;
};

export type BootstrapResult = {
  ok: boolean;
  failures: { name: string; error: string; critical: boolean }[];
  durationMs: number;
};

const extraSteps: BootstrapStep[] = [];

/**
 * Lets feature modules (notifications, background tasks, geofence re-arming)
 * hook into startup without the root layout importing every one of them.
 */
export function registerBootstrapStep(step: BootstrapStep): void {
  if (!extraSteps.some((s) => s.name === step.name)) extraSteps.push(step);
}

let cached: BootstrapResult | null = null;

export async function bootstrap(): Promise<BootstrapResult> {
  if (cached) return cached;
  const startedAt = Date.now();
  const failures: BootstrapResult['failures'] = [];

  const steps: BootstrapStep[] = [
    {
      name: 'database',
      critical: true,
      run: () => {
        const { report } = openDatabase();
        log.info('database ready', report);
      },
    },
    {
      name: 'timezone',
      run: () => {
        // Read straight from the settings table: the zone must be in place
        // before any repository or query hook computes a "today" boundary, so
        // this step cannot wait on the repository layer being constructed.
        const row = getClient().getFirstSync<{ value: string }>(
          'SELECT value FROM app_settings WHERE key = ?',
          ['timezone'],
        );
        if (!row) return;
        const stored = JSON.parse(row.value) as unknown;
        if (typeof stored === 'string' && isValidZone(stored)) setZoneOverride(stored);
      },
    },
    {
      name: 'clock format',
      run: () => {
        // Same reasoning as the zone above, and the same direct read: a clock
        // column measures itself from this, so it has to be settled before the
        // first agenda row lays out rather than after a query resolves.
        const row = getClient().getFirstSync<{ value: string }>(
          'SELECT value FROM app_settings WHERE key = ?',
          ['clockFormat'],
        );
        if (!row) return;
        const stored = JSON.parse(row.value) as unknown;
        if (stored === 'auto' || stored === '12h' || stored === '24h') {
          setClockFormat(stored as ClockFormat);
        }
      },
    },
    ...extraSteps,
  ];

  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ name: step.name, error: message, critical: !!step.critical });
      log.error(`step "${step.name}" failed`, message);
    }
  }

  cached = {
    ok: !failures.some((f) => f.critical),
    failures,
    durationMs: Date.now() - startedAt,
  };
  return cached;
}

/** Test/recovery hook. */
export function resetBootstrap(): void {
  cached = null;
}
