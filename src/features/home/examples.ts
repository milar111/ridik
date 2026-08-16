/**
 * What to say, for somebody who has not said anything yet.
 *
 * The home screen is a microphone and a receipt for the last thing it did, and
 * on a cold start there is no last thing — so the one place the app could
 * explain itself was blank on exactly the launch where it needed to. This fills
 * that space, and only that space: it disappears the moment there is a real
 * receipt to show, because a screen that keeps teaching after you have learned
 * is a screen you learn to ignore.
 *
 * Three rules, and each one is the difference between a hint and an onboarding
 * flow — which the research is explicit about people quitting:
 *
 *  - **Their words, not ours.** An example built from a list they actually keep
 *    ("What's on my Hardware list?") is a demonstration that this app knows
 *    about their Hardware list. The generic version is a brochure.
 *  - **Half of them are questions.** Nothing else in the app says you may ask
 *    rather than only tell, and the `search` tool spans notes, tasks, lists,
 *    projects, people, money and the calendar — the single most valuable thing
 *    here that nobody would guess is there. The pool alternates strictly, so
 *    every window of two or more contains one of each.
 *  - **It rotates.** Three lines that never change become furniture in a day.
 *
 * Pure and separate from the component so the pool's shape is arithmetic that
 * can be tested rather than something you have to render to see.
 */
import { truncate } from '@/core/format';

/** How many are on the screen at once. */
export const EXAMPLE_COUNT = 3;

/** How long one set stays up. Long enough to read twice, and read past. */
export const EXAMPLE_ROTATE_MS = 8_000;

/** A user's own name is theirs; past this it is a paragraph in a caption. */
const NAME_MAX = 22;

/** How many pairs the pool holds. Beyond this the rotation is a slideshow. */
const MAX_PAIRS = 4;

/**
 * The generic half, used when there is nothing of the user's to use and as the
 * tail of the pool when there is. Ordinary sentences on purpose: an example
 * nobody would say teaches a syntax rather than a capability.
 */
const SAY_FALLBACK = [
  'Remind me to call Mum at six',
  'Note that the lab needs 10k resistors',
  'I spent twelve on lunch',
] as const;

const ASK_FALLBACK = [
  'What did I write about the lab?',
  'Where did I note the wifi password?',
  'What have I got on Friday?',
] as const;

export type ExampleSources = {
  /** Checklist names, most recently used first. */
  lists: readonly string[];
  /** Habit names. */
  habits: readonly string[];
};

function usable(names: readonly string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const clean = truncate(name, NAME_MAX);
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length === limit) break;
  }
  return out;
}

/**
 * The rotation pool: strictly alternating statement, question, statement,
 * question, with anything of the user's own at the front of each half.
 *
 * The alternation is the load-bearing part. A window of three taken anywhere in
 * an even-length alternating ring always contains at least one of each, so the
 * "you can ask, not only tell" half of this cannot be rotated off the screen —
 * which is precisely what a shuffled pool would do a third of the time.
 */
export function buildExamples(sources: ExampleSources): string[] {
  const says = [
    ...usable(sources.habits, 2).map((habit) => `Log ${habit}`),
    ...SAY_FALLBACK,
  ];
  const asks = [
    // Typographic apostrophe, like every other sentence the app writes: a
    // straight one next to Bricolage's own punctuation reads as a bug.
    ...usable(sources.lists, 2).map((list) => `What’s on my ${list} list?`),
    ...ASK_FALLBACK,
  ];

  // Never past the shorter half: taking `says[i % says.length]` would put the
  // same line in the ring twice, and two windows apart is close enough to see.
  const pairs = Math.min(says.length, asks.length, MAX_PAIRS);
  const pool: string[] = [];
  for (let i = 0; i < pairs; i += 1) pool.push(says[i]!, asks[i]!);
  return pool;
}

/**
 * `size` consecutive examples, wrapping, `tick` sets along.
 *
 * The step is the window width rather than one, so a rotation replaces all
 * three lines instead of sliding two of them along — a list where two thirds
 * stayed put reads as a glitch rather than as new information.
 */
export function exampleWindow(
  pool: readonly string[],
  tick: number,
  size: number = EXAMPLE_COUNT,
): string[] {
  if (pool.length === 0) return [];
  const width = Math.min(size, pool.length);
  const offset = tick * width;
  const start = ((offset % pool.length) + pool.length) % pool.length;
  return Array.from({ length: width }, (_, i) => pool[(start + i) % pool.length]!);
}
