/**
 * Twelve-hour time, and the two things that make it more than a format string.
 *
 * The first is that a clock column is sized in points and "12:00 AM" is wider
 * than "21:00" — 72.0pt against 45.0 in `mono`, which is Martian Mono at 13
 * and monospaced, so those are exact. Three columns in this app were built to
 * fit the second, and what they do with the first is *wrap*, not truncate:
 * "3:00" over "PM" down a whole agenda. The number is asserted here because
 * the first attempt at it was measured in the wrong typeface, passed every
 * test, and wrapped on the first device it reached.
 *
 * The second is that `auto` must be resolved *once*, when the setting is
 * applied. Resolving it per call would make every rendered time depend on
 * ambient locale, which is the same untestability `now()` exists to prevent —
 * under Node this suite's own locale decides, so the app would render one way
 * here and another on the phone that wrote the expectations.
 */
import {
  clockColumnWidth,
  clockFormatOptions,
  formatDateTime,
  formatTime,
  sampleClock,
  setClockFormat,
  setZoneOverride,
  uses12Hour,
} from '@/core/time';

/**
 * 2026-09-06, a Sunday, in Europe/Sofia. Pinned here rather than borrowed from
 * `setup-logic.ts`, which only defaults `TZ` — CI runs this suite again under
 * UTC and Los Angeles, and every reading below would move with it.
 */
beforeAll(() => setZoneOverride('Europe/Sofia'));
afterAll(() => setZoneOverride(null));

const AT_2100 = Date.UTC(2026, 8, 6, 18, 0);
const AT_0930 = Date.UTC(2026, 8, 6, 6, 30);
const MIDNIGHT = Date.UTC(2026, 8, 5, 21, 0);

afterEach(() => setClockFormat('24h'));

describe('24-hour, which is what the suite is frozen to', () => {
  it('renders a clock reading with no meridiem', () => {
    expect(formatTime(AT_2100)).toBe('21:00');
    expect(formatTime(AT_0930)).toBe('09:30');
    expect(formatTime(MIDNIGHT)).toBe('00:00');
  });

  it('reserves the narrow column', () => {
    expect(uses12Hour()).toBe(false);
    expect(clockColumnWidth()).toBe(46);
  });
});

describe('12-hour', () => {
  beforeEach(() => setClockFormat('12h'));

  it('renders the meridiem, and midnight as 12 rather than 0', () => {
    expect(formatTime(AT_2100)).toBe('9:00 PM');
    expect(formatTime(AT_0930)).toBe('9:30 AM');
    expect(formatTime(MIDNIGHT)).toBe('12:00 AM');
  });

  it('carries the format into the long form too', () => {
    // A second copy of `HH:mm` lived here, and a second copy is how half an
    // app ends up on the other format.
    expect(formatDateTime(AT_2100)).toBe('Sun 6 Sep, 9:00 PM');
  });

  /**
   * The measured one. 46pt fits `21:00`; nothing in the 12-hour set fits in
   * it, so the columns that render a clock reading widen with the format.
   */
  it('reserves a column the longest reading actually fits in', () => {
    expect(uses12Hour()).toBe(true);
    expect(clockColumnWidth()).toBeGreaterThanOrEqual(72);
  });
});

describe('auto', () => {
  it('is answered once, at the moment it is applied', () => {
    // Whatever this machine's locale says, it says the same thing twice — and
    // says it without being asked again, which is what makes a rendered time
    // reproducible.
    setClockFormat('auto');
    const first = uses12Hour();
    expect(uses12Hour()).toBe(first);
    expect(formatTime(AT_2100)).toBe(first ? '9:00 PM' : '21:00');
  });

  it('is what the Settings screen offers first, and every option renders', () => {
    const options = clockFormatOptions();
    expect(options[0]?.value).toBe('auto');
    expect(options.map((o) => o.value)).toEqual(['auto', '24h', '12h']);
    // The row shows the instant rather than describing the format, so each
    // option has to be able to render one without being the active choice.
    expect(sampleClock('24h', AT_2100)).toBe('21:00');
    expect(sampleClock('12h', AT_2100)).toBe('9:00 PM');
    expect(formatTime(AT_2100)).toBe('21:00'); // and rendering it changed nothing
  });
});
