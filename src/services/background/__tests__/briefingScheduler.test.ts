import {
  BRIEFING_ENTITY_ID,
  briefingBody,
  nextBriefingAt,
  type DaySummary,
} from '@/services/background/briefingScheduler';
import { DateTime } from '@/core/time';

const NEW_YORK = 'America/New_York';
const SOFIA = 'Europe/Sofia';

const at = (iso: string, zone: string): number => {
  const dt = DateTime.fromISO(iso, { zone });
  if (!dt.isValid) throw new Error(`bad fixture "${iso}" in ${zone}: ${dt.invalidReason}`);
  return dt.toMillis();
};

const localOf = (epoch: number, zone: string) =>
  DateTime.fromMillis(epoch, { zone }).toFormat('yyyy-LL-dd HH:mm ZZZZ');

describe('nextBriefingAt', () => {
  it('returns null when briefings are switched off', () => {
    expect(
      nextBriefingAt({ now: at('2026-04-14T05:00', SOFIA), zone: SOFIA, hour: 7, enabled: false }),
    ).toBeNull();
  });

  it('picks today when the hour is still ahead', () => {
    const now = at('2026-04-14T05:12', SOFIA);
    const next = nextBriefingAt({ now, zone: SOFIA, hour: 7, enabled: true });
    expect(next).toBe(at('2026-04-14T07:00', SOFIA));
    expect(localOf(next!, SOFIA)).toBe('2026-04-14 07:00 GMT+3');
  });

  it('rolls over midnight when the hour has passed', () => {
    const now = at('2026-04-14T23:30', SOFIA);
    const next = nextBriefingAt({ now, zone: SOFIA, hour: 7, enabled: true });
    expect(next).toBe(at('2026-04-15T07:00', SOFIA));
  });

  it('rolls to the next day for a briefing hour just gone by minutes', () => {
    const now = at('2026-04-14T07:01', SOFIA);
    expect(nextBriefingAt({ now, zone: SOFIA, hour: 7, enabled: true })).toBe(
      at('2026-04-15T07:00', SOFIA),
    );
  });

  it('treats the exact briefing instant as already delivered', () => {
    const now = at('2026-04-14T07:00', SOFIA);
    expect(nextBriefingAt({ now, zone: SOFIA, hour: 7, enabled: true })).toBe(
      at('2026-04-15T07:00', SOFIA),
    );
  });

  it('keeps a 00:00 briefing on the next midnight, not on "now"', () => {
    const now = at('2026-04-14T00:00', SOFIA);
    expect(nextBriefingAt({ now, zone: SOFIA, hour: 0, enabled: true })).toBe(
      at('2026-04-15T00:00', SOFIA),
    );
  });

  it('holds the wall-clock hour across a spring-forward transition', () => {
    // New York loses 02:00-03:00 on 2026-03-08, so the gap is 23 hours.
    const now = at('2026-03-07T07:30', NEW_YORK);
    const next = nextBriefingAt({ now, zone: NEW_YORK, hour: 7, enabled: true });

    expect(localOf(next!, NEW_YORK)).toBe('2026-03-08 07:00 EDT');
    expect(next! - now).toBe(23 * 3_600_000 - 30 * 60_000);
  });

  it('holds the wall-clock hour across a fall-back transition', () => {
    // 01:00-02:00 happens twice on 2026-11-01, so the gap is 25 hours.
    const now = at('2026-10-31T07:30', NEW_YORK);
    const next = nextBriefingAt({ now, zone: NEW_YORK, hour: 7, enabled: true });

    expect(localOf(next!, NEW_YORK)).toBe('2026-11-01 07:00 EST');
    expect(next! - now).toBe(25 * 3_600_000 - 30 * 60_000);
  });

  it('rolls a briefing hour that DST skipped forward into an hour that exists', () => {
    const now = at('2026-03-08T00:30', NEW_YORK);
    const next = nextBriefingAt({ now, zone: NEW_YORK, hour: 2, enabled: true });

    // 02:00 never happens that morning; firing at 03:00 beats never firing.
    expect(localOf(next!, NEW_YORK)).toBe('2026-03-08 03:00 EDT');
    expect(next!).toBeGreaterThan(now);
  });

  it('resolves the repeated hour on a fall-back morning to a real instant', () => {
    const now = at('2026-11-01T00:15', NEW_YORK);
    const next = nextBriefingAt({ now, zone: NEW_YORK, hour: 1, enabled: true });

    expect(next!).toBeGreaterThan(now);
    expect(DateTime.fromMillis(next!, { zone: NEW_YORK }).hour).toBe(1);
  });

  it('falls back to the device zone when the stored zone is nonsense', () => {
    const now = at('2026-04-14T05:00', SOFIA);
    const next = nextBriefingAt({ now, zone: 'Middle/Earth', hour: 7, enabled: true });

    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(now);
    expect(DateTime.fromMillis(next!).hour).toBe(7);
  });

  it('clamps an out-of-range or non-numeric hour instead of skipping the day', () => {
    const now = at('2026-04-14T05:00', SOFIA);
    const late = nextBriefingAt({ now, zone: SOFIA, hour: 99, enabled: true });
    const early = nextBriefingAt({ now, zone: SOFIA, hour: -4, enabled: true });
    const broken = nextBriefingAt({ now, zone: SOFIA, hour: Number.NaN, enabled: true });

    expect(late).toBe(at('2026-04-14T23:00', SOFIA));
    expect(early).toBe(at('2026-04-15T00:00', SOFIA));
    expect(broken).toBe(at('2026-04-14T07:00', SOFIA));
  });

  it('always lands on the hour', () => {
    const now = at('2026-04-14T05:37:29', SOFIA);
    const next = DateTime.fromMillis(
      nextBriefingAt({ now, zone: SOFIA, hour: 7, enabled: true })!,
      { zone: SOFIA },
    );
    expect([next.minute, next.second, next.millisecond]).toEqual([0, 0, 0]);
  });
});

describe('briefingBody', () => {
  const summary = (patch: Partial<DaySummary> = {}): DaySummary => ({
    events: 0,
    tasksDue: 0,
    firstEventAt: null,
    zone: SOFIA,
    ...patch,
  });

  it('says the day is clear when there is nothing on it', () => {
    expect(briefingBody(summary())).toBe('Nothing on the calendar and nothing due. A clear day.');
  });

  it('counts events and tasks together', () => {
    expect(briefingBody(summary({ events: 3, tasksDue: 2 }))).toBe('3 events and 2 tasks due today.');
  });

  it('uses singular forms for one of each', () => {
    expect(briefingBody(summary({ events: 1, tasksDue: 1 }))).toBe('1 event and 1 task due today.');
  });

  it('drops the half of the sentence that would read as zero', () => {
    expect(briefingBody(summary({ tasksDue: 4 }))).toBe('4 tasks due today.');
    expect(briefingBody(summary({ events: 2 }))).toBe('2 events today.');
  });

  it('adds the first start time in the briefing zone', () => {
    expect(
      briefingBody(summary({ events: 2, firstEventAt: at('2026-04-14T09:30', SOFIA) })),
    ).toBe('2 events today. First at 9:30 AM.');
  });

  it('reads a whole hour without the minutes', () => {
    expect(
      briefingBody(summary({ events: 1, firstEventAt: at('2026-04-14T09:00', SOFIA) })),
    ).toBe('1 event today. First at 9 AM.');
  });
});

describe('BRIEFING_ENTITY_ID', () => {
  it('is the stable id the canceller looks for', () => {
    expect(BRIEFING_ENTITY_ID).toBe('briefing');
  });
});
