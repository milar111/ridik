/**
 * Turning a rejected mutation into a sentence the product is allowed to say.
 *
 * The repositories reject with an `AppError` carrying a `userMessage` written
 * for the user. `instanceof` is avoided deliberately — the repositories make the
 * same call for SQLite's driver errors: under Jest the class can arrive from
 * another realm and the check silently starts lying.
 */
export function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'userMessage' in error) {
    const message = (error as { userMessage: unknown }).userMessage;
    if (typeof message === 'string' && message.trim().length > 0) return message;
  }
  return fallback;
}
