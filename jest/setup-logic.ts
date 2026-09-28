import { setClockFormat } from '@/core/time';

// Frozen, for the same reason the clock is: `clockFormat` defaults to `auto`,
// which reads the device — and under Node the "device" is this machine's
// locale, so a suite written against `14:00` passes in Sofia and fails in
// Chicago. Anything testing the 12-hour path says so explicitly.
setClockFormat('24h');

// Deterministic timezone + locale for every logic test. Timezone maths is a
// core behaviour of this app, so tests must not inherit the host's zone.
process.env.TZ = process.env.TZ ?? 'Europe/Sofia';

jest.setTimeout(20_000);

// Surface unhandled rejections instead of letting Jest swallow them.
process.on('unhandledRejection', (reason) => {
  throw reason;
});
