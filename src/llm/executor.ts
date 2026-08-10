/**
 * The executor — validated model actions become rows.
 *
 * By the time an action reaches this file it has already survived Zod, so the
 * question is no longer "is this well-formed" but "is this the thing the user
 * actually meant, and can it be applied to the data that exists". Three rules
 * run through every handler:
 *
 *  - **Never guess.** A fuzzy reference that resolves to more than one row comes
 *    back as a question. Silently editing the wrong event is unrecoverable; an
 *    extra question costs two seconds.
 *  - **Never throw.** One bad action inside an utterance must not cost the user
 *    the other two, so every failure is a value with a sentence safe to speak.
 *  - **Never lose the batch.** `executeAll` runs sequentially — "create the
 *    project, then add three things to it" only works in that order — and
 *    collects one result per action whatever happens to the others.
 *
 * Side effects that need a native module (notifications, the timer runtime,
 * geofence registration, the sync worker) are injected as optional ports, so the
 * whole file runs under plain Node in tests and degrades to a pure database
 * mutation when a port is missing.
 */
import { normalise, scoreText } from '@/core/match';
import { countLabel, formatMoney, joinNatural, speakMoney, truncate } from '@/core/format';
import type { Logger } from '@/core/logger';
import { AppError, toAppError, type AppErrorCode } from '@/core/result';
import {
  dayRange,
  epochToLocal,
  formatDateTime,
  formatDuration,
  formatSpokenTime,
  localDateOf,
  localToEpoch,
  monthRange,
  weekRange,
  type LocalDate,
} from '@/core/time';
import type { ActionParams, EntityQuery, LlmAction, ToolName } from '@/llm/contract';
import type { Repositories,
  UpdateTaskPatch,
} from '@/repositories';
import type { CalendarEvent } from '@/repositories/calendarEvents';
import type { SessionPhase } from '@/repositories/focusSessions';
import type { ProjectItemInput } from '@/repositories/projects';

/* --------------------------------------------------------------- contract -- */

export type ReminderRequest = {
  title: string;
  body?: string;
  /** UTC epoch ms. */
  at: number;
  data?: Record<string, unknown>;
};

export type SummaryRequest = {
  period: 'day' | 'week' | 'month' | 'custom';
  from: LocalDate;
  to: LocalDate;
  format: 'markdown' | 'spoken';
};

/**
 * Ports onto everything the executor cannot do by writing a row. All optional:
 * a missing port means the mutation still lands and only the side effect is
 * skipped, which is exactly what a test — or a device that denied notification
 * permission — needs.
 */
export type ExecutorEffects = {
  scheduleReminder?(input: ReminderRequest): Promise<string | null>;
  cancelReminders?(entityId: string): Promise<void>;
  startFocusSession?(sessionId: string): Promise<void>;
  controlFocusSession?(action: 'pause' | 'resume' | 'stop' | 'skip'): Promise<void>;
  registerGeofences?(): Promise<void>;
  syncCalendarEvent?(eventId: string): Promise<void>;
  generateBriefing?(scope: 'today' | 'tomorrow' | 'week'): Promise<string>;
  generateSummary?(input: SummaryRequest): Promise<string>;
};

export type ExecutionContext = {
  repos: Repositories;
  /** IANA zone every wall-clock string from the model is resolved against. */
  zone: string;
  /** UTC epoch ms the whole batch reasons from, so a slow batch stays coherent. */
  now: number;
  effects?: ExecutorEffects;
  logger?: Logger;
};

export type ActionResult = {
  toolName: ToolName;
  /**
   * True only when the action was applied. A result carrying
   * `needsConfirmation` is not an error — it is a question — but nothing was
   * written, so it is not `ok` either.
   */
  ok: boolean;
  /** One short line for the result list and for TTS. */
  summary: string;
  detail?: string;
  /** Deep link, e.g. '/note/abc' or '/project/xyz'. */
  href?: string;
  /**
   * Set when the user asked for this on screen rather than out loud. A briefing
   * with `speak: false` still returns its text; it just must not be read aloud.
   */
  silent?: boolean;
  /** Present when the action could not be applied. */
  error?: { code: string; message: string };
  /**
   * Set when the executor needs the user to disambiguate or confirm.
   *
   * `ambiguous` separates the two: without it this is a yes/no ("book it
   * anyway?", "delete the note?") that re-running with `confirmed` will apply.
   * With it, it is "which one did you mean?" — a question yes cannot answer,
   * because `confirmed` never turns an ambiguous match into a guess. Whoever
   * asked has to take that answer back to the model instead. `candidates` does
   * not tell them apart: a clash lists the events it collides with.
   */
  needsConfirmation?: {
    question: string;
    candidates?: { id: string; label: string }[];
    ambiguous?: boolean;
  };
  entityId?: string;
};

export type ExecuteOptions = {
  /**
   * The user answered a previous `needsConfirmation` with yes. Only ever
   * un-blocks a destructive-but-unambiguous action (deleting a note, booking
   * over a clash); it never turns an ambiguous match into a guess.
   */
  confirmed?: boolean;
};

/** Everything a handler decides; `execute` stamps the tool name on top. */
type Outcome = Omit<ActionResult, 'toolName'>;

/* ---------------------------------------------------------------- planning -- */

export type PhasePlanInput = {
  totalMinutes?: number;
  focusMinutes?: number;
  breakMinutes?: number;
  longBreakMinutes?: number;
  cyclesBeforeLongBreak?: number;
};

export const DEFAULT_FOCUS_MINUTES = 25;
export const DEFAULT_BREAK_MINUTES = 5;
export const DEFAULT_CYCLES_BEFORE_LONG_BREAK = 4;

/**
 * Turns "90 minutes, 25 on, 5 off" into the alternating phase plan the focus
 * runtime replays.
 *
 * Two properties the caller depends on: the phases sum to exactly
 * `totalMinutes` (the last one is truncated rather than overshooting the budget
 * the user gave), and a zero-length break is dropped instead of stored — the
 * runtime would consume it instantly, and a plan littered with 0-minute rows
 * makes "you have 3 blocks left" a lie. Without a total this is a single focus
 * block: "start a 25 minute timer" is one phase, not a pomodoro cycle.
 */
export function buildPhasePlan(input: PhasePlanInput): SessionPhase[] {
  const focus = Math.max(1, Math.round(input.focusMinutes ?? DEFAULT_FOCUS_MINUTES));
  const shortBreak = Math.max(0, Math.round(input.breakMinutes ?? DEFAULT_BREAK_MINUTES));
  const longBreak =
    input.longBreakMinutes === undefined ? null : Math.max(0, Math.round(input.longBreakMinutes));
  const cycles = Math.max(
    1,
    Math.round(input.cyclesBeforeLongBreak ?? DEFAULT_CYCLES_BEFORE_LONG_BREAK),
  );

  const total = input.totalMinutes === undefined ? null : Math.round(input.totalMinutes);
  if (total === null || total <= 0) return [{ kind: 'focus', minutes: focus }];

  const phases: SessionPhase[] = [];
  let remaining = total;
  let finishedFocusBlocks = 0;

  while (remaining > 0) {
    const focusMinutes = Math.min(focus, remaining);
    phases.push({ kind: 'focus', minutes: focusMinutes });
    remaining -= focusMinutes;
    finishedFocusBlocks += 1;
    if (remaining <= 0) break;

    const useLong = longBreak !== null && finishedFocusBlocks % cycles === 0;
    const length = useLong ? longBreak! : shortBreak;
    // A zero break means back-to-back focus blocks, not a phase of no length.
    if (length <= 0) continue;
    const breakMinutes = Math.min(length, remaining);
    phases.push({ kind: 'break', minutes: breakMinutes });
    remaining -= breakMinutes;
  }

  return phases;
}

/* ------------------------------------------------------------------ policy -- */

/** Default notice before an event; an exam earns an hour instead of ten minutes. */
export const DEFAULT_REMINDER_MINUTES = 10;
export const EXAM_REMINDER_MINUTES = 60;
/** Spec 2.1: an event with no end and no duration is an hour long. */
export const DEFAULT_EVENT_MINUTES = 60;

