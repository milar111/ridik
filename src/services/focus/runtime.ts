/**
 * The live focus-session driver.
 *
 * The row is the truth and `computeSessionState` is the only phase maths in the
 * app; everything here is reconciliation. Each tick asks the reducer where the
 * session is *now* instead of decrementing a counter, so a stalled JS thread, a
 * backgrounded app and a device that slept for three hours all resolve to the
 * same answer, and a late tick can never make the timer drift.
 *
 * The platform surfaces (Live Activity, Android ongoing notification) and the
 * notification scheduler are injected rather than imported: this file has to
 * stay loadable in plain Node so the reconciliation can be tested against a
 * real SQLite database with no Expo runtime. `./index.ts` is the composition
 * root that wires the real ones in.
 */
import { now } from '@/core/clock';
import type { Logger } from '@/core/logger';
import { err, fail, ok, toAppError, type Result } from '@/core/result';
import { formatClock } from '@/core/time';
import {
  computeSessionState,
  parsePhases,
  type FocusSession,
  type FocusSessionStatus,
  type FocusSessionsRepository,
  type SessionPhase,
  type SessionPhaseKind,
} from '@/repositories/focusSessions';

const MINUTE_MS = 60_000;
const TICK_MS = 1_000;

/**
 * iOS keeps at most 64 pending local notifications for the whole app, shared
 * with reminders and the briefing, so a long plan schedules only its next few
 * boundaries; the rest are filled in as the session advances.
 */
const MAX_SCHEDULED_TRANSITIONS = 8;

/**
 * A transition older than this was already announced by the local notification
 * that fired while the app was away. Chiming for it now would be a jump scare.
 */
const STALE_TRANSITION_MS = 60_000;

const DEFAULT_FOCUS_MINUTES = 25;
const DEFAULT_BREAK_MINUTES = 5;
const DEFAULT_CYCLES_BEFORE_LONG_BREAK = 4;
const MAX_CYCLES = 24;

const durationOf = (phase: SessionPhase): number => Math.round(phase.minutes * MINUTE_MS);

/**
 * The app logger reads `__DEV__` at import time, and this module has to load
 * outside React Native, so the real one is injected by the composition root.
 */
const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export type ChimeKind = SessionPhaseKind | 'complete';

/** What the UI renders and what the platform surfaces display. */
export type FocusSnapshot = {
  sessionId: string;
  label: string;
  subject: string | null;
  status: FocusSessionStatus;
  phase: SessionPhase;
  phaseIndex: number;
  phaseCount: number;
  phaseElapsedMs: number;
  phaseRemainingMs: number;
  totalRemainingMs: number;
  /** Wall-clock instant this phase runs out; null unless the session is running. */
  phaseEndsAt: number | null;
  isComplete: boolean;
  /** `mm:ss` left in this phase, formatted once so every surface agrees. */
  clock: string;
  /** When this snapshot was computed. */
  at: number;
};

/**
 * The lock-screen presence. Implementations must be cheap and must never throw:
 * `update` is called on every tick and does its own rate limiting.
 */
export type FocusSurface = {
  start(snapshot: FocusSnapshot): Promise<void> | void;
  update(snapshot: FocusSnapshot): Promise<void> | void;
  end(snapshot: FocusSnapshot | null): Promise<void> | void;
};

export type PlannedTransition = {
  sessionId: string;
  /** UTC epoch ms the transition happens. */
  at: number;
  kind: ChimeKind;
  /** Phase the session moves *into*; the last index for a completion. */
  phaseIndex: number;
  title: string;
  body: string;
};

export type FocusScheduler = {
  schedule(
    transitions: PlannedTransition[],
    options?: { userInitiated?: boolean },
  ): Promise<void> | void;
  cancel(sessionId: string): Promise<void> | void;
};

export type FocusChime = (kind: ChimeKind) => Promise<void> | void;

/** Starts a repeating callback and returns its canceller. */
export type TickerFactory = (onTick: () => void, intervalMs: number) => () => void;

