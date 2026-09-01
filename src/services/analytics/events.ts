/**
 * The closed vocabulary. Everything the app is allowed to count, and nothing else.
 *
 * This file is the privacy boundary, not the storage layer. `appEvents.record()`
 * refuses anything this union does not describe, so the question "could Ridik
 * ever record a note title?" is answered by reading one file rather than by
 * auditing every call site.
 *
 * **There is no free-text property anywhere in this type**, by construction:
 * every property is an enum, a bucket, or a small integer. That is what makes
 * the Usage screen safe to upload byte for byte — the user reads exactly what
 * would be sent, because there is no room in the shape for anything else.
 *
 * Two of the enums are the app's own existing closed sets rather than copies:
 * `TOOL_NAMES` from `@/llm/contract` and `AppErrorCode` from `@/core/result`.
 * So a new tool appears in the funnel the day it is added, and a typo does not
 * compile. `__tests__/vocabulary.test.ts` reads this file as *source* and fails
 * if a property name ever looks like content.
 */
import { z } from 'zod';

import type { AppErrorCode } from '@/core/result';
import { TOOL_NAMES } from '@/llm/contract';

/**
 * `AppErrorCode` is a union type with no runtime array, so this is the array —
 * and the `satisfies` below is what makes adding a code without adding it here
 * a compile error rather than a silently unrecorded failure.
 */
export const ERROR_CODES = [
  'not_found',
  'ambiguous',
  'invalid_input',
  'conflict',
  'permission_denied',
  'offline',
  'rate_limited',
  'upstream',
  'unsupported',
  'cycle',
  'unknown',
] as const satisfies readonly AppErrorCode[];

/** Every code is in the array, not merely every array entry a valid code. */
type _CodesAreExhaustive = Exclude<AppErrorCode, (typeof ERROR_CODES)[number]> extends never
  ? true
  : ['missing from ERROR_CODES:', Exclude<AppErrorCode, (typeof ERROR_CODES)[number]>];
const _codesAreExhaustive: _CodesAreExhaustive = true;
void _codesAreExhaustive;

/**
 * The routes worth counting. Not every file in `app/` — `_layout` is not a
 * destination and `oauthredirect` is a handshake, so neither is a screen
 * anybody chose to open.
 */
export const ROUTES = [
  'home',
  'activity',
  'backup',
  'briefing',
  'calendar',
  'consent',
  'curriculum',
  'developer',
  'focus',
  'habits',
  'history',
  'ledger',
  'menu',
  'notes',
  'people',
  'places',
  'plans',
  'projects',
  'settings',
  'tasks',
  'today',
  'unlock',
  'usage',
] as const;

/**
 * Latency as a bucket, never as a number.
 *
 * A millisecond figure per turn is a keystroke-level timeline of somebody's
 * day once you have a few hundred of them. Five buckets answer "is it getting
 * slower" — which is the only question anyone was going to ask — and answer
 * nothing else.
 */
export const LATENCY_BUCKETS = ['<1s', '1-2s', '2-4s', '4-8s', '8s+'] as const;
export type LatencyBucket = (typeof LATENCY_BUCKETS)[number];

/** Milliseconds to the bucket it falls in. The boundaries are inclusive-low. */
export function latencyBucket(ms: number): LatencyBucket {
  if (!Number.isFinite(ms) || ms < 1000) return '<1s';
  if (ms < 2000) return '1-2s';
  if (ms < 4000) return '2-4s';
  if (ms < 8000) return '4-8s';
  return '8s+';
}

/**
 * How long this install has existed, bucketed — the only thing resembling
 * retention that can be asked without an identifier. A crude curve across a
 * population, and useless for picking anyone out of it.
 */
export const INSTALL_AGES = ['0', '1', '2-6', '7-29', '30+'] as const;
export type InstallAge = (typeof INSTALL_AGES)[number];

export function installAge(days: number): InstallAge {
  if (!Number.isFinite(days) || days <= 0) return '0';
  if (days < 2) return '1';
  if (days < 7) return '2-6';
  if (days < 30) return '7-29';
  return '30+';
}

const bit = z.union([z.literal(0), z.literal(1)]);

