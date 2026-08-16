/**
 * Nothing in the app may lower the free trial's counters, and nothing may reach
 * the developer screen without the switch that screen exists behind.
 *
 * Both of these shipped. The developer screen carried a literal Reset button
 * that wrote `llmTrialRequestsUsed = 0` — one tap, unlimited repeats — and it
 * read `developerMode` only to decide whether to draw its own "Hide" row, so
 * `ridik:///developer` rendered the whole screen for anybody with a deep link
 * and no seven-tap ritual at all. Worse, the button was hidden on hosted builds
 * and shown everywhere else, which is precisely inverted: the configuration
 * where the trial is the only thing between a free user and the operator's key
 * is the one that had the button.
 *
 * The counter is monotonic by design. A control that lowers it is not a bug in
 * one screen, it is a category of bug, so this reads the source — the same
 * crude technique and the same reason as `boundary.test.ts` and
 * `ui/__tests__/modal-surfaces.test.ts`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { PRESERVED_SETTINGS } from '@/db/wipe';
import { isSettingKey } from '@/repositories/settings';

const ROOT = join(__dirname, '..', '..', '..', '..');

/** Every screen and component in the app, as `[path, source]`. */
function sources(): [string, string][] {
  const found: [string, string][] = [];
  const skip = new Set(['node_modules', 'android', 'ios', 'dist', '.git', '__tests__']);

  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(rel);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      found.push([rel, readFileSync(join(ROOT, rel), 'utf8')]);
    }
  };

  walk('app');
  walk('src');
  return found;
}

const TRIAL_KEYS = ['llmTrialRequestsUsed', 'llmTrialTokensUsed', 'llmCreditsUsed'] as const;

describe('the trial counters', () => {
  /* `settings.bump` only ever adds, and `readTrialLedger` heals upwards from
     the durable copy. A plain `.set(...)` of a trial key is how the counter
     goes down, so the two places allowed to write one at all are named. */
  const MAY_WRITE = new Set([
    join('src', 'services', 'billing', 'trialLedger.ts'),
    // The same rule for the paid balance, in its own ledger: only the file that
    // owns a lifetime counter may write one, and it only heals upwards.
    join('src', 'services', 'billing', 'creditsLedger.ts'),
    join('src', 'repositories', 'settings.ts'),
  ]);

  it.each(TRIAL_KEYS)('is never assigned a value outside the ledger (%s)', (key) => {
    const offenders = sources()
      .filter(([path]) => !MAY_WRITE.has(path))
      .filter(([, source]) => new RegExp(`set\\(\\s*['"\`]${key}['"\`]`).test(source))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  /* The exact shape of the button that shipped: a `useSetting` handle for a
     trial key with `.set(` called on it. */
  it.each(TRIAL_KEYS)('has no control bound to it that can write zero (%s)', (key) => {
    const offenders = sources()
      .filter(([path]) => !MAY_WRITE.has(path))
      .filter(([, source]) => {
        const handle = new RegExp(`const\\s+(\\w+)\\s*=\\s*useSetting\\(['"\`]${key}['"\`]\\)`);
        const match = handle.exec(source);
        return match !== null && new RegExp(`\\b${match[1]}\\.set\\(`).test(source);
      })
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  /* And they survive the one button in the app that empties the database. */
  it('is on the list of rows an erase preserves', () => {
    for (const key of TRIAL_KEYS) expect(PRESERVED_SETTINGS).toContain(key);
    for (const key of PRESERVED_SETTINGS) expect(isSettingKey(key)).toBe(true);
  });
});

describe('the developer screen', () => {
  const screen = readFileSync(join(ROOT, 'app', 'developer.tsx'), 'utf8');

  /* A gesture is not a gate. The seven taps set `developerMode`; the switch is
     the state, so the switch is what the route has to check — expo-router will
     match a deep link straight past anything else. */
  it('sends anybody without developer mode away rather than rendering', () => {
    expect(screen).toMatch(/useSetting\(['"]developerMode['"]\)/);
    expect(screen).toMatch(/<Redirect\s/);
    expect(screen).toMatch(/!developer\.value/);
  });

  it('draws the trial as a read-out and offers no way to move it', () => {
    expect(screen).toContain('describeTrial');
    expect(screen).not.toMatch(/trialUsed\.set\(/);
  });
});