export type FocusPlanInput = {
  label: string;
  subject?: string | null;
  projectId?: string | null;
  /** Budget for the whole plan; cycles are derived from it when not given. */
  totalMinutes?: number;
  focusMinutes?: number;
  breakMinutes?: number;
  longBreakMinutes?: number;
  cyclesBeforeLongBreak?: number;
  cycles?: number;
};

export type FocusRuntimeDeps = {
  repository: FocusSessionsRepository;
  surface?: FocusSurface;
  scheduler?: FocusScheduler;
  chime?: FocusChime;
  ticker?: TickerFactory;
  logger?: Logger;
};

/* ------------------------------------------------------------------ pure -- */

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)));

/**
 * Turns a spoken plan ("pomodoro for two hours", "25/5 four times") into
 * phases. The plan never ends on a break: the session is over when the last
 * stretch of work is, otherwise the user sits watching a break tick down with
 * nothing left to come back to.
 */
export function buildPhases(input: FocusPlanInput): SessionPhase[] {
  const focus = clamp(input.focusMinutes ?? DEFAULT_FOCUS_MINUTES, 1, 6 * 60);
  const short = clamp(input.breakMinutes ?? DEFAULT_BREAK_MINUTES, 0, 120);
  const long = input.longBreakMinutes === undefined ? null : clamp(input.longBreakMinutes, 0, 120);
  const every = clamp(input.cyclesBeforeLongBreak ?? DEFAULT_CYCLES_BEFORE_LONG_BREAK, 1, 12);
  const cycles = resolveCycles(input, focus, short);

  const phases: SessionPhase[] = [];
  for (let cycle = 1; cycle <= cycles; cycle++) {
    phases.push({ kind: 'focus', minutes: focus });
    if (cycle === cycles) break;
    const minutes = long !== null && cycle % every === 0 ? long : short;
    if (minutes > 0) phases.push({ kind: 'break', minutes });
  }
  return phases;
}

function resolveCycles(input: FocusPlanInput, focus: number, short: number): number {
  if (input.cycles !== undefined) return clamp(input.cycles, 1, MAX_CYCLES);
  if (input.totalMinutes === undefined) return 1;
  // Fill the budget without overrunning it: a "one hour" session with 25/5 is
  // two pomodoros and change, not three that spill past the hour.
  const budget = Math.max(1, Math.round(input.totalMinutes));
  let used = 0;
  let cycles = 0;
  while (cycles < MAX_CYCLES && used + focus <= budget) {
    used += focus + short;
    cycles++;
  }
  return Math.max(1, cycles);
}

export function snapshotOf(session: FocusSession, at: number): FocusSnapshot {
  const state = computeSessionState(session, at);
  const phaseCount = parsePhases(session.phases).length;
  return {
    sessionId: session.id,
    label: session.label,
    subject: session.subject,
    status: state.status,
    phase: state.phase,
    phaseIndex: state.phaseIndex,
    phaseCount,
    phaseElapsedMs: state.phaseElapsedMs,
    phaseRemainingMs: state.phaseRemainingMs,
    totalRemainingMs: state.totalRemainingMs,
    phaseEndsAt:
      state.status === 'running' && !state.isComplete ? at + state.phaseRemainingMs : null,
    isComplete: state.isComplete,
    clock: formatClock(state.phaseRemainingMs),
    at,
  };
}

/**
 * Every remaining boundary of a running session as absolute instants.
 *
 * These are handed to the notification scheduler so the phase change still
 * announces itself with the app backgrounded or killed — the OS holds the
 * alarm, we only hold the plan. A paused session has no future boundaries.
 */
export function plannedTransitions(session: FocusSession, at: number): PlannedTransition[] {
  if (session.status !== 'running') return [];
  const state = computeSessionState(session, at);
  if (state.isComplete) return [];

  const phases = parsePhases(session.phases);
  const transitions: PlannedTransition[] = [];
  let boundary = at + state.phaseRemainingMs;

  for (let index = state.phaseIndex + 1; index < phases.length; index++) {
    const phase = phases[index]!;
    transitions.push(describeTransition(session, index, phase, boundary));
    if (transitions.length >= MAX_SCHEDULED_TRANSITIONS) return transitions;
    boundary += durationOf(phase);
  }
  transitions.push(describeTransition(session, phases.length - 1, null, boundary));
  return transitions;
}

