import { useEffect, useState } from 'react';

import { now } from '@/core/clock';

/**
 * A slow clock for the parts of Today that go stale on their own: the now-rule
 * between two agenda rows, "due soon" turning amber, an event dimming once it
 * has finished. Half a minute is fine — none of these move by the second, and
 * the focus card runs its own ticker.
 */
export function useNow(intervalMs = 30_000): number {
  const [at, setAt] = useState(() => now());

  useEffect(() => {
    const handle = setInterval(() => setAt(now()), intervalMs);
    return () => clearInterval(handle);
  }, [intervalMs]);

  return at;
}