/* -------------------------------------------------------------------------- */
/* The union                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Every `props` is **strict**: an unknown key is a refusal, not a silent trim.
 *
 * zod's default is to strip what it does not recognise, which would have been
 * safe — the field never reaches the table either way — but it is the wrong
 * failure. A caller that attaches a transcript to an event should have that
 * event *rejected and logged*, not quietly recorded minus the transcript, or
 * nobody ever finds out the call site is wrong.
 */
export const EVENT_SCHEMA = z.discriminatedUnion('name', [
  /** The two gates of the first run, and which way each one went. */
  z.object({
    name: z.literal('first_run_step'),
    props: z.strictObject({
      step: z.enum(['consent', 'first_word']),
      outcome: z.enum(['allow', 'decline', 'carry_on', 'not_now']),
    }),
  }),

  /** Whether the very first utterance landed, and how it was started. */
  z.object({
    name: z.literal('first_word'),
    props: z.strictObject({
      source: z.enum(['chip', 'voice', 'typed']),
      chip: z.union([z.literal(1), z.literal(2), z.literal(3), z.null()]),
      ok: bit,
    }),
  }),

  /** An offer the app made, and whether it was taken. */
  z.object({
    name: z.literal('offer'),
    props: z.strictObject({
      which: z.enum(['closing', 'nudge', 'week', 'briefing']),
      answer: z.enum(['yes', 'no', 'ignored']),
    }),
  }),

  /** One utterance, end to end. The single most useful row in the table. */
  z.object({
    name: z.literal('turn'),
    props: z.strictObject({
      mode: z.enum(['model', 'offline']),
      input: z.enum(['voice', 'typed', 'chip']),
      /** How many actions the turn produced. Capped, because 9+ is one story. */
      actions: z.number().int().min(0).max(9),
      status: z.enum(['ok', 'clarify', 'error']),
      latency: z.enum(LATENCY_BUCKETS),
      repaired: bit,
    }),
  }),

  /** Which tools are load-bearing and which are dead weight. */
  z.object({
    name: z.literal('tool'),
    props: z.strictObject({
      // The one `name` the vocabulary test allows, and only because it is this
      // enum: a `ToolName` is the app's own identifier, not the user's words.
      name: z.enum(TOOL_NAMES),
      ok: bit,
      confirmed: bit,
      undone: bit,
    }),
  }),

  /** Why a turn failed, from the app's own closed set of reasons. */
  z.object({
    name: z.literal('turn_error'),
    props: z.strictObject({ code: z.enum(ERROR_CODES) }),
  }),

  /** Which recogniser answered, and what came back. */
  z.object({
    name: z.literal('stt'),
    props: z.strictObject({
      engine: z.enum(['on_device', 'network', 'whisper']),
      result: z.enum(['final', 'empty', 'low_confidence', 'unsupported', 'denied']),
    }),
  }),

  /** A launch, and roughly how old the install is. */
  z.object({
    name: z.literal('app_open'),
    props: z.strictObject({ install_age: z.enum(INSTALL_AGES) }),
  }),

  /** A permission the OS was asked for, and the answer. */
  z.object({
    name: z.literal('permission'),
    props: z.strictObject({
      which: z.enum(['mic', 'speech', 'notifications']),
      answer: z.enum(['granted', 'denied', 'blocked']),
    }),
  }),

  /** Where the user stands with the trial or a plan. */
  z.object({
    name: z.literal('trial'),
    props: z.strictObject({
      state: z.enum(['fresh', 'warning', 'spent', 'subscribed', 'unknown']),
    }),
  }),

  /** A screen was opened. The route, never what was on it. */
  z.object({
    name: z.literal('screen'),
    props: z.strictObject({ route: z.enum(ROUTES) }),
  }),
]);

export type AnalyticsEvent = z.infer<typeof EVENT_SCHEMA>;
export type AnalyticsEventName = AnalyticsEvent['name'];

/** Every name in the union, for the Usage screen's own grouping. */
export const EVENT_NAMES = EVENT_SCHEMA.options.map(
  (option) => option.shape.name.value,
) as readonly AnalyticsEventName[];

/**
 * Validate one event. Returns `null` rather than throwing: recording is
 * fire-and-forget and must never be able to break a turn, so a caller that
 * somehow assembles a bad event loses the count, not the user's sentence.
 */
export function parseEvent(candidate: unknown): AnalyticsEvent | null {
  const result = EVENT_SCHEMA.safeParse(candidate);
  return result.success ? result.data : null;
}