function describeTransition(
  session: FocusSession,
  phaseIndex: number,
  phase: SessionPhase | null,
  at: number,
): PlannedTransition {
  if (!phase) {
    return {
      sessionId: session.id,
      at,
      kind: 'complete',
      phaseIndex,
      title: 'Session finished',
      body: `${session.label} is done.`,
    };
  }
  const minutes = Math.round(phase.minutes);
  return {
    sessionId: session.id,
    at,
    kind: phase.kind,
    phaseIndex,
    title: phase.kind === 'break' ? 'Break time' : 'Back to it',
    body:
      phase.kind === 'break'
        ? `${session.label} — ${minutes} minute break.`
        : `${session.label} — ${minutes} minutes of focus.`,
  };
}

/* --------------------------------------------------------------- runtime -- */

export type FocusRuntime = {
  /** Creates the session from a plan and drives it. */
  startPlan(input: FocusPlanInput): Promise<Result<FocusSnapshot>>;
  start(sessionId: string): Promise<Result<FocusSnapshot>>;
  pause(): Promise<Result<FocusSnapshot>>;
  resume(): Promise<Result<FocusSnapshot>>;
  skipPhase(): Promise<Result<FocusSnapshot>>;
  stop(): Promise<Result<FocusSnapshot | null>>;
  /** Picks up whatever the last run left behind; safe to call on every launch. */
  rehydrate(): Promise<FocusSnapshot | null>;
  /** One reconciliation pass. The ticker calls this; tests drive it directly. */
  tick(): Promise<void>;
  setForeground(active: boolean): void;
  subscribe(listener: (snapshot: FocusSnapshot | null) => void): () => void;
  getSnapshot(): FocusSnapshot | null;
  dispose(): void;
};

const noopSurface: FocusSurface = { start: () => {}, update: () => {}, end: () => {} };
const noopScheduler: FocusScheduler = { schedule: () => {}, cancel: () => {} };

const defaultTicker: TickerFactory = (onTick, intervalMs) => {
  const handle = setInterval(onTick, intervalMs);
  return () => clearInterval(handle);
};

