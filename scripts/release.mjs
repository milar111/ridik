#!/usr/bin/env node
/**
 * `npm run release <command>` — the shippable artefacts, and an honest account
 * of what is missing before they can ship.
 *
 * There are two very different things called "building the app". A *debug*
 * build loads JavaScript from Metro and is what the simulator instructions in
 * AGENTS.md produce; it cannot be uploaded anywhere. A *release* build bundles
 * the JavaScript in, minifies it, and is signed with a key a store recognises.
 * Everything here is the second kind.
 *
 * The commands are deliberately thin wrappers over Gradle and xcodebuild rather
 * than a build system of their own. What they add is the preflight: the four or
 * five things that are wrong on a fresh machine and each of which otherwise
 * fails a hundred lines into a build log.
 *
 *   npm run release doctor        what is configured, what is missing, what that blocks
 *   npm run release keystore      create the Android upload key (once, ever)
 *   npm run release android:apk   release APK — sideloading, testers, a direct download
 *   npm run release android:aab   release AAB — the only thing Play accepts
 *   npm run release ios:archive   .xcarchive — needs an Apple Developer team
 *   npm run release ios:ipa       .ipa from the archive, for App Store Connect
 *   npm run release all           doctor, then everything that is possible here
 *
 * Add `--no-prebuild` to skip regenerating the native projects, and `--verbose`
 * to see the underlying build output rather than a spinner's worth of it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CREDENTIALS = path.join(ROOT, 'credentials', 'android');
const KEYSTORE = path.join(CREDENTIALS, 'upload.keystore');
const PROPERTIES = path.join(CREDENTIALS, 'keystore.properties');
const DIST = path.join(ROOT, 'dist');

/** JDK 25 fails `configureCMakeDebug`; see AGENTS.md → Environment gotchas. */
const JDK = path.join(os.homedir(), '.jdks', 'temurin-21', 'Contents', 'Home');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const command = argv.find((a) => !a.startsWith('--'));
const verbose = flags.has('--verbose');

// ------------------------------------------------------------------ plumbing

const paint = (code, text) => (process.stdout.isTTY ? `[${code}m${text}[0m` : text);
const bold = (t) => paint('1', t);
const dim = (t) => paint('2', t);
const red = (t) => paint('31', t);
const green = (t) => paint('32', t);
const amber = (t) => paint('33', t);

function heading(text) {
  console.log(`\n${bold(text)}`);
}

function die(message, hint) {
  console.error(`\n${red('✗')} ${message}`);
  if (hint) console.error(`  ${dim(hint)}`);
  process.exit(1);
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd ?? ROOT,
    stdio: verbose ? 'inherit' : ['inherit', 'pipe', 'pipe'],
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    if (!verbose) {
      // The last of a Gradle or xcodebuild log is where the actual error is;
      // the first ten thousand lines are dependency resolution.
      const tail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd().split('\n').slice(-30);
      console.error(`\n${dim(tail.join('\n'))}`);
    }
    die(`${file} ${args.slice(0, 2).join(' ')} failed.`, verbose ? undefined : 'Re-run with --verbose for the whole log.');
  }
  return result.stdout ?? '';
}

