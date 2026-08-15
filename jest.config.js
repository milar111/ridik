/**
 * Two test projects:
 *  - `logic` runs in plain Node so repositories, migrations and the LLM engine
 *    can be exercised against a *real* SQLite database (node:sqlite).
 *  - `ui`    runs under jest-expo for React component smoke tests.
 */
const transform = {
  '^.+\\.[jt]sx?$': ['babel-jest', { configFile: require.resolve('./babel.config.js') }],
};

module.exports = {
  projects: [
    {
      // Not a test suite: `npm run seed` runs these through the same babel/alias
      // setup as the tests so a dev script can use the real repositories.
      displayName: 'scripts',
      testEnvironment: 'node',
      rootDir: __dirname,
      testMatch: ['<rootDir>/scripts/**/*.script.ts'],
      transform,
      moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
    },
    {
      displayName: 'logic',
      testEnvironment: 'node',
      rootDir: __dirname,
      testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts'],
      transform,
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
      },
      setupFilesAfterEnv: ['<rootDir>/jest/setup-logic.ts'],
      clearMocks: true,
    },
    {
      displayName: 'ui',
      preset: 'jest-expo',
      rootDir: __dirname,
      testMatch: ['<rootDir>/src/**/__tests__/**/*.test.tsx', '<rootDir>/app/**/*.test.tsx'],
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        // Reanimated 4 boots its worklets runtime on import and has no native
        // side here. Every suite used to carry its own partial mock, so a
        // shared component could not reach for a new hook without breaking
        // suites unrelated to it — see the file for the rest.
        '^react-native-reanimated$': '<rootDir>/jest/reanimated-mock.ts',
      },
      setupFiles: ['<rootDir>/jest/setup-ui.ts'],
      setupFilesAfterEnv: ['<rootDir>/jest/setup-ui-after.ts'],
      transformIgnorePatterns: [
        // `standard-navigation` is an expo-router dependency that ships
        // untransformed ESM. Any component importing expo-router — `Screen`
        // does, for its back button — drags it into every suite that renders a
        // screen, and without it here the failure is a bare parse error that
        // names a file nothing in this repo imports directly.
        'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|standard-navigation|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|drizzle-orm)',
      ],
      clearMocks: true,
    },
  ],
};
