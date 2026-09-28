const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// `@/*` -> `src/*` (declared in tsconfig.json) must resolve for the bundler too.
config.resolver.unstable_enablePackageExports = true;

/*
 * Node's `buffer`, for one dependency of one engine.
 *
 * `whisper.rn` depends on `safe-buffer`, which `require`s Node's built-in
 * `buffer` — a module React Native does not have. Without this the *import*
 * fails, so offline transcription reports itself unavailable and the
 * recogniser keeps answering: the right degradation, and completely silent
 * unless you go looking. It cost a device probe to find, because nothing about
 * "Offline transcription is not available" points at a missing polyfill.
 *
 * Scoped to the one name on purpose. A blanket set of Node shims invites code
 * that assumes a Node runtime it does not have.
 */
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  buffer: require.resolve('buffer/'),
};

module.exports = config;
