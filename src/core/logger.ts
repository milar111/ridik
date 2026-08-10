/**
 * Tiny ring-buffer logger. Keeps the last N entries in memory so the Settings
 * screen can show a diagnostics log on a device with no debugger attached.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogEntry = {
  /**
   * Monotonic, unique for the life of the process. `at` is not: several entries
   * land in the same millisecond, and a list keyed on position remounts every
   * row each time the ring buffer shifts.
   */
  seq: number;
  at: number;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
};

const MAX_ENTRIES = 300;
const buffer: LogEntry[] = [];
let sequence = 0;
const listeners = new Set<(entry: LogEntry) => void>();

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

declare const __DEV__: boolean | undefined;

// `__DEV__` only exists inside the React Native bundle; this module also runs
// under plain Node in the test suite and in dev scripts.
const isDev =
  typeof __DEV__ !== 'undefined' ? Boolean(__DEV__) : process.env.NODE_ENV !== 'production';

let minLevel: LogLevel = isDev ? 'debug' : 'info';

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

/**
 * Listeners are notified on a later tick, never inline.
 *
 * The diagnostics view subscribes to this, so a synchronous fan-out means any
 * `log.warn()` reached during a render calls setState on a component that is
 * still mounting — React's "side-effect in your render function" warning, and
 * in the worst case a re-entrant render. Deferring costs nothing: nobody needs
 * a log line delivered within the same tick it was written.
 */
const pending: LogEntry[] = [];
let flushScheduled = false;

function flush(): void {
  flushScheduled = false;
  const batch = pending.splice(0, pending.length);
  for (const entry of batch) {
    listeners.forEach((listener) => {
      try {
        listener(entry);
      } catch {
        // A broken subscriber must not take down whatever was being logged.
      }
    });
  }
}

function write(level: LogLevel, scope: string, message: string, data?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const entry: LogEntry = { seq: ++sequence, at: Date.now(), level, scope, message, data };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();

  if (listeners.size > 0) {
    pending.push(entry);
    if (!flushScheduled) {
      flushScheduled = true;
      setTimeout(flush, 0);
    }
  }

  const prefix = `[${scope}]`;
  if (level === 'error') console.error(prefix, message, data ?? '');
  else if (level === 'warn') console.warn(prefix, message, data ?? '');
  else console.log(prefix, message, data ?? '');
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, data?: unknown) => write('debug', scope, message, data),
    info: (message: string, data?: unknown) => write('info', scope, message, data),
    warn: (message: string, data?: unknown) => write('warn', scope, message, data),
    error: (message: string, data?: unknown) => write('error', scope, message, data),
  };
}

export type Logger = ReturnType<typeof createLogger>;

export function getLogEntries(): readonly LogEntry[] {
  return buffer;
}

export function clearLogEntries(): void {
  buffer.length = 0;
}

export function subscribeToLogs(listener: (entry: LogEntry) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
