/**
 * The vocabulary is the privacy boundary, so it is asserted as *source*.
 *
 * The union already makes it impossible to record a note title — there is no
 * field that could hold one. This test guards the next commit rather than this
 * one: adding a property is cheap and should be, but adding a new *kind* of
 * property has to argue for itself in a test diff where somebody will see it.
 *
 * Reading the file as text rather than reflecting over the zod object is
 * deliberate and follows `services/billing/__tests__/reset-surfaces.test.ts`,
 * which does the same thing for a different category of mistake. A schema can
 * be assembled at run time from something this test would not see; the source
 * cannot.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EVENT_NAMES, EVENT_SCHEMA, installAge, latencyBucket, parseEvent } from '../events';

const SOURCE = readFileSync(join(__dirname, '..', 'events.ts'), 'utf8');

/**
 * Property names that would mean the vocabulary had started carrying content.
 * `zone` is here because a timezone is a location to within a few hundred
 * miles, and `note` because it is the one word that names a whole table.
 */
const FORBIDDEN =
  /transcript|title|text|body|amount|price|query|email|phone|lat\b|lon\b|address|zone|note/i;

/**
 * `name` is forbidden everywhere except the `tool` event, where it is the app's
 * own `ToolName` enum — an identifier this codebase chose, never a word the
 * user said. Allow-listed by exact line so a second `name` cannot appear
 * quietly beside it.
 */
const NAME_ALLOWED = /^\s*name: z\.enum\(TOOL_NAMES\),$/;

/** Every `foo: z.…` declaration inside the file, with its line number. */
function propertyLines(): { line: string; number: number }[] {
  return SOURCE.split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => /^\s*[a-z_][a-z0-9_]*\s*:\s*(z\.|bit\b)/i.test(line));
}

describe('the analytics vocabulary', () => {
  it('has no property that could hold content', () => {
    const offenders = propertyLines()
      .filter(({ line }) => FORBIDDEN.test(line.split(':')[0] ?? ''))
      .filter(({ line }) => !NAME_ALLOWED.test(line));

    expect(offenders.map((o) => `${o.number}: ${o.line.trim()}`)).toEqual([]);
  });

  it('allows tool.name only as the closed ToolName enum', () => {
    const nameLines = propertyLines().filter(({ line }) => /^\s*name\s*:/.test(line));
    // One and only one: the `tool` event's. `name: z.literal(...)` discriminants
    // are matched too, so this also proves no event smuggled a free-text name.
    const notDiscriminants = nameLines.filter(({ line }) => !/z\.literal\(/.test(line));
    expect(notDiscriminants).toHaveLength(1);
    expect(NAME_ALLOWED.test(notDiscriminants[0]!.line)).toBe(true);
  });

  it('has no free-text property anywhere: no z.string() at all', () => {
    // The strongest form of the rule, and the cheapest to check. Enums are
    // `z.enum`, buckets are `z.enum`, counts are `z.number().int()`. A bare
    // string has no legitimate use in this file.
    const strings = SOURCE.split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => /z\.string\(/.test(line));
    expect(strings.map((s) => `${s.number}: ${s.line.trim()}`)).toEqual([]);
  });

  it('names every event exactly once', () => {
    expect(new Set(EVENT_NAMES).size).toBe(EVENT_NAMES.length);
    expect(EVENT_NAMES).toHaveLength(EVENT_SCHEMA.options.length);
  });

  it('refuses an event outside the union', () => {
    expect(parseEvent({ name: 'exfiltrate', props: { body: 'secret' } })).toBeNull();
    expect(parseEvent({ name: 'turn', props: {} })).toBeNull();
    // A known event carrying an extra field is refused rather than trimmed:
    // silently dropping it would let a caller believe it had been recorded.
    expect(
      parseEvent({
        name: 'trial',
        props: { state: 'fresh', transcript: 'call Ivo at four' },
      }),
    ).toBeNull();
  });

  it('accepts a well-formed event', () => {
    expect(
      parseEvent({
        name: 'turn',
        props: {
          mode: 'model',
          input: 'voice',
          actions: 2,
          status: 'ok',
          latency: '1-2s',
          repaired: 0,
        },
      }),
    ).not.toBeNull();
  });

  it('buckets latency at the documented boundaries', () => {
    expect(latencyBucket(0)).toBe('<1s');
    expect(latencyBucket(999)).toBe('<1s');
    expect(latencyBucket(1000)).toBe('1-2s');
    expect(latencyBucket(1999)).toBe('1-2s');
    expect(latencyBucket(2000)).toBe('2-4s');
    expect(latencyBucket(4000)).toBe('4-8s');
    expect(latencyBucket(8000)).toBe('8s+');
    expect(latencyBucket(Number.NaN)).toBe('<1s');
  });

  it('buckets install age at the documented boundaries', () => {
    expect(installAge(0)).toBe('0');
    expect(installAge(1)).toBe('1');
    expect(installAge(2)).toBe('2-6');
    expect(installAge(6)).toBe('2-6');
    expect(installAge(7)).toBe('7-29');
    expect(installAge(30)).toBe('30+');
  });
});