/** Present and runnable, or null. Never throws — every caller wants the report. */
function tool(file, args = ['--version']) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function appConfig() {
  const json = execFileSync('npx', ['expo', 'config', '--json', '--type', 'public'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(json).expo ?? JSON.parse(json);
}

function ensureDist() {
  fs.mkdirSync(DIST, { recursive: true });
}

function copyOut(from, name) {
  ensureDist();
  const to = path.join(DIST, name);
  fs.copyFileSync(from, to);
  const mb = (fs.statSync(to).size / 1_000_000).toFixed(1);
  console.log(`${green('✓')} ${path.relative(ROOT, to)} ${dim(`(${mb} MB)`)}`);
  return to;
}

function javaHome() {
  if (fs.existsSync(JDK)) return JDK;
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  return null;
}

function androidHome() {
  if (process.env.ANDROID_HOME) return process.env.ANDROID_HOME;
  const guess = path.join(os.homedir(), 'Library', 'Android', 'sdk');
  return fs.existsSync(guess) ? guess : null;
}

function prebuild(platform) {
  if (flags.has('--no-prebuild')) return;
  console.log(dim(`  regenerating ${platform}/ …`));
  run('npx', ['expo', 'prebuild', '--platform', platform]);
}

// -------------------------------------------------------------------- doctor

function doctor() {
  const config = appConfig();
  const rows = [];
  // Printed as it is added, not collected and dumped: a check belongs under the
  // heading it was run for, and the first version of this printed every row
  // after both headings, which read as if iOS needed a JDK.
  const add = (ok, label, detail) => {
    rows.push({ ok, label, detail });
    console.log(`  ${ok ? green('✓') : amber('!')} ${label.padEnd(18)} ${dim(detail)}`);
  };

  heading('The app');
  console.log(`  ${config.name} ${config.version}`);
  console.log(`  ${dim(`iOS ${config.ios?.bundleIdentifier} build ${config.ios?.buildNumber}`)}`);
  console.log(`  ${dim(`Android ${config.android?.package} versionCode ${config.android?.versionCode}`)}`);

  heading('Android');
  const jdk = javaHome();
  add(
    Boolean(jdk),
    'JDK',
    jdk ? `${jdk}${jdk === JDK ? '' : ' (JDK 21 required — 25 fails configureCMakeDebug)'}` : 'not found — install Temurin 21',
  );
  const sdk = androidHome();
  add(Boolean(sdk), 'Android SDK', sdk ?? 'not found — set ANDROID_HOME');
  const hasKey = fs.existsSync(PROPERTIES) && fs.existsSync(KEYSTORE);
  add(
    hasKey,
    'Upload key',
    hasKey
      ? path.relative(ROOT, KEYSTORE)
      : 'missing — release builds will be DEBUG-SIGNED and Play will reject them. Run: npm run release keystore',
  );

  heading('iOS');
  add(Boolean(tool('xcodebuild', ['-version'])), 'Xcode', tool('xcodebuild', ['-version'])?.split('\n')[0] ?? 'not found');
  const teams = signingTeams();
  add(
    teams.length > 0,
    'Signing identity',
    teams.length > 0
      ? teams.join(', ')
      : 'no Apple Development/Distribution certificate in the keychain — ios:archive and ios:ipa cannot run. ' +
        'A simulator build still works, and EAS Build can sign remotely.',
  );

  const blocked = rows.filter((row) => !row.ok);
  heading('Verdict');
  if (blocked.length === 0) {
    console.log(`  ${green('Everything needed for a store upload is present.')}`);
  } else {
    console.log(`  ${amber(`${blocked.length} thing${blocked.length > 1 ? 's' : ''} to sort out:`)}`);
    for (const row of blocked) console.log(`    · ${row.label}: ${row.detail}`);
  }
  return blocked;
}

/** Certificates in the login keychain, which is what xcodebuild will look at. */
function signingTeams() {
  const out = tool('security', ['find-identity', '-v', '-p', 'codesigning']);
  if (!out) return [];
  return out
    .split('\n')
    .map((line) => line.match(/"(Apple (?:Development|Distribution)[^"]*)"/)?.[1])
    .filter(Boolean);
}

// ------------------------------------------------------------------ keystore

function keystore() {
  if (fs.existsSync(KEYSTORE)) {
    die(
      `${path.relative(ROOT, KEYSTORE)} already exists.`,
      'Never replace an upload key that has shipped — Play will reject an app signed with a different one. ' +
        'Delete it by hand only if nothing has been published with it.',
    );
  }
  if (!javaHome()) die('No JDK found.', 'keytool ships with the JDK; install Temurin 21.');

  fs.mkdirSync(CREDENTIALS, { recursive: true });

  // Generated rather than prompted: this runs unattended, and a password the
  // machine chose and wrote down beats one a human types twice at 2am.
  const password = [...crypto.getRandomValues(new Uint8Array(24))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const config = appConfig();
  const alias = 'upload';

  run(path.join(javaHome(), 'bin', 'keytool'), [
    '-genkeypair',
    '-v',
    '-keystore', KEYSTORE,
    '-alias', alias,
    '-keyalg', 'RSA',
    '-keysize', '2048',
    // Play requires at least 25 years; this is ~27, so it outlives the account.
    '-validity', '10000',
    '-storepass', password,
    '-keypass', password,
    '-dname', `CN=${config.name}, OU=Mobile, O=${config.name}, C=US`,
  ]);

  fs.writeFileSync(
    PROPERTIES,
    [
      '# Written by `npm run release keystore`. Gitignored, and it must stay that way:',
      '# every release is signed with this key and Play will not accept a different one.',
      '# Back it up somewhere you would still have after losing this machine.',
      `storeFile=${path.posix.join('..', 'credentials', 'android', 'upload.keystore')}`,
      `storePassword=${password}`,
      `keyAlias=${alias}`,
      `keyPassword=${password}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  fs.chmodSync(KEYSTORE, 0o600);

  console.log(`${green('✓')} ${path.relative(ROOT, KEYSTORE)}`);
  console.log(`${green('✓')} ${path.relative(ROOT, PROPERTIES)}`);
  console.log(
    `\n${bold('Back both files up now.')} Lose them and you cannot ship an update to this app —\n` +
      'Play matches every upload against the first key you used. There is a recovery process\n' +
      'and it is slow. A password manager or an encrypted archive is enough.',
  );
}

// ------------------------------------------------------------------- android

function gradle(task) {
  const jdk = javaHome();
  const sdk = androidHome();
  if (!jdk) die('No JDK found.', 'Install Temurin 21 — JDK 25 fails configureCMakeDebug.');
  if (!sdk) die('No Android SDK found.', 'Set ANDROID_HOME, e.g. ~/Library/Android/sdk');

  if (!fs.existsSync(PROPERTIES)) {
    console.log(
      `${amber('!')} No upload key — this build will be ${bold('debug-signed')} and cannot be uploaded.\n` +
        `  ${dim('Run `npm run release keystore` first if you meant to ship it.')}`,
    );
  }

  prebuild('android');
  console.log(dim(`  ./gradlew ${task} …`));
  run('./gradlew', [task], {
    cwd: path.join(ROOT, 'android'),
    // NODE_ENV is what tells Metro to bundle for production rather than warn.
    env: { JAVA_HOME: jdk, ANDROID_HOME: sdk, NODE_ENV: 'production' },
  });
}

function androidApk() {
  gradle('assembleRelease');
  const built = path.join(ROOT, 'android/app/build/outputs/apk/release/app-release.apk');
  if (!fs.existsSync(built)) die('Gradle reported success but produced no APK.', built);
  const config = appConfig();
  copyOut(built, `ridik-${config.version}-${config.android?.versionCode}.apk`);
  console.log(dim('  An APK is for sideloading and testers. Play needs the AAB.'));
}

function androidAab() {
  gradle('bundleRelease');
  const built = path.join(ROOT, 'android/app/build/outputs/bundle/release/app-release.aab');
  if (!fs.existsSync(built)) die('Gradle reported success but produced no bundle.', built);
  const config = appConfig();
  copyOut(built, `ridik-${config.version}-${config.android?.versionCode}.aab`);
  console.log(dim('  Upload this to Play Console → Production → Create new release.'));
}

// ----------------------------------------------------------------------- ios

function archivePath() {
  return path.join(DIST, 'Ridik.xcarchive');
}

function iosArchive() {
  if (!tool('xcodebuild', ['-version'])) die('Xcode is not installed.');
  if (signingTeams().length === 0) {
    die(
      'No code-signing identity in the keychain.',
      'An .xcarchive for the App Store has to be signed, and that needs an Apple Developer\n' +
        '  account: open Xcode → Settings → Accounts, sign in, then re-run. Alternatively EAS Build\n' +
        '  (`npx eas build -p ios`) signs remotely and needs nothing installed here.',
    );
  }

  prebuild('ios');
  ensureDist();
  fs.rmSync(archivePath(), { recursive: true, force: true });

  console.log(dim('  xcodebuild archive …'));
  run('xcodebuild', [
    '-workspace', path.join(ROOT, 'ios', 'Ridik.xcworkspace'),
    '-scheme', 'Ridik',
    '-configuration', 'Release',
    '-destination', 'generic/platform=iOS',
    '-archivePath', archivePath(),
    // The widget extension is a second target with its own bundle id, so its
    // profile has to be resolved too — hence -allowProvisioningUpdates rather
    // than a hand-managed profile per target.
    '-allowProvisioningUpdates',
    'archive',
  ], { env: { NODE_ENV: 'production' } });

  console.log(`${green('✓')} ${path.relative(ROOT, archivePath())}`);
}

function iosIpa() {
  if (!fs.existsSync(archivePath())) iosArchive();

  const config = appConfig();
  const options = path.join(DIST, 'ExportOptions.plist');
  fs.writeFileSync(
    options,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>destination</key>
  <string>export</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>uploadSymbols</key>
  <true/>
</dict>
</plist>
`,
  );

  console.log(dim('  xcodebuild -exportArchive …'));
  run('xcodebuild', [
    '-exportArchive',
    '-archivePath', archivePath(),
    '-exportOptionsPlist', options,
    '-exportPath', DIST,
    '-allowProvisioningUpdates',
  ]);

  const ipa = fs.readdirSync(DIST).find((name) => name.endsWith('.ipa'));
  if (!ipa) die('Export reported success but produced no .ipa.', DIST);
  const renamed = path.join(DIST, `ridik-${config.version}-${config.ios?.buildNumber}.ipa`);
  fs.renameSync(path.join(DIST, ipa), renamed);
  const mb = (fs.statSync(renamed).size / 1_000_000).toFixed(1);
  console.log(`${green('✓')} ${path.relative(ROOT, renamed)} ${dim(`(${mb} MB)`)}`);
  console.log(dim('  Upload with Transporter, or: xcrun altool --upload-app -f <ipa>'));
}

// -------------------------------------------------------------------- bump

/**
 * Advances both build numbers by one, together.
 *
 * They are two numbers for the same thing and both stores permanently refuse
 * one they have already seen, so the failure mode for forgetting is an upload
 * rejected after a twenty-minute build. Bumping them in lockstep also means
 * "build 7" means the same thing in both TestFlight and Play, which is worth
 * more than either number being dense.
 *
 * `version` is deliberately not touched: that is the number users see, and when
 * it changes is a decision, not a step in a build script.
 */
function bump() {
  const file = path.join(ROOT, 'app.config.ts');
  const before = fs.readFileSync(file, 'utf8');

  const ios = before.match(/buildNumber: '(\d+)'/);
  const android = before.match(/versionCode: (\d+)/);
  if (!ios || !android) {
    die(
      'Could not find buildNumber / versionCode in app.config.ts.',
      'They may have been renamed or made dynamic — bump them by hand and fix this.',
    );
  }

  const next = Math.max(Number(ios[1]), Number(android[1])) + 1;
  const after = before
    .replace(/buildNumber: '\d+'/, `buildNumber: '${next}'`)
    .replace(/versionCode: \d+/, `versionCode: ${next}`);
  fs.writeFileSync(file, after);

  const config = appConfig();
  console.log(`${green('✓')} build ${ios[1]}/${android[1]} → ${bold(String(next))} on both platforms`);
  console.log(dim(`  ${config.name} ${config.version} (${next})`));
}

// -------------------------------------------------------------------- all

function all() {
  const blocked = doctor();
  heading('Building what is possible');
  androidAab();
  androidApk();
  if (blocked.some((row) => row.label === 'Signing identity')) {
    console.log(`${amber('!')} Skipping iOS: no signing identity. See the verdict above.`);
    return;
  }
  iosIpa();
}

// -------------------------------------------------------------------- router

const COMMANDS = {
  doctor,
  keystore,
  bump,
  'android:apk': androidApk,
  'android:aab': androidAab,
  'ios:archive': iosArchive,
  'ios:ipa': iosIpa,
  all,
};

if (!command || !COMMANDS[command]) {
  console.log(`${bold('npm run release <command>')}\n`);
  const help = [
    ['doctor', 'what is configured, what is missing, and what that blocks'],
    ['keystore', 'create the Android upload key — once, ever'],
    ['bump', 'advance the iOS build number and Android versionCode together'],
    ['android:apk', 'release APK for sideloading and testers'],
    ['android:aab', 'release AAB — the only thing Play accepts'],
    ['ios:archive', '.xcarchive — needs an Apple Developer team'],
    ['ios:ipa', '.ipa for App Store Connect'],
    ['all', 'doctor, then everything this machine can build'],
  ];
  for (const [name, blurb] of help) console.log(`  ${name.padEnd(14)} ${dim(blurb)}`);
  console.log(`\n  ${dim('--no-prebuild   skip regenerating ios/ and android/')}`);
  console.log(`  ${dim('--verbose       show the full build log')}`);
  process.exit(command ? 1 : 0);
}

COMMANDS[command]();
