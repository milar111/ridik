const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// `@/*` -> `src/*` (declared in tsconfig.json) must resolve for the bundler too.
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
