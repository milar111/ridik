/**
 * `expo-modules-core` under plain Node.
 *
 * Two reasons the real one cannot be loaded by the `logic` project: it ships
 * untransformed ESM (so it is a bare parse error, naming a file nothing in
 * this repo imports directly), and its whole job is to reach a native runtime
 * that does not exist here.
 *
 * The stub reports **absence**, which is not a convenience — it is the same
 * answer a real device gives when the module was not compiled into the build,
 * and every caller in `src/` is written for exactly that case:
 * `src/voice/apple.ts` falls through to the platform recogniser,
 * `src/services/widgets/publish.ts` publishes into a void and
 * `src/services/focus/liveActivity.ts` degrades to a notification. A suite
 * that wants the native side *present* supplies its own `jest.mock` with a
 * double — see `src/voice/__tests__/apple-session.test.ts`.
 */
export function requireOptionalNativeModule<T>(_name: string): T | null {
  return null;
}

/**
 * The non-optional form, which is a programming error to reach here: a caller
 * using it has declared the native side mandatory, and under Node it is not
 * there. Throwing names the module rather than failing as a missing property
 * three frames later.
 */
export function requireNativeModule<T>(name: string): T {
  throw new Error(`requireNativeModule('${name}') has no native module under Node`);
}