export function createFocusRuntime(deps: FocusRuntimeDeps): FocusRuntime {
  const repository = deps.repository;
  const log = deps.logger ?? silentLogger;
  const surface = deps.surface ?? noopSurface;
  const scheduler = deps.scheduler ?? noopScheduler;
  const chime = deps.chime ?? createToneChime();
  const makeTicker = deps.ticker ?? defaultTicker;

  const listeners = new Set<(snapshot: FocusSnapshot | null) => void>();
  /** The live row. Null means nothing is being driven right now. */
  let current: FocusSession | null = null;
  let snapshot: FocusSnapshot | null = null;
  let attached = false;
  let foreground = true;
  let stopTicker: (() => void) | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  /**
   * Every public entry point runs through here. Two overlapping calls would
   * otherwise both read the row, both advance it and double-count a phase.
   */
  function serial<T>(job: () => Promise<T>): Promise<T> {
    const next = queue.then(job);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function safely(what: string, run: () => Promise<void> | void): Promise<void> {
    try {
      await run();
    } catch (error) {
      // A platform surface that fails is a cosmetic problem; the timer is not.
      log.warn(`${what} failed`, toAppError(error).message);
    }
  }

  function emit(): void {
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        log.warn('a focus subscriber threw', error);
      }
    }
  }

  function startTicking(): void {
    if (stopTicker || !foreground) return;
    stopTicker = makeTicker(() => {
      void tick();
    }, TICK_MS);
  }

  function stopTicking(): void {
    stopTicker?.();
    stopTicker = null;
  }

  async function attach(): Promise<void> {
    const shown = snapshot;
    if (!shown) return;
    if (attached) {
      await safely('surface update', () => surface.update(shown));
      return;
    }
    attached = true;
    await safely('surface start', () => surface.start(shown));
  }

  /** Lets go of the session without judging it: no row is written here. */
  async function detach(): Promise<void> {
    stopTicking();
    const previous = current;
    current = null;
    if (previous) await safely('transition cancel', () => scheduler.cancel(previous.id));
    if (attached) {
      attached = false;
      await safely('surface end', () => surface.end(snapshot));
    }
  }

  /**
   * Pushes the in-memory row out to the snapshot, the surface and the alarms.
   *
   * `userInitiated` travels down to the notification scheduler: only a session
   * the person just started may raise the permission dialog.
   */
  async function sync(at: number, options: { userInitiated?: boolean } = {}): Promise<void> {
    const row = current;
    if (!row) {
      emit();
      return;
    }
    snapshot = snapshotOf(row, at);
    if (row.status === 'completed' || row.status === 'cancelled') {
      await detach();
      emit();
      return;
    }
    await safely('transition cancel', () => scheduler.cancel(row.id));
    await safely('transition schedule', () =>
      scheduler.schedule(plannedTransitions(row, at), { userInitiated: options.userInitiated }),
    );
    await attach();
    if (row.status === 'running') startTicking();
    else stopTicking();
    emit();
  }

  /**
   * Rolls the row forward to wherever the wall clock says the session is, then
   * republishes. Boundaries are persisted at the instant they *happened*, never
   * at the instant we noticed, so a tick that arrives late (or three hours
   * late) does not push the rest of the plan back with it.
   */
  async function reconcile(options: { announce?: boolean } = {}): Promise<void> {
    let row = current;
    if (!row) return;
    const at = now();
    let transition: ChimeKind | null = null;
    let boundaryAt = 0;

    if (row.status === 'running') {
      const phases = parsePhases(row.phases);
      for (;;) {
        const state = computeSessionState(row, at);
        if (!state.isComplete && state.phaseIndex === row.phaseIndex) break;
        const boundary =
          row.phaseStartedAt + row.accumulatedPauseMs + durationOf(phases[row.phaseIndex]!);
        const advanced = await repository.advancePhase(row.id, boundary);
        if (!advanced.ok) {
          log.warn('could not advance the phase', advanced.error.message);
          break;
        }
        row = advanced.value;
        boundaryAt = boundary;
        transition = row.status === 'running' ? phases[row.phaseIndex]!.kind : 'complete';
        if (row.status !== 'running') break;
      }
      current = row;
    }

    if (transition) {
      if (options.announce !== false && at - boundaryAt <= STALE_TRANSITION_MS) {
        const kind = transition;
        await safely('chime', () => chime(kind));
      }
      await sync(at);
      return;
    }

    const refreshed = snapshotOf(row, at);
    snapshot = refreshed;
    if (attached) await safely('surface update', () => surface.update(refreshed));
    emit();
  }

  async function begin(
    row: FocusSession,
    options: { userInitiated?: boolean } = {},
  ): Promise<Result<FocusSnapshot>> {
    current = row;
    snapshot = snapshotOf(row, now());
    // A row picked up from storage may already have run past several phases.
    await reconcile({ announce: false });
    if (current) await sync(now(), options);
    return snapshot ? ok(snapshot) : fail('unknown', 'Could not start that session.');
  }

  /**
   * The ticker fires this every second and nobody awaits it, so it has to
   * absorb its own failures: a closed database or an unreadable plan would
   * otherwise raise an unhandled rejection once a second, forever.
   */
  async function tick(): Promise<void> {
    try {
      await serial(() => reconcile());
    } catch (error) {
      log.warn('a reconciliation pass failed', toAppError(error).message);
    }
  }

  /**
   * Rolls the held row forward before a control mutates it.
   *
   * The row is only as fresh as the last tick, and the ticker is off while the
   * app is in the background — which is exactly where the notification action
   * buttons are pressed. Without this, Skip advances from the phase we last
   * looked at rather than the one the wall clock is in, and Pause can freeze a
   * plan that has already run out into a session that never completes.
   */
  async function catchUp(): Promise<void> {
    if (!current) return;
    await reconcile({ announce: false });
  }

  return {
    async startPlan(input: FocusPlanInput): Promise<Result<FocusSnapshot>> {
      return serial(async () => {
        let created: FocusSession;
        try {
          created = await repository.create({
            label: input.label,
            subject: input.subject ?? null,
            projectId: input.projectId ?? null,
            phases: buildPhases(input),
          });
        } catch (error) {
          // The repository throws for an unusable plan; the caller gets to
          // decide what to say about it rather than being handed an exception.
          return err(toAppError(error, 'Could not start that session.'));
        }
        await replaceCurrent(created.id);
        return begin(created, { userInitiated: true });
      });
    },

    async start(sessionId: string): Promise<Result<FocusSnapshot>> {
      return serial(async () => {
        if (current?.id === sessionId) {
          // Already driving it: re-sync rather than start a second timer.
          await reconcile({ announce: false });
          return snapshot ? ok(snapshot) : fail('not_found', 'That session is no longer there.');
        }
        const row = await repository.getById(sessionId);
        if (!row) return fail('not_found', 'That session is no longer there.');
        if (row.status === 'completed' || row.status === 'cancelled') {
          return fail('invalid_input', 'That session has already finished.');
        }
        await replaceCurrent(sessionId);
        return begin(row, { userInitiated: true });
      });
    },

    async pause(): Promise<Result<FocusSnapshot>> {
      return serial(async () => {
        await catchUp();
        if (!current) return fail('not_found', 'Nothing is running.');
        const at = now();
        const paused = await repository.pause(current.id, at);
        if (!paused.ok) return paused;
        current = paused.value;
        await sync(at);
        return snapshot ? ok(snapshot) : fail('unknown', 'Could not pause that session.');
      });
    },

    async resume(): Promise<Result<FocusSnapshot>> {
      return serial(async () => {
        if (!current) return fail('not_found', 'Nothing is paused.');
        const at = now();
        const resumed = await repository.resume(current.id, at);
        if (!resumed.ok) return resumed;
        current = resumed.value;
        await sync(at);
        return snapshot ? ok(snapshot) : fail('unknown', 'Could not resume that session.');
      });
    },

    async skipPhase(): Promise<Result<FocusSnapshot>> {
      return serial(async () => {
        await catchUp();
        if (!current) return fail('not_found', 'Nothing is running.');
        const at = now();
        const advanced = await repository.advancePhase(current.id, at);
        if (!advanced.ok) return advanced;
        current = advanced.value;
        // No chime: the person who pressed Skip already knows the phase changed.
        await sync(at);
        return snapshot ? ok(snapshot) : fail('unknown', 'Could not skip that phase.');
      });
    },

    async stop(): Promise<Result<FocusSnapshot | null>> {
      return serial(async () => {
        // A plan that ran out while the app was away finished; it was not
        // abandoned, and the history should not say it was.
        await catchUp();
        const session = current;
        if (!session) {
          snapshot = null;
          emit();
          return ok(null);
        }
        const cancelled = await repository.cancel(session.id, now());
        if (!cancelled.ok) {
          await detach();
          return cancelled;
        }
        current = cancelled.value;
        await sync(now());
        return ok(snapshot);
      });
    },

    async rehydrate(): Promise<FocusSnapshot | null> {
      return serial(async () => {
        const wasAttached = attached;
        const row = await repository.getActive();
        if (!row) {
          await detach();
          snapshot = null;
          emit();
        } else {
          if (current?.id !== row.id) await detach();
          await begin(row);
        }
        // Nothing left to drive, and nothing of ours on screen to have ended:
        // the Live Activity or ongoing notification the killed process left
        // behind is still up, and this is the only place that can clear it.
        if (!current && !wasAttached) await safely('surface end', () => surface.end(snapshot));
        return snapshot;
      });
    },

    tick,

    setForeground(active: boolean): void {
      if (foreground === active) return;
      foreground = active;
      if (!active) {
        stopTicking();
        return;
      }
      // Catch up on everything that happened while we were away before the
      // per-second ticker takes over.
      void tick().then(() => {
        if (current?.status === 'running') startTicking();
      });
    },

    subscribe(listener): () => void {
      listeners.add(listener);
      try {
        // Hand over the current value immediately so a screen paints without
        // waiting a second for the next tick.
        listener(snapshot);
      } catch (error) {
        log.warn('a focus subscriber threw', error);
      }
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot(): FocusSnapshot | null {
      return snapshot;
    },

    dispose(): void {
      stopTicking();
      listeners.clear();
    },
  };

  /**
   * Only one session may be live: two running rows would both roll forward and
   * both claim their focus minutes, so the one being displaced is cancelled.
   */
  async function replaceCurrent(nextId: string): Promise<void> {
    const previous = current;
    if (!previous || previous.id === nextId) return;
    await repository.cancel(previous.id, now());
    await detach();
  }
}

