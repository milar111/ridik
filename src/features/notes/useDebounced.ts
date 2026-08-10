import { useEffect, useState } from 'react';

/**
 * Search runs against FTS5 on every keystroke otherwise. 200ms is long enough
 * that a normal typing burst issues one query and short enough that the list
 * still feels like it is tracking the field.
 */
export function useDebounced<T>(value: T, delayMs = 200): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
