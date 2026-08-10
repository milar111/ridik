/**
 * Explicit success/failure values.
 *
 * Voice actions run in batches: one bad action inside an utterance must not
 * abort the rest, and the user has to be told *which* part failed. Exceptions
 * make that awkward, so anything the user can trigger returns a Result.
 */
export type Ok<T> = { ok: true; value: T };
export type Err<E = AppError> = { ok: false; error: E };
export type Result<T, E = AppError> = Ok<T> | Err<E>;

export type AppErrorCode =
  | 'not_found'
  | 'ambiguous'
  | 'invalid_input'
  | 'conflict'
  | 'permission_denied'
  | 'offline'
  | 'rate_limited'
  | 'upstream'
  | 'unsupported'
  | 'cycle'
  | 'unknown';

export class AppError extends Error {
  readonly code: AppErrorCode;
  /** Short sentence safe to speak or show to the user. */
  readonly userMessage: string;
  readonly details?: unknown;
  readonly retryable: boolean;

  constructor(
    code: AppErrorCode,
    userMessage: string,
    options: { cause?: unknown; details?: unknown; retryable?: boolean } = {},
  ) {
    super(`${code}: ${userMessage}`);
    this.name = 'AppError';
    this.code = code;
    this.userMessage = userMessage;
    this.details = options.details;
    this.retryable = options.retryable ?? (code === 'offline' || code === 'rate_limited');
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E = AppError>(error: E): Err<E> => ({ ok: false, error });

export function fail(
  code: AppErrorCode,
  userMessage: string,
  options?: { cause?: unknown; details?: unknown; retryable?: boolean },
): Err<AppError> {
  return err(new AppError(code, userMessage, options));
}

export function toAppError(error: unknown, fallback = 'Something went wrong.'): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    return new AppError('unknown', error.message || fallback, { cause: error });
  }
  return new AppError('unknown', fallback, { cause: error });
}

/** Runs `fn`, converting a thrown error into an `Err`. */
export async function attempt<T>(fn: () => Promise<T> | T): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (error) {
    return err(toAppError(error));
  }
}

export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw result.error;
}
