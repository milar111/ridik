process.env.TZ = process.env.TZ ?? 'Europe/Sofia';
process.env.EXPO_OS = process.env.EXPO_OS ?? 'ios';

/**
 * Gesture-handler's own jest setup.
 *
 * `GestureHandlerRootView` calls into the native module on mount, so anything
 * rendering a sheet throws `_RNGestureHandlerModule.default.install is not a
 * function` before a single assertion runs. Nothing needed it while no test
 * mounted the voice dock; the first one that did could not start.
 *
 * Loaded here rather than mocked per-suite because it is the library's own
 * supported shim, and a hand-rolled mock in one file is how the next suite to
 * render a gesture hits the same wall and writes a second one.
 */
require('react-native-gesture-handler/jestSetup');