/** Words that mark work whose deadline the timetable can answer for. */
const HOMEWORK_RE =
  /\b(homework|assignment|coursework|problem set|problem sheet|revision|revise|revising|study|studying|exercises)\b/i;

/**
 * Sections whose items are things to acquire or carry, which are only useful
 * as checkboxes. Ideas and questions stay plain bullets.
 */
const TICKABLE_SECTION_RE = /\b(pack|packing|shop|shopping|groceries|grocery|buy|bring|supplies|kit|todo|to-do|tasks?|checklist)\b/i;

const ALL_SEARCH_SCOPES = [
  'notes',
  'tasks',
  'checklists',
  'projects',
  'crm',
  'ledger',
  'calendar',
] as const;

/** Below this a search hit is noise rather than an answer. */
const SEARCH_THRESHOLD = 0.42;

const MINUTE_MS = 60_000;

/**
 * The outbox vocabulary the calendar worker drains (`SYNC_OPERATIONS` and
 * `CALENDAR_ENTITY_TABLE` in `@/services/calendar/sync`). Spelled out here
 * rather than imported so `src/llm` keeps its one-way dependency on
 * repositories and never reaches into `src/services`.
 *
 * One name covers create *and* update because the queue dedupes on
 * (operation, entityId): three quick edits before the worker wakes must
 * collapse into a single push, and whether that push is a POST or a PUT is
 * decided from the row itself.
 */
const SYNC_PUSH = 'calendar.push';
const SYNC_DELETE = 'calendar.delete';
const CALENDAR_ENTITY_TABLE = 'calendar_events';

/* ----------------------------------------------------------------- helpers -- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const LABEL_KEYS = [
  'title',
  'name',
  'label',
  'content',
  'itemText',
  'titleSummary',
  'subject',
  'commitmentText',
] as const;

/**
 * Digs the disambiguation candidates out of an AppError's details.
 *
 * Every repository reports ambiguity, but each shapes `details` around its own
 * rows. Rather than teach each call site a different shape, pull the (id,label)
 * pairs out here. A list with no ids (some repositories only report titles)
 * yields nothing: a candidate the UI cannot act on is worse than none, and the
 * error's own sentence already names the options.
 */
