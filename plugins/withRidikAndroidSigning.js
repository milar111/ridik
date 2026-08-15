/**
 * Signs release builds with your own upload key instead of the debug one.
 *
 * The Expo template ships `release { signingConfig signingConfigs.debug }` with
 * a comment telling you to fix it. Play rejects a debug-signed upload, so this
 * fixes it — but it has to be a config plugin rather than an edit, because
 * `android/` is regenerated from the template on every `prebuild --clean` and a
 * hand-edited build.gradle would silently revert to the debug key. The failure
 * would surface as a rejected upload, days later.
 *
 * ## Where the key lives
 *
 * `credentials/android/` at the repo root — deliberately *outside* `android/`,
 * which prebuild deletes. It is gitignored: a signing key in version control is
 * the one credential you cannot rotate, because every past release is signed
 * with it and Play will not accept a different one.
 *
 * `npm run release keystore` creates the key and the properties file. Without
 * them this plugin does nothing at all and release builds stay debug-signed —
 * which is correct for someone who only wants to run the app locally, and is
 * reported by `npm run release doctor` so it cannot be mistaken for shippable.
 */
const fs = require('node:fs');
const path = require('node:path');

const { withAppBuildGradle } = require('expo/config-plugins');

/** Kept in step with `scripts/release.mjs`, which writes both of these. */
const CREDENTIALS = path.join('credentials', 'android');
const PROPERTIES = 'keystore.properties';

const MARKER = '// ridik: release signing';

/**
 * Gradle reads the properties itself, at build time.
 *
 * Not baked in here: the plugin runs during `prebuild`, and inlining the
 * passwords would write them into `android/app/build.gradle`, which is
 * generated output that people paste into issues. This way the secret stays in
 * one gitignored file that the build reads and nothing else copies.
 */
function signingBlock(propertiesPath) {
  return `        ${MARKER}
        release {
            def ridikProps = new Properties()
            def ridikFile = rootProject.file('${propertiesPath}')
            if (ridikFile.exists()) {
                ridikFile.withInputStream { ridikProps.load(it) }
                storeFile rootProject.file(ridikProps['storeFile'])
                storePassword ridikProps['storePassword']
                keyAlias ridikProps['keyAlias']
                keyPassword ridikProps['keyPassword']
            }
        }
`;
}

module.exports = function withRidikAndroidSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('withRidikAndroidSigning: expected a Groovy build.gradle.');
    }

    let contents = cfg.modResults.contents;
    if (contents.includes(MARKER)) return cfg;

    // `android/` sits one level under the project root, so Gradle's
    // `rootProject` is `android/` and the credentials are its sibling's child.
    const propertiesPath = path.posix.join('..', CREDENTIALS, PROPERTIES);

    contents = contents.replace(
      /(\n\s*signingConfigs \{\n)/,
      `$1${signingBlock(propertiesPath)}`
    );

    /*
     * Chosen at build time rather than here, so one generated project builds
     * both ways: with the key present you get an uploadable artefact, without
     * it you get a debug-signed one that still installs on a device. Failing
     * the build instead would make `assembleRelease` impossible for anyone who
     * just wants to check that minification did not break the app.
     */
    contents = contents.replace(
      /(\n\s*release \{\n\s*\/\/ Caution![^\n]*\n\s*\/\/ see[^\n]*\n)(\s*)signingConfig signingConfigs\.debug/,
      `$1$2signingConfig rootProject.file('${propertiesPath}').exists()\n$2        ? signingConfigs.release\n$2        : signingConfigs.debug`
    );

    if (!contents.includes(MARKER) || contents.includes('signingConfig signingConfigs.debug\n            def enableShrinkResources')) {
      throw new Error(
        'withRidikAndroidSigning: the template\'s signing block has changed shape — ' +
          'this plugin patched nothing. Check android/app/build.gradle against the regexes here.'
      );
    }

    cfg.modResults.contents = contents;
    return cfg;
  });
};

module.exports.CREDENTIALS = CREDENTIALS;
module.exports.PROPERTIES = PROPERTIES;

/** Used by the CLI so both sides agree on where the file is. */
module.exports.propertiesFile = (projectRoot) =>
  path.join(projectRoot, CREDENTIALS, PROPERTIES);

/** Exported for the same reason. */
module.exports.exists = (projectRoot) => fs.existsSync(module.exports.propertiesFile(projectRoot));
