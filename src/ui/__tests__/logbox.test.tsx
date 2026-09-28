/**
 * The dev-overlay filter, held to the rule its own file argues for.
 *
 * `logbox.ts` silences two messages, and the case for each of them turns on the
 * pattern being *specific enough to name its source*. That is the part a later
 * edit can quietly break — shortening a pattern to catch "one more variant" is
 * exactly how a filter stops being a filter and starts being a blindfold — so
 * it is measured here rather than left to the docblock.
 *
 * The matcher is React Native's own: `LogBox.ignoreLogs` tests a string pattern
 * with `message.includes(pattern)`, which is restated in `matches` below so this
 * file is not asserting against an implementation it imported from the thing
 * under test.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { IGNORED_DEV_LOGS } from '@/startup/logbox';

/** `LogBoxData.isMessageIgnored`, for a string pattern. */
function matches(message: string): boolean {
  return IGNORED_DEV_LOGS.some((pattern) => message.includes(pattern));
}

/* The two messages as they actually arrive, copied from a device log rather
   than from the source that formats them. The first is `console.error`'d by
   `expo-notifications` at module evaluation; the second is written by
   `RCTEventEmitter.m` when the native animated module outlives its listener. */
const SILENCED = [
  '[expo-notifications] Error reading persisted server registration info: , ' +
    "{ [Error: FunctionCallException: Calling the 'getRegistrationInfoAsync' " +
    'function has failed] code: -34018 }',
  'Sending `onAnimatedValueUpdate` with no listeners registered.',
];

/* Things that must keep coming through. The first four are the near misses that
   make the difference between naming a source and muting a category: another
   emitter racing the same way, another complaint from the same package, and the
   generic React warning that `AGENTS.md` records as expo-router's — which is
   deliberately absent from the list, because it names no source and our own code
   could produce it word for word. */
const MUST_STILL_SHOW = [
  'Sending `onScroll` with no listeners registered.',
  'Sending `onUserDrivenAnimationEnded` with no listeners registered.',
  '[expo-notifications] Encountered an exception while handling a notification',
  "Can't perform a React state update on a component that hasn't mounted yet.",
  'Warning: Each child in a list should have a unique "key" prop.',
  'VirtualizedList: You have a large list that is slow to update.',
];

describe('the messages the overlay is told to skip', () => {
  it('is a short list, and adding to it is meant to be hard', () => {
    // Not a style rule. Every entry is a thing this app has decided not to look
    // at, and the argument for each one is a section of `logbox.ts`.
    expect(IGNORED_DEV_LOGS.length).toBeLessThanOrEqual(3);
  });

  it.each(SILENCED)('catches %s', (message) => {
    expect(matches(message)).toBe(true);
  });

  it.each(MUST_STILL_SHOW)('lets through %s', (message) => {
    expect(matches(message)).toBe(false);
  });

  /* The rule the file opens with. A pattern short enough to be a package prefix
     ("[expo-notifications]") or a bare sentence shape ("with no listeners
     registered") would swallow messages nobody has argued about. */
  it.each(IGNORED_DEV_LOGS)('names its own source: %s', (pattern) => {
    expect(pattern.length).toBeGreaterThanOrEqual(40);
  });

  /* Exporting the list and forgetting to hand it over would leave every
     assertion above green over an overlay that filters nothing. Read from the
     source, because the call is a module side effect that has already run by
     the time a test can spy on it. */
  it('hands the list it exports to LogBox', () => {
    const source = readFileSync(join(__dirname, '../../startup/logbox.ts'), 'utf8');
    expect(source).toContain('LogBox.ignoreLogs([...IGNORED_DEV_LOGS]);');
  });
});