export function candidatesFrom(details: unknown): { id: string; label: string }[] | undefined {
  const rows = Array.isArray(details)
    ? details
    : isRecord(details)
      ? [details.matches, details.candidates, details.options].find((v) => Array.isArray(v))
      : undefined;
  if (!Array.isArray(rows)) return undefined;

  const out: { id: string; label: string }[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const id = typeof row.id === 'string' ? row.id : null;
    if (!id) continue;
    const key = LABEL_KEYS.find((k) => typeof row[k] === 'string');
    out.push({ id, label: key ? String(row[key]) : id });
  }
  return out.length > 0 ? out : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * SQLite's `NOCASE` — the collation the note index actually collides on — folds
 * ASCII and nothing else. `toLowerCase()` folds the whole of Unicode, so it
 * calls "ПЛАН" and "план" one note where the database sees two, and then we
 * report an append that never happened.
 */
function foldNocase(value: string): string {
  return value.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function done(summary: string, extra: Partial<Outcome> = {}): Outcome {
  return { ok: true, summary, ...extra };
}

function failure(code: AppErrorCode | string, message: string, extra: Partial<Outcome> = {}): Outcome {
  return { ok: false, summary: message, error: { code, message }, ...extra };
}

function ask(
  question: string,
  candidates?: { id: string; label: string }[],
  extra: Partial<Outcome> = {},
): Outcome {
  return {
    ok: false,
    summary: question,
    needsConfirmation: candidates && candidates.length > 0 ? { question, candidates } : { question },
    ...extra,
  };
}

/** The single funnel from a repository `Err` to something the user hears. */
function fromAppError(error: AppError, extra: Partial<Outcome> = {}): Outcome {
  if (error.code === 'ambiguous') {
    const asked = ask(error.userMessage, candidatesFrom(error.details), extra);
    return { ...asked, needsConfirmation: { ...asked.needsConfirmation!, ambiguous: true } };
  }
  return failure(error.code, error.userMessage, extra);
}

function joinDetail(parts: (string | null | undefined)[]): string | undefined {
  const kept = parts.filter((p): p is string => Boolean(p && p.trim()));
  return kept.length > 0 ? kept.join(' ') : undefined;
}

function quote(value: string): string {
  return `“${truncate(value, 80)}”`;
}

/* ---------------------------------------------------------------- executor -- */

export function createExecutor(ctx: ExecutionContext) {
  const { repos, zone, logger } = ctx;
  const effects = ctx.effects ?? {};

  /**
   * The one place a wall-clock string from the model becomes an instant.
   * Everything DST-related is therefore decided here, and an unparseable value
   * becomes a clean `invalid_input` result rather than a thrown Error.
   */
  function toEpoch(value: string, label: string): number {
    try {
      return localToEpoch(value, zone);
    } catch {
      throw new AppError('invalid_input', `I could not make sense of the ${label} “${value}”.`);
    }
  }

  function toEpochMaybe(value: string | undefined, label: string): number | undefined {
    return value === undefined ? undefined : toEpoch(value, label);
  }

  /** An effect must never be able to fail the mutation it decorates. */
  async function safely<T>(what: string, run: () => Promise<T> | undefined): Promise<T | null> {
    try {
      return (await run()) ?? null;
    } catch (error) {
      logger?.warn(`executor effect "${what}" failed`, { error });
      return null;
    }
  }

  /**
   * A project named by the model becomes an id. An ambiguous name deliberately
   * files the row nowhere rather than into the wrong project — the row is still
   * findable, whereas a wrong parent is invisible.
   */
  async function projectIdFor(name: string | undefined): Promise<string | null> {
    const trimmed = name?.trim();
    if (!trimmed) return null;
    const resolved = await repos.projects.resolveProject(trimmed);
    if (resolved.ok) return resolved.value.id;
    if (resolved.error.code === 'ambiguous') {
      logger?.warn('ambiguous project name left unfiled', { name: trimmed });
      return null;
    }
    return (await repos.projects.getOrCreateProject(trimmed)).id;
  }

  /**
   * Spec 2.1.2: homework for a subject is due before that subject's next class.
   * The model normally works this out from the timetable in its prompt, but the
   * executor has to reach the same answer on its own when it does not.
   */
  async function inferHomeworkDue(
    text: string,
  ): Promise<{ subject: string; dueAt: number; classStartsAt: number } | null> {
    if (!HOMEWORK_RE.test(text)) return null;

    const haystack = normalise(text);
    const subjects = await repos.curriculum.distinctSubjects();
    const subject = subjects.find((candidate) => {
      const needle = normalise(candidate);
      return needle.length > 0 && new RegExp(`\\b${escapeRegExp(needle)}\\b`).test(haystack);
    });
    if (!subject) return null;

    const due = await repos.curriculum.dueDateForHomework(subject, { from: ctx.now, zone });
    return due.ok ? due.value : null;
  }

  function homeworkReason(inferred: { subject: string; classStartsAt: number }): string {
    return `Due the day before your next ${inferred.subject} class on ${formatDateTime(
      inferred.classStartsAt,
      zone,
    )}.`;
  }

  /**
   * The durable half of every calendar write; the effect underneath only tries
   * to make it land now.
   *
   * The payload carries the remote ids and nothing else. A push re-reads the
   * row, so copying the event into the queue would only let the two drift — but
   * a retraction *cannot* re-read it: by the time the worker runs the row is
   * gone, and these three ids are the only handle left on the copies sitting in
   * Google and in the phone's own calendar.
   */
  async function enqueueCalendarSync(
    event: CalendarEvent,
    operation: 'push' | 'delete',
  ): Promise<void> {
    await repos.syncQueue.enqueue({
      operation: operation === 'delete' ? SYNC_DELETE : SYNC_PUSH,
      entityTable: CALENDAR_ENTITY_TABLE,
      entityId: event.id,
      payload: {
        googleEventId: event.googleEventId,
        googleCalendarId: event.googleCalendarId,
        nativeEventId: event.nativeEventId,
      },
    });
    await safely('syncCalendarEvent', () => effects.syncCalendarEvent?.(event.id));
  }

  async function scheduleEventReminder(
    event: CalendarEvent,
    minutesBefore: number | undefined,
  ): Promise<number | null> {
    const lead = minutesBefore ?? (event.kind === 'exam' ? EXAM_REMINDER_MINUTES : DEFAULT_REMINDER_MINUTES);
    const at = event.startsAt - lead * MINUTE_MS;
    // A reminder in the past fires the instant it is scheduled, which reads as
    // a bug rather than a reminder.
    if (at <= ctx.now) return null;

    const scheduled = await safely('scheduleReminder', () =>
      effects.scheduleReminder?.({
        title: event.title,
        body: event.location
          ? `${formatSpokenTime(event.startsAt, zone)} · ${event.location}`
          : formatSpokenTime(event.startsAt, zone),
        at,
        data: { entityId: event.id, entityType: 'calendar_event' },
      }),
    );
    // No port wired up, notification permission denied, or a scheduler that
    // threw: the event is booked either way, but telling the user about a
    // reminder that will never fire is worse than saying nothing about one.
    return scheduled === null ? null : lead;
  }

  /**
   * A buffer exists only to end where its event begins, so an event that moves
   * has to drag it along; left behind it is a phantom "Leave for the dentist"
   * block at a time nothing happens, both here and in the calendars we pushed
   * it to. Its length is what the user agreed to, so that is what is preserved.
   */
  async function moveBuffersWith(event: CalendarEvent): Promise<void> {
    for (const buffer of await repos.calendar.listBuffersFor(event.id)) {
      if (buffer.deletedAt !== null) continue;
      const length = buffer.endsAt - buffer.startsAt;
      const moved = await repos.calendar.updateEvent(buffer.id, {
        startsAt: event.startsAt - length,
        endsAt: event.startsAt,
      });
      if (moved.ok) await enqueueCalendarSync(moved.value, 'push');
      else logger?.warn('could not move a buffer with its event', { id: buffer.id });
    }
  }

  async function resolveEventTarget(target: EntityQuery) {
    return repos.calendar.resolveEvent({
      query: target.query,
      onDate: target.on_date,
      nearTime: toEpochMaybe(target.near_time, 'time'),
      zone,
    });
  }

  /* ------------------------------------------------------------- calendar -- */

  /**
   * The one clash question, shared by booking and moving.
   *
   * Buffers are excluded: an auto-created travel block always abuts the event
   * it belongs to, so counting it as a conflict would make every buffered
   * event unbookable. Returns an `ask` outcome, or null when the slot is free.
   */
  async function clashCheck(input: {
    startsAt: number;
    endsAt: number;
    title: string;
    excludeId?: string;
  }): Promise<Outcome | null> {
    const clashes = (
      await repos.calendar.findConflicts({
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        ...(input.excludeId ? { excludeId: input.excludeId } : {}),
      })
    ).filter((row) => row.kind !== 'buffer' && row.bufferForId !== input.excludeId);
    const clash = clashes[0];
    if (!clash) return null;

    const alternative = await repos.calendar.suggestAlternativeSlot({
      startsAt: input.startsAt,
      endsAt: input.endsAt,
    });
    const when = alternative
      ? ` I could put it at ${formatSpokenTime(alternative.startsAt, zone)} instead.`
      : ' I could not find a free slot later that day.';
    return ask(
      `${quote(input.title)} clashes with ${quote(clash.title)} at ${formatSpokenTime(
        clash.startsAt,
        zone,
      )}.${when} Book it anyway?`,
      clashes.slice(0, 5).map((row) => ({ id: row.id, label: row.title })),
      {
        href: '/calendar',
        detail: alternative
          ? `Free slot: ${formatDateTime(alternative.startsAt, zone)}.`
          : undefined,
      },
    );
  }

  async function calendarAdd(
    params: ActionParams<'calendar_add'>,
    options: ExecuteOptions,
  ): Promise<Outcome> {
    const allDay = params.all_day === true;
    let startsAt = toEpoch(params.start, 'start time');
    let reason: string | null = null;

    // The contract makes `start` mandatory, so "no time given" surfaces as a
    // bare midnight — the model resolved the day and had nothing to say about
    // the hour. That is exactly the case the timetable can answer. The schema
    // accepts a space between date and time as well as a `T`, so both spellings
    // have to reach the inference.
    const timeless = !allDay && /[T ]00:00(:00)?$/.test(params.start);
    if (timeless && !params.schedule_reason) {
      const inferred = await inferHomeworkDue(`${params.title} ${params.description ?? ''}`);
      if (inferred) {
        startsAt = inferred.dueAt;
        reason = homeworkReason(inferred);
      }
    }

    let endsAt: number;
    if (allDay) {
      const bounds = dayRange(localDateOf(startsAt, zone), zone);
      startsAt = bounds.start;
      endsAt = bounds.end;
    } else if (params.end !== undefined) {
      endsAt = toEpoch(params.end, 'end time');
      if (endsAt < startsAt) {
        return failure('invalid_input', 'That event would end before it starts.');
      }
    } else {
      endsAt = startsAt + (params.duration_minutes ?? DEFAULT_EVENT_MINUTES) * MINUTE_MS;
    }

    // An all-day event overlaps everything on the day by definition, so a clash
    // check on one would only ever produce a pointless question.
    if (!allDay && options.confirmed !== true) {
      const clash = await clashCheck({ startsAt, endsAt, title: params.title });
      if (clash) return clash;
    }

    const projectId = await projectIdFor(params.project);
    const { event, buffer } = await repos.calendar.createEventWithBuffer(
      {
        title: params.title,
        startsAt,
        endsAt,
        description: params.description ?? null,
        location: params.location ?? null,
        allDay,
        timezone: zone,
        kind: params.kind,
        projectId,
        needsBuffer: params.needs_buffer,
      },
      { bufferMinutes: params.buffer_minutes },
    );

    await enqueueCalendarSync(event, 'push');
    if (buffer) await enqueueCalendarSync(buffer, 'push');
    const lead = await scheduleEventReminder(event, params.reminder_minutes_before);

    const when = allDay
      ? `on ${epochToLocal(startsAt, zone).toFormat('ccc d LLL')}`
      : `on ${formatDateTime(startsAt, zone)}`;
    return done(`Added ${quote(event.title)} ${when}.`, {
      entityId: event.id,
      href: '/calendar',
      detail: joinDetail([
        reason,
        params.schedule_reason,
        buffer ? `Blocked ${formatDuration((event.startsAt - buffer.startsAt) / MINUTE_MS)} before it for ${buffer.title.toLowerCase()}.` : null,
        lead === null ? null : `Reminder ${formatDuration(lead)} before.`,
      ]),
    });
  }

  async function calendarUpdate(
    params: ActionParams<'calendar_update'>,
    options: ExecuteOptions,
  ): Promise<Outcome> {
    const resolved = await resolveEventTarget(params.target);
    if (!resolved.ok) return fromAppError(resolved.error, { href: '/calendar' });
    const current = resolved.value;

    const startsAt = toEpochMaybe(params.start, 'start time');
    let endsAt = toEpochMaybe(params.end, 'end time');
    if (endsAt === undefined && params.duration_minutes !== undefined) {
      endsAt = (startsAt ?? current.startsAt) + params.duration_minutes * MINUTE_MS;
    }
    // "Move it to 3" keeps the length the user already agreed to.
    if (endsAt === undefined && startsAt !== undefined) {
      endsAt = startsAt + (current.endsAt - current.startsAt);
    }
    if (endsAt !== undefined && endsAt < (startsAt ?? current.startsAt)) {
      return failure('invalid_input', 'That event would end before it starts.');
    }

    // Moving onto an occupied slot deserves the same question as booking one.
    if (startsAt !== undefined && startsAt !== current.startsAt && options.confirmed !== true) {
      const clash = await clashCheck({
        startsAt,
        endsAt: endsAt ?? startsAt + (current.endsAt - current.startsAt),
        excludeId: current.id,
        title: params.title ?? current.title,
      });
      if (clash) return clash;
    }

    const updated = await repos.calendar.updateEvent(current.id, {
      ...(params.title !== undefined ? { title: params.title } : {}),
      ...(params.location !== undefined ? { location: params.location } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(startsAt !== undefined ? { startsAt } : {}),
      ...(endsAt !== undefined ? { endsAt } : {}),
    });
    if (!updated.ok) return fromAppError(updated.error, { href: '/calendar' });

    await enqueueCalendarSync(updated.value, 'push');

    let lead: number | null = null;
    if (startsAt !== undefined && startsAt !== current.startsAt) {
      await moveBuffersWith(updated.value);
      // The old notification points at a time that no longer exists. We cannot
      // recover the lead the user originally asked for, so the event keeps *a*
      // reminder at the default notice rather than silently losing one.
      await safely('cancelReminders', () => effects.cancelReminders?.(current.id));
      lead = await scheduleEventReminder(updated.value, undefined);
    }

    return done(`Moved ${quote(updated.value.title)} to ${formatDateTime(updated.value.startsAt, zone)}.`, {
      entityId: updated.value.id,
      href: '/calendar',
      detail: lead === null ? undefined : `Reminder ${formatDuration(lead)} before.`,
    });
  }

  async function calendarDelete(params: ActionParams<'calendar_delete'>): Promise<Outcome> {
    const resolved = await resolveEventTarget(params.target);
    if (!resolved.ok) return fromAppError(resolved.error, { href: '/calendar' });
    const event = resolved.value;

    // Read before the delete: a hard delete cascades the buffers away, and
    // their remote ids go with them. They were pushed when the event was
    // booked, so without this they outlive it in Google and on the device.
    const buffers = (await repos.calendar.listBuffersFor(event.id)).filter(
      (row) => row.deletedAt === null,
    );

    const removed =
      params.mode === 'cancel'
        ? await repos.calendar.softDelete(event.id)
        : await repos.calendar.hardDelete(event.id);
    if (!removed.ok) return fromAppError(removed.error, { href: '/calendar' });

    await safely('cancelReminders', () => effects.cancelReminders?.(event.id));
    await enqueueCalendarSync(removed.value, 'delete');
    for (const buffer of buffers) await enqueueCalendarSync(buffer, 'delete');

    return done(
      params.mode === 'cancel'
        ? `Cancelled ${quote(event.title)} on ${formatDateTime(event.startsAt, zone)}.`
        : `Deleted ${quote(event.title)}.`,
      { entityId: event.id, href: '/calendar' },
    );
  }

  /* ---------------------------------------------------------------- notes -- */

  async function noteCreate(params: ActionParams<'note_create'>): Promise<Outcome> {
    const projectId = await projectIdFor(params.project);
    // "Add to my Robotics note" and "make a Robotics note" are the same
    // utterance to the user, so the upsert decides; we only look first to be
    // able to say which of the two happened.
    const existing = (
      await repos.notes.listNotes({ tag: params.category_tag, includeArchived: true })
    ).find((note) => foldNocase(note.titleSummary) === foldNocase(params.title_summary));

    const note = await repos.notes.upsertNoteWithBullets({
      titleSummary: params.title_summary,
      categoryTag: params.category_tag,
      bullets: params.bullets,
      projectId,
    });

    return done(
      existing
        ? `Added ${countLabel(params.bullets.length, 'line')} to ${quote(note.titleSummary)}.`
        : `Noted ${quote(note.titleSummary)} under #${note.categoryTag}.`,
      { entityId: note.id, href: `/note/${note.id}` },
    );
  }

  async function noteUpdate(params: ActionParams<'note_update'>): Promise<Outcome> {
    const resolved = await repos.notes.resolveNote(params.target.query);
    if (!resolved.ok) return fromAppError(resolved.error, { href: '/notes' });
    const note = resolved.value;
    const href = `/note/${note.id}`;

    const appended = params.append_bullets ?? [];
    if (appended.length > 0) {
      const result = await repos.notes.appendBullets(note.id, appended);
      if (!result.ok) return fromAppError(result.error, { href, entityId: note.id });
    }

    if (params.new_title_summary !== undefined || params.new_category_tag !== undefined) {
      const patched = await repos.notes.updateNote(note.id, {
        ...(params.new_title_summary !== undefined
          ? { titleSummary: params.new_title_summary }
          : {}),
        ...(params.new_category_tag !== undefined ? { categoryTag: params.new_category_tag } : {}),
      });
      if (!patched.ok) return fromAppError(patched.error, { href, entityId: note.id });
    }

    const title = params.new_title_summary ?? note.titleSummary;
    return done(
      appended.length > 0
        ? `Added ${countLabel(appended.length, 'line')} to ${quote(title)}.`
        : `Updated ${quote(title)}.`,
      { entityId: note.id, href },
    );
  }

  async function noteDelete(
    params: ActionParams<'note_delete'>,
    options: ExecuteOptions,
  ): Promise<Outcome> {
    const resolved = await repos.notes.resolveNote(params.target.query);
    if (!resolved.ok) return fromAppError(resolved.error, { href: '/notes' });
    const note = resolved.value;
    const href = `/note/${note.id}`;

    const deleted = await repos.notes.deleteNote(note.id, { confirmed: options.confirmed === true });
    if (!deleted.ok) {
      // The repository refuses an unconfirmed delete by design; that refusal is
      // the question, not a failure.
      if (deleted.error.code === 'invalid_input') {
        return ask(
          `Delete the note ${quote(note.titleSummary)}? That cannot be undone.`,
          [{ id: note.id, label: note.titleSummary }],
          { entityId: note.id, href },
        );
      }
      return fromAppError(deleted.error, { href, entityId: note.id });
    }

    return done(`Deleted ${quote(deleted.value.titleSummary)}.`, {
      entityId: note.id,
      href: '/notes',
    });
  }

  /* ------------------------------------------------------ habits & activity -- */

  async function habitLog(params: ActionParams<'habit_log'>): Promise<Outcome> {
    const result = await repos.habits.logHabit({
      habitName: params.habit_name,
      ...(params.duration_minutes !== undefined ? { durationMinutes: params.duration_minutes } : {}),
      ...(params.note !== undefined ? { note: params.note } : {}),
      ...(params.on_date !== undefined ? { onDate: params.on_date } : {}),
    });

    const duration = params.duration_minutes ? ` — ${formatDuration(params.duration_minutes)}` : '';
    return done(`Logged ${result.habit.name}${duration}.`, {
      entityId: result.habit.id,
      href: '/habits',
      detail: result.streak > 1 ? `${countLabel(result.streak, 'day')} in a row.` : undefined,
    });
  }

  async function activityLog(params: ActionParams<'activity_log'>): Promise<Outcome> {
    const projectId = await projectIdFor(params.project);
    const entry = await repos.activity.log({
      description: params.description,
      ...(params.duration_minutes !== undefined ? { durationMinutes: params.duration_minutes } : {}),
      ...(params.habit_name !== undefined ? { habitName: params.habit_name } : {}),
      ...(projectId ? { projectId } : {}),
      ...(params.at !== undefined ? { at: toEpoch(params.at, 'time') } : {}),
    });

    const duration = params.duration_minutes ? ` (${formatDuration(params.duration_minutes)})` : '';
    return done(`Logged ${quote(entry.description)}${duration}.`, {
      entityId: entry.id,
      href: '/activity',
    });
  }

  /* ---------------------------------------------------------------- timers -- */

  async function timerStart(params: ActionParams<'timer_start'>): Promise<Outcome> {
    const phases = buildPhasePlan({
      ...(params.total_minutes !== undefined ? { totalMinutes: params.total_minutes } : {}),
      focusMinutes: params.focus_minutes,
      breakMinutes: params.break_minutes,
      ...(params.long_break_minutes !== undefined
        ? { longBreakMinutes: params.long_break_minutes }
        : {}),
      ...(params.cycles_before_long_break !== undefined
        ? { cyclesBeforeLongBreak: params.cycles_before_long_break }
        : {}),
    });

    // Two "running" sessions would make `getActive()` a coin toss and orphan the
    // older row forever, so starting one always retires the last.
    const previous = await repos.focus.getActive();
    if (previous) await repos.focus.cancel(previous.id, ctx.now);

    const projectId = await projectIdFor(params.project);
    const session = await repos.focus.create({
      label: params.label,
      subject: params.subject ?? null,
      projectId,
      phases,
    });
    await safely('startFocusSession', () => effects.startFocusSession?.(session.id));

    const totalMinutes = phases.reduce((sum, phase) => sum + phase.minutes, 0);
    const focusBlocks = phases.filter((phase) => phase.kind === 'focus').length;
    return done(
      `Started ${quote(session.label)} — ${formatDuration(totalMinutes)} in ${countLabel(focusBlocks, 'block')}.`,
      {
        entityId: session.id,
        href: '/focus',
        detail: joinDetail([
          // "25 on, 5 off" describes a cycle. A plain "start a 25 minute timer"
          // has one block and no break, and saying otherwise invents a rhythm
          // the plan does not contain.
          phases.some((phase) => phase.kind === 'break')
            ? `${params.focus_minutes} on, ${params.break_minutes} off.`
            : null,
          previous ? `Stopped ${quote(previous.label)} first.` : null,
        ]),
      },
    );
  }

  async function timerControl(params: ActionParams<'timer_control'>): Promise<Outcome> {
    const session = await repos.focus.getActive();
    if (!session) return failure('not_found', 'No focus session is running.', { href: '/focus' });

    const result =
      params.action === 'pause'
        ? await repos.focus.pause(session.id, ctx.now)
        : params.action === 'resume'
          ? await repos.focus.resume(session.id, ctx.now)
          : params.action === 'stop'
            ? await repos.focus.cancel(session.id, ctx.now)
            : await repos.focus.advancePhase(session.id, ctx.now);
    if (!result.ok) return fromAppError(result.error, { href: '/focus', entityId: session.id });

    await safely('controlFocusSession', () => effects.controlFocusSession?.(params.action));

    const spoken: Record<typeof params.action, string> = {
      pause: `Paused ${quote(session.label)}.`,
      resume: `Back on ${quote(session.label)}.`,
      stop: `Stopped ${quote(session.label)}.`,
      skip: `Skipped ahead in ${quote(session.label)}.`,
    };
    return done(spoken[params.action], { entityId: session.id, href: '/focus' });
  }

  /* ---------------------------------------------------------------- ledger -- */

  async function ledgerAdd(params: ActionParams<'ledger_add'>): Promise<Outcome> {
    const projectId = await projectIdFor(params.project);
    const row = await repos.ledger.addTransaction({
      amount: params.amount,
      currency: params.currency,
      category: params.category,
      entityName: params.entity_name ?? null,
      description: params.description ?? null,
      direction: params.direction,
      ...(params.at !== undefined ? { at: toEpoch(params.at, 'time') } : {}),
      projectId,
      zone,
    });

    const money = formatMoney(row.amount, row.currency);
    return done(
      params.direction === 'income'
        ? `Recorded ${money} in from ${row.entityName ?? row.category}.`
        : `Logged ${money} on ${row.category}.`,
      { entityId: row.id, href: '/ledger' },
    );
  }

  function periodPhrase(period: ActionParams<'ledger_query'>['period']): string {
    switch (period) {
      case 'today':
        return 'today';
      case 'week':
        return 'this week';
      case 'month':
        return 'this month';
      case 'year':
        return 'this year';
      case 'all':
        return 'in total';
      default:
        return 'in that period';
    }
  }

  async function ledgerQuery(params: ActionParams<'ledger_query'>): Promise<Outcome> {
    const result = await repos.ledger.query({
      ...(params.category !== undefined ? { category: params.category } : {}),
      ...(params.entity_name !== undefined ? { entityName: params.entity_name } : {}),
      direction: params.direction,
      period: params.period,
      ...(params.from !== undefined ? { from: params.from } : {}),
      ...(params.to !== undefined ? { to: params.to } : {}),
      groupBy: params.group_by,
      zone,
    });

    const scope = joinDetail([
      params.category ? `on ${params.category}` : null,
      params.entity_name ? `with ${params.entity_name}` : null,
    ]);
    const where = scope ? ` ${scope}` : '';
    const when = periodPhrase(params.period);
    const verb =
      params.direction === 'income' ? 'took in' : params.direction === 'both' ? 'netted' : 'spent';

    const amounts = Object.entries(result.totalsByCurrency).filter(([, value]) => value !== 0);
    if (result.count === 0 || amounts.length === 0) {
      return done(`You have not ${verb} anything${where} ${when}.`, { href: '/ledger' });
    }

    const spoken = joinNatural(amounts.map(([currency, value]) => speakMoney(value, currency)));
    const top = result.groups
      .slice(0, 3)
      .map(
        (group) =>
          `${group.key}: ${formatMoney(group.total, result.primaryCurrency ?? 'EUR')}`,
      );

    return done(`You ${verb} ${spoken}${where} ${when}.`, {
      href: '/ledger',
      detail: joinDetail([
        top.length > 0 ? top.join(', ') : null,
        `${countLabel(result.count, 'entry', 'entries')}.`,
      ]),
    });
  }

  /* ------------------------------------------------------------ checklists -- */

  /**
   * The Lists pane of the Notes tab is the only screen a checklist has, so the
   * address has to carry the pane as well as the list.
   */
  function checklistHref(listName?: string): string {
    const name = listName?.trim();
    return name ? `/notes?pane=lists&list=${encodeURIComponent(name)}` : '/notes?pane=lists';
  }

  async function checklistAdd(params: ActionParams<'checklist_add'>): Promise<Outcome> {
    const projectId = await projectIdFor(params.project);
    const result = await repos.checklists.addItems(
      params.list_name,
      params.items,
      projectId ?? undefined,
    );

    const href = checklistHref(params.list_name);
    const changed = result.added.length + result.reopened.length;
    return done(
      changed === 0
        ? `Everything you named is already on the ${params.list_name} list.`
        : `Added ${countLabel(changed, 'item')} to the ${params.list_name} list.`,
      {
        href,
        detail: joinDetail([
          result.reopened.length > 0
            ? `Put back: ${joinNatural(result.reopened.map((row) => row.itemText))}.`
            : null,
          result.duplicates.length > 0
            ? `Already there: ${joinNatural(result.duplicates.map((row) => row.itemText))}.`
            : null,
        ]),
      },
    );
  }

  async function checklistToggle(params: ActionParams<'checklist_toggle'>): Promise<Outcome> {
    const result = await repos.checklists.toggle({
      ...(params.list_name !== undefined ? { listName: params.list_name } : {}),
      itemQuery: params.item_query,
      completed: params.completed,
    });
    if (!result.ok) return fromAppError(result.error, { href: checklistHref() });

    const row = result.value;
    const href = checklistHref(row.listName);
    return done(
      params.completed
        ? `Ticked off ${row.itemText}.`
        : `Put ${row.itemText} back on the ${row.listName} list.`,
      { entityId: row.id, href },
    );
  }

  /* ------------------------------------------------------ places & geofences -- */

  async function geofenceAdd(params: ActionParams<'geofence_add'>): Promise<Outcome> {
    const expiresAt =
      params.expires_in_days === undefined
        ? null
        : epochToLocal(ctx.now, zone).plus({ days: params.expires_in_days }).toMillis();

    const forPlace = await repos.geofences.createTriggerForPlace({
      placeQuery: params.label,
      label: params.label,
      actionDescription: params.action_description,
      triggerType: params.trigger_type,
      radiusMeters: params.radius_meters,
      oneShot: params.one_shot,
      expiresAt,
    });

    if (forPlace.ok) {
      await safely('registerGeofences', () => effects.registerGeofences?.());
      return done(
        `I will remind you when you ${params.trigger_type === 'ENTER' ? 'get to' : 'leave'} ${forPlace.value.label}.`,
        { entityId: forPlace.value.id, href: '/places' },
      );
    }

    if (forPlace.error.code === 'ambiguous') {
      return fromAppError(forPlace.error, { href: '/places' });
    }

    // A place we have never been given coordinates for cannot be invented — the
    // reminder would fire in the wrong city. Coordinates the caller *did* supply
    // are honoured, and everything else asks the user to drop a pin.
    if (params.latitude === undefined || params.longitude === undefined) {
      return failure(
        'not_found',
        `I do not know where ${quote(params.label)} is — pin it on the map and I will set the reminder.`,
        { href: '/places' },
      );
    }

    const place = await repos.places.upsertPlace({
      label: params.label,
      latitude: params.latitude,
      longitude: params.longitude,
      radiusMeters: params.radius_meters,
    });
    const trigger = await repos.geofences.createTrigger({
      label: params.label,
      actionDescription: params.action_description,
      triggerType: params.trigger_type,
      latitude: params.latitude,
      longitude: params.longitude,
      radiusMeters: params.radius_meters,
      oneShot: params.one_shot,
      expiresAt,
      placeId: place.id,
    });
    await safely('registerGeofences', () => effects.registerGeofences?.());

    return done(
      `Saved ${place.label} and I will remind you when you ${params.trigger_type === 'ENTER' ? 'get there' : 'leave'}.`,
      { entityId: trigger.id, href: '/places' },
    );
  }

  async function placeSave(params: ActionParams<'place_save'>): Promise<Outcome> {
    const place = await repos.places.upsertPlace({
      label: params.label,
      latitude: params.latitude,
      longitude: params.longitude,
      radiusMeters: params.radius_meters,
      address: params.address ?? null,
    });
    // A pin that moved changes which regions the OS should be watching.
    await safely('registerGeofences', () => effects.registerGeofences?.());
    return done(`Saved ${place.label}.`, { entityId: place.id, href: '/places' });
  }

  /* ------------------------------------------------------------------- crm -- */

  async function crmAddCommitment(params: ActionParams<'crm_add_commitment'>): Promise<Outcome> {
    const dueDate = toEpochMaybe(params.due, 'due date') ?? null;
    const owed = params.direction === 'i_owe';

    // Two tables, two writes, no shared transaction — so the commitment goes
    // first. If the task write then fails the user still has the promise on
    // record, whereas the other order can leave a task pointing at a commitment
    // that was never created.
    const result = await repos.crm.addCommitment({
      entityName: params.entity_name,
      commitmentText: params.commitment_text,
      dueDate,
      direction: params.direction,
      ...(params.relationship_context !== undefined
        ? { relationshipContext: params.relationship_context }
        : {}),
      // Always leaves a trace of the conversation, even when the model only
      // captured the promise itself.
      interactionSummary:
        params.interaction_summary ??
        (owed ? `Promised: ${params.commitment_text}` : `Owed to you: ${params.commitment_text}`),
    });

    const task = params.create_task
      ? await repos.tasks.createTask({
          title: owed
            ? params.commitment_text
            : `Follow up with ${params.entity_name}: ${params.commitment_text}`,
          dueDate,
          notes: owed ? `Promised to ${params.entity_name}.` : `${params.entity_name} owes you this.`,
        })
      : null;
    // Linking the two is what keeps the Today list and the person's page in
    // step; a link that fails to write costs a cross-reference, not the data.
    if (task) await repos.crm.linkCommitmentTask(result.commitment.id, task.id);

    const when = dueDate === null ? '' : `, due ${formatDateTime(dueDate, zone)}`;
    return done(
      owed
        ? `Logged: you owe ${result.entity.name} ${quote(params.commitment_text)}${when}.`
        : `Logged: ${result.entity.name} owes you ${quote(params.commitment_text)}${when}.`,
      {
        entityId: result.entity.id,
        href: `/person/${result.entity.id}`,
        detail: task ? `Task added: ${quote(task.title)}.` : undefined,
      },
    );
  }

  async function crmLogInteraction(params: ActionParams<'crm_log_interaction'>): Promise<Outcome> {
    const result = await repos.crm.logInteraction({
      entityName: params.entity_name,
      summary: params.summary,
      ...(params.at !== undefined ? { occurredAt: toEpoch(params.at, 'time') } : {}),
      ...(params.relationship_context !== undefined
        ? { relationshipContext: params.relationship_context }
        : {}),
    });

    return done(`Noted that against ${result.entity.name}.`, {
      entityId: result.entity.id,
      href: `/person/${result.entity.id}`,
    });
  }

  /* ----------------------------------------------------------------- tasks -- */

  async function taskAdd(params: ActionParams<'task_add'>): Promise<Outcome> {
    let dueDate = toEpochMaybe(params.due, 'due date') ?? null;
    let reason: string | null = null;
    if (dueDate === null) {
      const inferred = await inferHomeworkDue(`${params.title} ${params.notes ?? ''}`);
      if (inferred) {
        dueDate = inferred.dueAt;
        reason = homeworkReason(inferred);
      }
    }

    const projectId = await projectIdFor(params.project);
    const prerequisites = params.depends_on ?? [];

    if (prerequisites.length > 0) {
      const linked = await repos.tasks.addDependencyByTitles({
        childTitle: params.title,
        parentTitles: prerequisites,
        childDue: dueDate,
        projectId,
      });
      if (!linked.ok) return fromAppError(linked.error, { href: '/tasks' });

      // `addDependencyByTitles` only knows title, due date and project, so the
      // rest of what the user said is applied afterwards. It reuses an existing
      // task when the title already matches, which is why this is a patch and
      // not a second create.
      const detail: UpdateTaskPatch = {};
      if (params.notes !== undefined) detail.notes = params.notes;
      if (params.priority !== undefined) detail.priority = params.priority;
      if (params.estimated_minutes !== undefined) {
        detail.estimatedMinutes = params.estimated_minutes;
      }
      if (Object.keys(detail).length > 0) {
        await repos.tasks.updateTask(linked.value.child.id, detail);
      }

      const parents = linked.value.parents;
      const child = (await repos.tasks.getTask(linked.value.child.id)) ?? linked.value.child;
      return done(`Added ${quote(child.title)}, blocked until ${joinNatural(parents.map((p) => p.title))} ${parents.length === 1 ? 'is' : 'are'} done.`, {
        entityId: child.id,
        href: '/tasks',
        detail: joinDetail([
          reason,
          linked.value.created.length > 0
            ? `Created: ${joinNatural(linked.value.created.map((t) => t.title))}.`
            : null,
        ]),
      });
    }

    const task = await repos.tasks.createTask({
      title: params.title,
      dueDate,
      notes: params.notes ?? null,
      projectId,
      priority: params.priority,
      estimatedMinutes: params.estimated_minutes ?? null,
    });

    const when = dueDate === null ? '' : `, due ${formatDateTime(dueDate, zone)}`;
    return done(`Task added: ${quote(task.title)}${when}.`, {
      entityId: task.id,
      href: '/tasks',
      detail: reason ?? undefined,
    });
  }

  async function taskAddDependency(params: ActionParams<'task_add_dependency'>): Promise<Outcome> {
    const projectId = await projectIdFor(params.project);
    const linked = await repos.tasks.addDependencyByTitles({
      childTitle: params.child,
      parentTitles: params.parents,
      childDue: toEpochMaybe(params.child_due, 'due date') ?? null,
      projectId,
    });
    if (!linked.ok) return fromAppError(linked.error, { href: '/tasks' });

    const { child, parents, created } = linked.value;
    return done(
      `${quote(child.title)} now waits on ${joinNatural(parents.map((p) => p.title))}.`,
      {
        entityId: child.id,
        href: '/tasks',
        detail: created.length > 0 ? `Created: ${joinNatural(created.map((t) => t.title))}.` : undefined,
      },
    );
  }

  async function taskComplete(params: ActionParams<'task_complete'>): Promise<Outcome> {
    const resolved = await repos.tasks.resolveTask(params.target.query, { includeCompleted: true });
    if (!resolved.ok) return fromAppError(resolved.error, { href: '/tasks' });
    const target = resolved.value;

    if (!params.completed) {
      const reopened = await repos.tasks.uncompleteTask(target.id);
      if (!reopened.ok) return fromAppError(reopened.error, { href: '/tasks' });
      const relocked = reopened.value.relocked;
      return done(`Reopened ${quote(target.title)}.`, {
        entityId: target.id,
        href: '/tasks',
        detail:
          relocked.length > 0
            ? `Blocked again: ${joinNatural(relocked.map((t) => t.title))}.`
            : undefined,
      });
    }

    const completed = await repos.tasks.completeTask(target.id);
    if (!completed.ok) return fromAppError(completed.error, { href: '/tasks' });

    const unlocked = completed.value.unlocked;
    return done(`Done: ${quote(target.title)}.`, {
      entityId: target.id,
      href: '/tasks',
      detail: unlocked.length > 0 ? `Unlocked: ${joinNatural(unlocked.map((t) => t.title))}.` : undefined,
    });
  }

  /* ------------------------------------------------------------ curriculum -- */

  async function curriculumAdd(params: ActionParams<'curriculum_add'>): Promise<Outcome> {
    const rows = params.replace_existing
      ? await repos.curriculum.replaceAll(params.entries)
      : await repos.curriculum.addEntries(params.entries);

    return done(
      params.replace_existing
        ? `Timetable replaced with ${countLabel(rows.length, 'class', 'classes')}.`
        : `Added ${countLabel(rows.length, 'class', 'classes')} to your timetable.`,
      {
        href: '/curriculum',
        detail: joinNatural([...new Set(rows.map((row) => row.subjectName))]) || undefined,
      },
    );
  }

  /* -------------------------------------------------------------- projects -- */

  async function projectCreate(params: ActionParams<'project_create'>): Promise<Outcome> {
    const project = await repos.projects.createProject({
      name: params.name,
      kind: params.kind,
      description: params.description ?? null,
      startDate: toEpochMaybe(params.start_date, 'start date') ?? null,
      targetDate: toEpochMaybe(params.target_date, 'target date') ?? null,
      emoji: params.emoji ?? null,
      ...(params.sections !== undefined ? { sections: params.sections } : {}),
    });

    return done(`Created the ${quote(project.name)} ${project.kind}.`, {
      entityId: project.id,
      href: `/project/${project.id}`,
      detail:
        params.sections && params.sections.length > 0
          ? `Sections: ${joinNatural(params.sections)}.`
          : undefined,
    });
  }

  async function projectAddItem(params: ActionParams<'project_add_item'>): Promise<Outcome> {
    let projectId: string;
    if (params.create_if_missing) {
      projectId = (await repos.projects.getOrCreateProject(params.project)).id;
    } else {
      const resolved = await repos.projects.resolveProject(params.project);
      if (!resolved.ok) return fromAppError(resolved.error, { href: '/projects' });
      projectId = resolved.value.id;
    }

    const inputs: ProjectItemInput[] = params.items.map((item) => ({
      content: item.content,
      kind: item.kind,
      detail: item.detail ?? null,
      // A packing or shopping section is a list of things to obtain: those are
      // only useful with a box beside them, whatever kind the model guessed.
      isCheckbox:
        item.is_checkbox ?? (item.kind === 'todo' || TICKABLE_SECTION_RE.test(item.section ?? '')),
      sectionTitle: item.section ?? null,
      dueDate: toEpochMaybe(item.due, 'due date') ?? null,
    }));

    const created = await repos.projects.addItems(projectId, inputs);
    const project = await repos.projects.getProject(projectId);

    return done(
      `Added ${countLabel(created.length, 'item')} to ${quote(project?.name ?? params.project)}.`,
      {
        entityId: projectId,
        href: `/project/${projectId}`,
        detail: joinNatural(created.slice(0, 4).map((item) => item.content)) || undefined,
      },
    );
  }

  async function projectItemToggle(params: ActionParams<'project_item_toggle'>): Promise<Outcome> {
    let projectId: string | undefined;
    if (params.project) {
      const resolved = await repos.projects.resolveProject(params.project);
      if (!resolved.ok) return fromAppError(resolved.error, { href: '/projects' });
      projectId = resolved.value.id;
    }

    const found = await repos.projects.resolveItem({
      ...(projectId ? { projectId } : {}),
      query: params.item_query,
    });
    if (!found.ok) {
      return fromAppError(found.error, {
        href: projectId ? `/project/${projectId}` : '/projects',
      });
    }

    const item = await repos.projects.toggleItem(found.value.id, params.completed);
    return done(
      params.completed ? `Ticked off ${quote(item.content)}.` : `Reopened ${quote(item.content)}.`,
      { entityId: item.id, href: `/project/${item.projectId}` },
    );
  }

  /* ------------------------------------------------------------- read-only -- */

  async function localBriefing(scope: 'today' | 'tomorrow' | 'week'): Promise<string> {
    if (scope === 'week') {
      const until = epochToLocal(ctx.now, zone).plus({ days: 7 }).toMillis();
      const events = (await repos.calendar.listBetween(ctx.now, until)).filter(
        (row) => row.kind !== 'buffer',
      );
      const tasks = await repos.tasks.listActiveTasks({ dueBefore: until });
      const promises = await repos.crm.listOpenCommitments({ dueBefore: until });
      return composeBriefing('This week', events, [], tasks.length, promises.length);
    }

    const date =
      scope === 'today'
        ? localDateOf(ctx.now, zone)
        : localDateOf(epochToLocal(ctx.now, zone).plus({ days: 1 }).toMillis(), zone);
    const { start, end } = dayRange(date, zone);
    const events = (await repos.calendar.listForLocalDate(date, zone)).filter(
      (row) => row.kind !== 'buffer',
    );
    const classes = await repos.curriculum.upcomingOccurrences({
      from: scope === 'today' ? Math.max(ctx.now, start) : start,
      days: 1,
      zone,
    });
    const tasks = await repos.tasks.listActiveTasks({ dueBefore: end });
    const promises = await repos.crm.listOpenCommitments({ dueBefore: end });
    return composeBriefing(
      scope === 'today' ? 'Today' : 'Tomorrow',
      events,
      classes.map((occurrence) => occurrence.entry.subjectName),
      tasks.length,
      promises.length,
    );
  }

  function composeBriefing(
    label: string,
    events: CalendarEvent[],
    classes: string[],
    taskCount: number,
    promiseCount: number,
  ): string {
    const parts: string[] = [];
    const first = events[0];
    if (first) {
      parts.push(
        `${countLabel(events.length, 'event')}, starting with ${first.title} at ${formatSpokenTime(first.startsAt, zone)}`,
      );
    }
    if (classes.length > 0) {
      parts.push(`${countLabel(classes.length, 'class', 'classes')} — ${joinNatural(classes)}`);
    }
    if (taskCount > 0) parts.push(`${countLabel(taskCount, 'task')} due`);
    if (promiseCount > 0) parts.push(`${countLabel(promiseCount, 'open promise')}`);
    return parts.length === 0 ? `${label} is clear.` : `${label}: ${joinNatural(parts)}.`;
  }

  async function briefingGenerate(params: ActionParams<'briefing_generate'>): Promise<Outcome> {
    const generated = await safely('generateBriefing', () => effects.generateBriefing?.(params.scope));
    const text = generated ?? (await localBriefing(params.scope));
    return done(text, { href: '/briefing', silent: params.speak === false });
  }

  function summaryRange(params: ActionParams<'summary_generate'>): { from: LocalDate; to: LocalDate } {
    const today = localDateOf(ctx.now, zone);
    if (params.period === 'day') return { from: today, to: today };
    if (params.period === 'custom') {
      return { from: params.from ?? today, to: params.to ?? today };
    }
    const { start, end } =
      params.period === 'week' ? weekRange(ctx.now, zone) : monthRange(ctx.now, zone);
    // `end` is exclusive; the summary range is inclusive on both ends.
    return { from: localDateOf(start, zone), to: localDateOf(end - 1, zone) };
  }

  async function summaryGenerate(params: ActionParams<'summary_generate'>): Promise<Outcome> {
    const range = summaryRange(params);
    const generated = await safely('generateSummary', () =>
      effects.generateSummary?.({ period: params.period, ...range, format: params.format }),
    );
    if (generated) return done(generated, { href: '/activity' });

    const activity = await repos.activity.summarise(range);
    const from = dayRange(range.from, zone).start;
    const to = dayRange(range.to, zone).end;
    const focusMinutes = await repos.focus.totalFocusMinutesBetween(from, to, ctx.now);

    if (activity.entries.length === 0 && focusMinutes === 0) {
      return done(`Nothing logged between ${range.from} and ${range.to}.`, { href: '/activity' });
    }

    const parts: string[] = [];
    if (activity.entries.length > 0) {
      parts.push(
        `${formatDuration(activity.totalMinutes)} across ${countLabel(activity.entries.length, 'entry', 'entries')}`,
      );
    }
    if (focusMinutes > 0) parts.push(`${formatDuration(focusMinutes)} of focus time`);
    const topProject = activity.byProject[0];
    if (topProject?.name) parts.push(`most of it on ${topProject.name}`);

    return done(`${range.from} to ${range.to}: ${joinNatural(parts)}.`, {
      href: '/activity',
      detail: joinDetail(
        activity.byHabit.slice(0, 3).map((habit) => `${habit.name ?? 'habit'} ×${habit.count}`),
      ),
    });
  }

  type SearchHit = { label: string; scope: string; score: number; href?: string };

  async function collectHits(query: string, scopes: Set<string>): Promise<SearchHit[]> {
    const hits: SearchHit[] = [];
    const consider = (label: string, scope: string, href?: string, aux?: string) => {
      const score = Math.max(scoreText(query, label), aux ? scoreText(query, aux) * 0.72 : 0);
      if (score >= SEARCH_THRESHOLD) hits.push({ label, scope, score, ...(href ? { href } : {}) });
    };

    if (scopes.has('notes')) {
      for (const hit of await repos.notes.searchNotes(query, 5)) {
        hits.push({
          label: hit.note.titleSummary,
          scope: 'note',
          // Backend scores are not comparable across scopes, so a note that the
          // index already agreed matched is ranked on its title like the rest.
          score: Math.max(scoreText(query, hit.note.titleSummary), SEARCH_THRESHOLD),
          href: `/note/${hit.note.id}`,
        });
      }
    }
    if (scopes.has('tasks')) {
      for (const task of await repos.tasks.listTasks({ limit: 200 })) {
        consider(task.title, 'task', '/tasks', task.notes ?? undefined);
      }
    }
    if (scopes.has('checklists')) {
      for (const list of await repos.checklists.listNames()) {
        for (const item of await repos.checklists.itemsForList(list.name)) {
          consider(
            item.itemText,
            'checklist item',
            checklistHref(item.listName),
            item.listName,
          );
        }
      }
    }
    if (scopes.has('projects')) {
      for (const project of await repos.projects.listProjects()) {
        consider(project.name, 'project', `/project/${project.id}`, project.description ?? undefined);
      }
    }
    if (scopes.has('crm')) {
      for (const row of await repos.crm.listEntities()) {
        consider(row.entity.name, 'contact', `/person/${row.entity.id}`, row.aliases.join(' '));
      }
    }
    if (scopes.has('ledger')) {
      for (const row of await repos.ledger.listRecent(200)) {
        consider(
          `${formatMoney(row.amount, row.currency)} · ${row.category}`,
          'transaction',
          '/ledger',
          [row.description, row.entityName, row.category].filter(Boolean).join(' '),
        );
      }
    }
    if (scopes.has('calendar')) {
      const today = epochToLocal(ctx.now, zone);
      const events = await repos.calendar.listBetween(
        today.minus({ days: 30 }).toMillis(),
        today.plus({ days: 90 }).toMillis(),
      );
      for (const event of events) {
        if (event.kind === 'buffer') continue;
        consider(event.title, 'event', '/calendar', event.location ?? undefined);
      }
    }

    return hits.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  }

  async function search(params: ActionParams<'search'>): Promise<Outcome> {
    const scopes = new Set<string>(params.scopes ?? ALL_SEARCH_SCOPES);
    const hits = await collectHits(params.query, scopes);
    if (hits.length === 0) {
      return done(`I found nothing for ${quote(params.query)}.`);
    }

    const best = hits[0]!;
    if (hits.length === 1) {
      return done(`One ${best.scope} matches ${quote(params.query)}: ${best.label}.`, {
        ...(best.href ? { href: best.href } : {}),
      });
    }

    const counts = new Map<string, number>();
    for (const hit of hits) counts.set(hit.scope, (counts.get(hit.scope) ?? 0) + 1);
    const breakdown = joinNatural(
      [...counts].map(([scope, count]) => countLabel(count, scope, `${scope}s`)),
    );

    return done(`Found ${countLabel(hits.length, 'match', 'matches')} for ${quote(params.query)}: ${breakdown}.`, {
      ...(best.href ? { href: best.href } : {}),
      detail: hits
        .slice(0, 5)
        .map((hit) => hit.label)
        .join(', '),
    });
  }

  /* -------------------------------------------------------------- dispatch -- */

  async function dispatch(action: LlmAction, options: ExecuteOptions): Promise<Outcome> {
    switch (action.tool_name) {
      case 'calendar_add':
        return calendarAdd(action.parameters, options);
      case 'calendar_update':
        return calendarUpdate(action.parameters, options);
      case 'calendar_delete':
        return calendarDelete(action.parameters);
      case 'note_create':
        return noteCreate(action.parameters);
      case 'note_update':
        return noteUpdate(action.parameters);
      case 'note_delete':
        return noteDelete(action.parameters, options);
      case 'habit_log':
        return habitLog(action.parameters);
      case 'activity_log':
        return activityLog(action.parameters);
      case 'timer_start':
        return timerStart(action.parameters);
      case 'timer_control':
        return timerControl(action.parameters);
      case 'ledger_add':
        return ledgerAdd(action.parameters);
      case 'ledger_query':
        return ledgerQuery(action.parameters);
      case 'checklist_add':
        return checklistAdd(action.parameters);
      case 'checklist_toggle':
        return checklistToggle(action.parameters);
      case 'geofence_add':
        return geofenceAdd(action.parameters);
      case 'place_save':
        return placeSave(action.parameters);
      case 'crm_add_commitment':
        return crmAddCommitment(action.parameters);
      case 'crm_log_interaction':
        return crmLogInteraction(action.parameters);
      case 'task_add':
        return taskAdd(action.parameters);
      case 'task_add_dependency':
        return taskAddDependency(action.parameters);
      case 'task_complete':
        return taskComplete(action.parameters);
      case 'curriculum_add':
        return curriculumAdd(action.parameters);
      case 'project_create':
        return projectCreate(action.parameters);
      case 'project_add_item':
        return projectAddItem(action.parameters);
      case 'project_item_toggle':
        return projectItemToggle(action.parameters);
      case 'briefing_generate':
        return briefingGenerate(action.parameters);
      case 'summary_generate':
        return summaryGenerate(action.parameters);
      case 'search':
        return search(action.parameters);
      default: {
        // A tool added to the contract without a handler is a compile error
        // here, which is the only place that guarantee can be made.
        const unreachable: never = action;
        throw new AppError('unsupported', 'I do not know how to do that yet.', {
          details: unreachable,
        });
      }
    }
  }

  async function execute(action: LlmAction, options: ExecuteOptions = {}): Promise<ActionResult> {
    try {
      const outcome = await dispatch(action, options);
      return { toolName: action.tool_name, ...outcome };
    } catch (error) {
      const appError = toAppError(error, 'That did not work.');
      logger?.error('executor action failed', { tool: action.tool_name, code: appError.code });
      return {
        toolName: action.tool_name,
        ok: false,
        summary: appError.userMessage,
        error: { code: appError.code, message: appError.userMessage },
      };
    }
  }

  /**
   * Sequential on purpose: a later action routinely depends on a row an earlier
   * one created ("start a Greece trip project, then add sunscreen to it"), and
   * one failure must never cost the user the rest of the utterance.
   */
  async function executeAll(actions: LlmAction[]): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    for (const action of actions) {
      results.push(await execute(action));
    }
    return results;
  }

  return { execute, executeAll };
}

export type Executor = ReturnType<typeof createExecutor>;
