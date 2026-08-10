/**
 * Injectable clock. Every module reads "now" through here so tests can freeze
 * time instead of sleeping, and so a single place governs what "today" means.
 */
let nowFn: () => number = () => Date.now();

export function now(): number {
  return nowFn();
}

export function setClock(fn: () => number): void {
  nowFn = fn;
}

/** Freezes time at `epoch`; returns a restore function. */
export function freezeClock(epoch: number): () => void {
  const previous = nowFn;
  nowFn = () => epoch;
  return () => {
    nowFn = previous;
  };
}

export function resetClock(): void {
  nowFn = () => Date.now();
}