/* ----------------------------------------------------------------- chime -- */

const TONE_MS = 320;
const TONE_HZ: Record<ChimeKind, number> = { focus: 880, break: 587, complete: 1046 };

type AudioPlayerLike = { volume: number; play(): void; remove(): void };
type AudioApi = { createAudioPlayer(source: { uri: string }): AudioPlayerLike };
type FileLike = {
  uri: string;
  exists: boolean;
  create(options?: { overwrite?: boolean }): void;
  write(contents: Uint8Array): void;
};
type FileSystemApi = {
  File: new (...parts: unknown[]) => FileLike;
  Paths: { cache: unknown };
};
type HapticsApi = {
  notificationAsync(type: unknown): Promise<void>;
  NotificationFeedbackType: { Success: unknown };
};

/**
 * Requires are lazy and literal: lazy so this module still loads under plain
 * Node (the tests never let a chime run), literal so Metro can resolve them.
 */
function loadModule<T>(load: () => T): T | null {
  try {
    return load();
  } catch {
    return null;
  }
}

/**
 * A short generated tone per phase kind. The waveform is synthesised and cached
 * in the cache directory rather than shipped as three audio assets — it is less
 * to carry, and the pitch can follow the phase.
 *
 * Audio is the nicety, not the timer: any failure drops through to a haptic
 * buzz, and a failure there is swallowed too.
 */
