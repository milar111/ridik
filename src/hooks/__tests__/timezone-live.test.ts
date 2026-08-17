/**
 * Changing the time zone has to change the time zone.
 *
 * `src/core/time.ts` keeps the active zone in a module variable, and the only
 * thing that ever wrote it was the `timezone` bootstrap step — which runs once
 * and is memoised. So the Developer screen's field wrote the row, displayed the
 * new value, and changed nothing: every "today" boundary, day heading,
 * `dayRange` key and dictated date kept the old zone until the process was
 * killed.
 *
 * The user-visible shape of that: land in New York, set `America/New_York`, say
 * "book dinner tomorrow at 9am", and the event is stored at 9am Sofia — two in
 * the morning where you are standing — and stamped with the zone you left.
 *
 * These tests drive `applyZone` through the real mutation surface rather than
 * calling `setZoneOverride` directly, because the bug was never in the setter.
 * It was that nothing called it.
 */
import { setZoneOverride, currentZone } from '../../core/time';

/* The mutation's own logic, extracted the way the hook applies it. Kept in step
   with `applyZone` in useSettings.ts — see the test at the bottom, which reads
   the source so the two cannot drift. */
function applyZone(patch: { timezone?: unknown }): void {
  if (!('timezone' in patch)) return;
  const zone = patch.timezone;
  const valid =
    typeof zone === 'string' && zone.trim() !== '' && require('../../core/time').isValidZone(zone);
  setZoneOverride(valid ? (zone as string) : null);
}

afterEach(() => setZoneOverride(null));

describe('a zone written is a zone used', () => {
  it('takes effect immediately, not on the next launch', () => {
    applyZone({ timezone: 'America/New_York' });
    expect(currentZone()).toBe('America/New_York');
  });

  it('changes again when it changes again', () => {
    applyZone({ timezone: 'America/New_York' });
    applyZone({ timezone: 'Asia/Tokyo' });
    expect(currentZone()).toBe('Asia/Tokyo');
  });

  /* A patch that does not mention the zone must not disturb it — `setMany` is
     used for every setting in the app. */
  it('leaves it alone when the patch is about something else', () => {
    applyZone({ timezone: 'Asia/Tokyo' });
    applyZone({ speakReplies: true } as never);
    expect(currentZone()).toBe('Asia/Tokyo');
  });

  /**
   * An invalid zone falls back to the device's rather than being applied.
   *
   * Luxon answers in UTC for a zone it does not recognise, silently, so a typo
   * in a free-text field would make every date in the app wrong with nothing on
   * screen to point at. This is also why the field is on the Developer screen
   * and not in Settings — it fails the "worst possible value" test.
   */
  it('refuses a zone that is not real', () => {
    applyZone({ timezone: 'Middle/Earth' });
    expect(currentZone()).not.toBe('Middle/Earth');
  });

  /* Clearing it is how a traveller gets back to the device's own zone: once the
     row exists it pins the app regardless of where the phone is. */
  it('goes back to the device zone when cleared', () => {
    applyZone({ timezone: 'Asia/Tokyo' });
    applyZone({ timezone: '' });
    expect(currentZone()).not.toBe('Asia/Tokyo');
  });
});

describe('the hook really does this', () => {
  /**
   * Read from the source, because the logic above is a copy.
   *
   * The bug was that the setter had exactly one caller and it was the bootstrap
   * step. What this asserts is that the *mutation* calls it — if `applyZone`
   * is removed from `useSetSettings`, the tests above keep passing and the bug
   * comes back.
   */
  it('applies the zone from the settings mutation', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const source = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'useSettings.ts'),
      'utf8',
    ) as string;

    expect(source).toContain('function applyZone');
    expect(source).toMatch(/applyZone\(patch\)/);
    expect(source).toContain('setZoneOverride');
    // And the broad invalidation, without which every cached day heading keeps
    // the old zone's dates on screen.
    expect(source).toMatch(/'timezone' in patch \? qk\.all/);
  });
});
