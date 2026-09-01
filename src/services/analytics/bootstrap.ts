/**
 * Where the ledger joins the app: one bootstrap step and two AppState hooks.
 *
 * Registered as a **non-critical** step, so every failure in here degrades to
 * "the operator learns nothing" and never to "the app did not start". That
 * ordering is the whole design: `AGENTS.md` is emphatic that a launch must
 * mount its navigator on the first render, and a counter is the last thing
 * that should ever be between a person and their microphone.
 *
 * The step does three things and none of them can throw out of this file:
 *
 * 1. Stamps `installedAt` once, so `app_open` can report an age *bucket*
 *    without anything storing a date that travels.
 * 2. Records `app_open`.
 * 3. Starts crash reporting, but only if the person has switched it on — see
 *    `crash.ts` for why that is deliberately late.
 *
 * The AppState listener flushes on background (the reliable moment: the app is
 * about to stop being scheduled) and on a foreground that is more than an hour
 * old. `services/notifications/push.ts` does the same dance for the same
 * reason and is the model for it.
 */
import { AppState, type AppStateStatus } from 'react-native';

import { now } from '@/core/clock';
import { createLogger } from '@/core/logger';
import { getRepositories } from '@/repositories';
import { registerBootstrapStep } from '@/startup/bootstrap';

import { initialiseCrashReporting } from './crash';
import { installAge } from './events';
import { track } from './index';
import { flush, isUploadConfigured } from './upload';

const log = createLogger('analytics');

const DAY_MS = 86_400_000;

let listening = false;

/** Whole days between the install stamp and now, floored at zero. */
function ageInDays(installedAt: number | null, at: number): number {
  if (installedAt === null || installedAt > at) return 0;
  return Math.floor((at - installedAt) / DAY_MS);
}

function listen(): void {
  if (listening) return;
  listening = true;

  AppState.addEventListener('change', (state: AppStateStatus) => {
    // `inactive` is iOS's transitional state — the app switcher, a phone call,
    // Control Centre pulled down — and firing on it would flush several times
    // for one departure.
    if (state === 'background') void flush({ reason: 'background' });
    else if (state === 'active') void flush({ reason: 'foreground' });
  });
}

registerBootstrapStep({
  name: 'analytics',
  run: async () => {
    const settings = getRepositories().settings;

    const at = now();
    let installedAt = await settings.get('installedAt');
    if (installedAt === null) {
      installedAt = at;
      // Once, and never rewritten: a stamp that moved would make every age
      // bucket derived from it wrong in the same direction.
      await settings.set('installedAt', at);
    }

    track({
      name: 'app_open',
      props: { install_age: installAge(ageInDays(installedAt, at)) },
    });

    await initialiseCrashReporting();

    if (isUploadConfigured()) listen();
    else log.info('no backend configured; the ledger stays on this phone');
  },
});

export {};