export function createToneChime(logger: Logger = silentLogger): FocusChime {
  const log = logger;
  const files = new Map<ChimeKind, string>();
  let audio: AudioApi | null | undefined;
  let files$: FileSystemApi | null | undefined;
  let haptics: HapticsApi | null | undefined;

  return async (kind: ChimeKind): Promise<void> => {
    try {
      if (audio === undefined) {
        audio = loadModule<AudioApi>(() => require('expo-audio') as AudioApi);
      }
      if (files$ === undefined) {
        files$ = loadModule<FileSystemApi>(() => require('expo-file-system') as FileSystemApi);
      }
      if (!audio || !files$) throw new Error('audio is unavailable on this platform');

      let uri = files.get(kind);
      if (!uri) {
        uri = writeTone(files$, kind);
        files.set(kind, uri);
      }
      const player = audio.createAudioPlayer({ uri });
      player.volume = 0.7;
      player.play();
      // The player owns a native object; let it go once the tone has finished.
      setTimeout(() => {
        try {
          player.remove();
        } catch {
          /* already gone */
        }
      }, TONE_MS + 500);
    } catch (error) {
      log.warn('could not play the chime; buzzing instead', toAppError(error).message);
      try {
        if (haptics === undefined) {
          haptics = loadModule<HapticsApi>(() => require('expo-haptics') as HapticsApi);
        }
        await haptics?.notificationAsync(haptics.NotificationFeedbackType.Success);
      } catch {
        /* a missing buzz is not worth a second complaint */
      }
    }
  };
}

function writeTone(fs: FileSystemApi, kind: ChimeKind): string {
  const file = new fs.File(fs.Paths.cache, `ridik-chime-${kind}.wav`);
  if (!file.exists) {
    file.create({ overwrite: true });
    file.write(toneWav(TONE_HZ[kind], TONE_MS));
  }
  return file.uri;
}

/** 16-bit mono PCM in a WAV container. */
export function toneWav(frequency: number, durationMs: number, sampleRate = 22_050): Uint8Array {
  const samples = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);

  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples * 2, true);

  for (let i = 0; i < samples; i++) {
    // Raised-cosine envelope: a bare sine starts and ends on a click.
    const envelope = samples === 1 ? 1 : 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (samples - 1));
    const value = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * envelope * 0.8;
    view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, value)) * 0x7fff), true);
  }
  return bytes;
}
