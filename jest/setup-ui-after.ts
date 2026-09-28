import { cleanup } from '@testing-library/react-native';

import { setClockFormat } from '@/core/time';

// Frozen, for the same reason the clock is: `clockFormat` defaults to `auto`,
// which reads the device — and under Node the "device" is this machine's
// locale, so a suite written against `14:00` passes in Sofia and fails in
// Chicago. Anything testing the 12-hour path says so explicitly.
setClockFormat('24h');

// RNTL 14 unmounts asynchronously. Without an awaited cleanup between tests the
// next render commits into a half-torn-down root and every query comes back empty.
afterEach(async () => {
  await cleanup();
});
