import { cleanup } from '@testing-library/react-native';

// RNTL 14 unmounts asynchronously. Without an awaited cleanup between tests the
// next render commits into a half-torn-down root and every query comes back empty.
afterEach(async () => {
  await cleanup();
});
