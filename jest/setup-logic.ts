// Deterministic timezone + locale for every logic test. Timezone maths is a
// core behaviour of this app, so tests must not inherit the host's zone.
process.env.TZ = process.env.TZ ?? 'Europe/Sofia';

jest.setTimeout(20_000);

// Surface unhandled rejections instead of letting Jest swallow them.
process.on('unhandledRejection', (reason) => {
  throw reason;
});
