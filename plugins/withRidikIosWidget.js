/**
 * The WidgetKit extension, as a second Xcode target.
 *
 * `expo prebuild` generates exactly one application target, and a home-screen
 * widget is a separate binary with its own bundle id, its own Info.plist and
 * its own entitlements. Nothing in the managed workflow puts one there, so this
 * plugin does: it copies `targets/RidikWidget/*.swift` into the generated
 * project, writes the two plists, and edits `project.pbxproj` to add the target,
 * embed the built `.appex` in the app and make the app depend on it.
 *
 * ## Why this and not `expo-widgets` or `@bacons/apple-targets`
 *
 * SDK 57 does ship a first-party `expo-widgets`, but it is a different product:
 * you write the face as a React component against `@expo/ui/swift-ui` and it
 * owns the data path from JS. It cannot express a `TimelineProvider` that
 * decodes a payload out of an App Group, which is precisely the shape this app
 * already has — `src/services/widgets/publish.ts` has been feeding
 * `RidikWidgets.setSnapshot` on every write since before the widget existed.
 * It is also still alpha, and per its own release notes cannot yet set a
 * refresh policy or draw an image.
 *
 * `@bacons/apple-targets` is the usual answer and would work. It was not taken
 * because it wants a dependency (and, transitively, an `@expo/prebuild-config`
 * from SDK 55 alongside this project's 57) to add one target with no pods, no
 * asset catalog and no intent recycling. The whole mechanism it would provide
 * is the ~150 lines below, in the repo, where a build failure is readable.
 *
 * ## The App Group
 *
 * One string, written into four places from here: the app's entitlements, the
 * app's Info.plist, the extension's entitlements and the extension's
 * Info.plist. Both Swift sides read it from their own Info.plist rather than
 * hard-coding it, because a group identifier that differs between the app and
 * the extension does not fail loudly — each process quietly gets its own empty
 * container and the widget renders as though the app had never been opened.
 */
const fs = require('fs');
const path = require('path');

const {
  IOSConfig,
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
} = require('expo/config-plugins');

/** The Xcode target, the folder under `targets/`, and the group in the project. */
const TARGET_NAME = 'RidikWidget';
const APP_GROUP_INFO_PLIST_KEY = 'RidikAppGroup';
const APP_GROUPS_ENTITLEMENT = 'com.apple.security.application-groups';

/** The extension links nothing but system frameworks, so it needs no pods. */
const FALLBACK_DEPLOYMENT_TARGET = '16.4';

function resolveOptions(config, options) {
  const bundleIdentifier = config.ios && config.ios.bundleIdentifier;
  if (!bundleIdentifier) {
    throw new Error('withRidikIosWidget: ios.bundleIdentifier must be set before this plugin runs.');
  }
  return {
    appGroup: options.appGroup || `group.${bundleIdentifier}`,
    targetBundleIdentifier: options.bundleIdentifier || `${bundleIdentifier}.widget`,
  };
}

// ---------------------------------------------------------------- the app side

function withAppGroupOnApp(config, { appGroup }) {
  config = withEntitlementsPlist(config, (cfg) => {
    const current = cfg.modResults[APP_GROUPS_ENTITLEMENT];
    const groups = Array.isArray(current) ? current.slice() : [];
    if (!groups.includes(appGroup)) groups.push(appGroup);
    cfg.modResults[APP_GROUPS_ENTITLEMENT] = groups;
    return cfg;
  });

  return withInfoPlist(config, (cfg) => {
    cfg.modResults[APP_GROUP_INFO_PLIST_KEY] = appGroup;
    return cfg;
  });
}

// ------------------------------------------------------------- generated files

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (character) => {
    switch (character) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case "'":
        return '&apos;';
      default:
        return '&quot;';
    }
  });
}

function plist(body) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    body,
    '</plist>',
    '',
  ].join('\n');
}

/**
 * The extension's Info.plist.
 *
 * `NSExtensionPointIdentifier` alone is what makes this a widget: a SwiftUI
 * `WidgetBundle` is its own entry point, so there is deliberately no
 * `NSExtensionPrincipalClass` — adding one stops WidgetKit loading the bundle.
 * The two version keys have to agree with the app's or the App Store rejects
 * the upload, which is why they are read from the same Expo config the app's
 * plist is generated from.
 */
function widgetInfoPlist({ displayName, shortVersion, buildNumber, appGroup }) {
  return plist(
    [
      '<dict>',
      '\t<key>CFBundleDevelopmentRegion</key>',
      '\t<string>$(DEVELOPMENT_LANGUAGE)</string>',
      '\t<key>CFBundleDisplayName</key>',
      `\t<string>${escapeXml(displayName)}</string>`,
      '\t<key>CFBundleExecutable</key>',
      '\t<string>$(EXECUTABLE_NAME)</string>',
      '\t<key>CFBundleIdentifier</key>',
      '\t<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>',
      '\t<key>CFBundleInfoDictionaryVersion</key>',
      '\t<string>6.0</string>',
      '\t<key>CFBundleName</key>',
      '\t<string>$(PRODUCT_NAME)</string>',
      '\t<key>CFBundlePackageType</key>',
      '\t<string>XPC!</string>',
      '\t<key>CFBundleShortVersionString</key>',
      `\t<string>${escapeXml(shortVersion)}</string>`,
      '\t<key>CFBundleVersion</key>',
      `\t<string>${escapeXml(buildNumber)}</string>`,
      '\t<key>NSExtension</key>',
      '\t<dict>',
      '\t\t<key>NSExtensionPointIdentifier</key>',
      '\t\t<string>com.apple.widgetkit-extension</string>',
      '\t</dict>',
      `\t<key>${APP_GROUP_INFO_PLIST_KEY}</key>`,
      `\t<string>${escapeXml(appGroup)}</string>`,
      '</dict>',
    ].join('\n')
  );
}

function widgetEntitlements(appGroup) {
  return plist(
    [
      '<dict>',
      `\t<key>${APP_GROUPS_ENTITLEMENT}</key>`,
      '\t<array>',
      `\t\t<string>${escapeXml(appGroup)}</string>`,
      '\t</array>',
      '</dict>',
    ].join('\n')
  );
}

function sourceDirectory(projectRoot) {
  return path.join(projectRoot, 'targets', TARGET_NAME);
}

function widgetSourceNames(projectRoot) {
  const directory = sourceDirectory(projectRoot);
  if (!fs.existsSync(directory)) {
    throw new Error(`withRidikIosWidget: no widget sources at ${directory}.`);
  }
  const names = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.swift'))
    .sort();
  if (names.length === 0) {
    throw new Error(`withRidikIosWidget: ${directory} contains no Swift files.`);
  }
  return names;
}

/**
 * Copies the widget into `ios/` and writes its generated config.
 *
 * The copy is one-way. `ios/` is regenerated output and editing
 * `ios/RidikWidget/*.swift` in Xcode loses the change on the next prebuild —
 * `targets/RidikWidget/` is the file you want.
 */
function withWidgetFiles(config, { appGroup }) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const { projectRoot, platformProjectRoot } = cfg.modRequest;
      const from = sourceDirectory(projectRoot);
      const to = path.join(platformProjectRoot, TARGET_NAME);

      // Cleared rather than merged, so a source file deleted upstream does not
      // survive in the generated project and keep compiling.
      fs.rmSync(to, { recursive: true, force: true });
      fs.mkdirSync(to, { recursive: true });

      for (const name of widgetSourceNames(projectRoot)) {
        fs.copyFileSync(path.join(from, name), path.join(to, name));
      }

      fs.writeFileSync(
        path.join(to, 'Info.plist'),
        widgetInfoPlist({
          displayName: cfg.name,
          shortVersion: cfg.version || '1.0.0',
          buildNumber: (cfg.ios && cfg.ios.buildNumber) || '1',
          appGroup,
        }),
        'utf8'
      );

      fs.writeFileSync(
        path.join(to, `${TARGET_NAME}.entitlements`),
        widgetEntitlements(appGroup),
        'utf8'
      );

      return cfg;
    },
  ]);
}

// ------------------------------------------------------------------- the target

/**
 * `pbxTargetByName` compares against the raw comment, which xcode's own
 * `addTarget` writes quoted — so it never finds a target this plugin added.
 * Without this the second `expo prebuild` in a row adds a duplicate target.
 */
function findTarget(project, name) {
  const section = project.pbxNativeTargetSection();
  for (const key of Object.keys(section)) {
    if (key.endsWith('_comment')) continue;
    if (IOSConfig.XcodeUtils.unquote(String(section[key].name)) === name) {
      return { uuid: key, target: section[key] };
    }
  }
  return null;
}

function appBuildSetting(project, appTargetUuid, key) {
  const lists = project.pbxXCConfigurationList();
  const app = project.pbxNativeTargetSection()[appTargetUuid];
  const list = lists[app.buildConfigurationList];
  if (!list) return undefined;
  const configurations = project.pbxXCBuildConfigurationSection();
  for (const entry of list.buildConfigurations) {
    const settings = configurations[entry.value] && configurations[entry.value].buildSettings;
    if (settings && settings[key] != null) return settings[key];
  }
  return undefined;
}

function withWidgetTarget(config, { targetBundleIdentifier }) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    if (findTarget(project, TARGET_NAME)) return cfg;

    const app = project.getTarget('com.apple.product-type.application');
    if (!app) {
      throw new Error('withRidikIosWidget: could not find the application target.');
    }

    // xcode's `addTargetDependency` writes into these two sections and does
    // nothing at all when they are missing, which they are in a project that
    // has only ever had one target. Without them the app's `dependencies` list
    // stays empty and the widget is built only if Xcode happens to infer the
    // dependency from the embed phase.
    const objects = project.hash.project.objects;
    objects.PBXTargetDependency = objects.PBXTargetDependency || {};
    objects.PBXContainerItemProxy = objects.PBXContainerItemProxy || {};

    // Creates the target, embeds `RidikWidget.appex` in the app's Copy Files
    // phase and makes the app depend on it — so building the Ridik scheme
    // builds and installs the widget, with no second scheme to remember.
    const target = project.addTarget(
      TARGET_NAME,
      'app_extension',
      TARGET_NAME,
      targetBundleIdentifier
    );

    // Both phases must exist before any file is added: the helpers below look a
    // phase up by target and silently fall back to the first one with a
    // matching name in the whole project, which would compile the widget into
    // the app.
    project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', target.uuid);
    project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);

    // Without this the group lookup below quietly falls back to the project's
    // root group and the widget's files are filed next to `AppDelegate.swift`.
    IOSConfig.XcodeUtils.ensureGroupRecursively(project, TARGET_NAME);

    for (const name of widgetSourceNames(cfg.modRequest.projectRoot)) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath: `${TARGET_NAME}/${name}`,
        groupName: TARGET_NAME,
        project,
        targetUuid: target.uuid,
      });
    }

    const deploymentTarget =
      appBuildSetting(project, app.uuid, 'IPHONEOS_DEPLOYMENT_TARGET') ||
      FALLBACK_DEPLOYMENT_TARGET;
    const developmentTeam = appBuildSetting(project, app.uuid, 'DEVELOPMENT_TEAM');

    const common = {
      CLANG_ENABLE_MODULES: 'YES',
      CODE_SIGN_ENTITLEMENTS: `${TARGET_NAME}/${TARGET_NAME}.entitlements`,
      // CODE_SIGN_STYLE is deliberately left unset. Simulator builds do not
      // sign, and on a device EAS writes the signing settings per target — a
      // hard-coded "Automatic" here would fight it.
      CURRENT_PROJECT_VERSION: `"${cfg.ios && cfg.ios.buildNumber ? cfg.ios.buildNumber : '1'}"`,
      // The plist is written by this plugin; letting Xcode synthesise one on top
      // produces a widget with no NSExtension dictionary, which never loads.
      GENERATE_INFOPLIST_FILE: 'NO',
      INFOPLIST_FILE: `${TARGET_NAME}/Info.plist`,
      IPHONEOS_DEPLOYMENT_TARGET: deploymentTarget,
      LD_RUNPATH_SEARCH_PATHS:
        '"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"',
      MARKETING_VERSION: `"${cfg.version || '1.0.0'}"`,
      PRODUCT_BUNDLE_IDENTIFIER: targetBundleIdentifier,
      PRODUCT_NAME: `"${TARGET_NAME}"`,
      // An extension is embedded in the app, never installed beside it.
      SKIP_INSTALL: 'YES',
      // Unset at project level, and Xcode refuses to compile Swift without it.
      SWIFT_VERSION: '5.0',
      TARGETED_DEVICE_FAMILY: '"1,2"',
      ...(developmentTeam ? { DEVELOPMENT_TEAM: developmentTeam } : {}),
    };

    const perConfiguration = {
      // `DEBUG` itself already comes down from the project's own Debug config.
      Debug: {
        SWIFT_OPTIMIZATION_LEVEL: '"-Onone"',
      },
      Release: {
        SWIFT_COMPILATION_MODE: 'wholemodule',
        SWIFT_OPTIMIZATION_LEVEL: '"-O"',
      },
    };

    const configurations = IOSConfig.XcodeUtils.getBuildConfigurationsForListId(
      project,
      target.pbxNativeTarget.buildConfigurationList
    );
    for (const [, configuration] of configurations) {
      const name = IOSConfig.XcodeUtils.unquote(String(configuration.name));
      configuration.buildSettings = {
        ...configuration.buildSettings,
        ...common,
        ...(perConfiguration[name] || {}),
      };
    }

    return cfg;
  });
}

/** @type {import('expo/config-plugins').ConfigPlugin<{ appGroup?: string; bundleIdentifier?: string }>} */
const withRidikIosWidget = (config, options = {}) => {
  const resolved = resolveOptions(config, options);
  config = withAppGroupOnApp(config, resolved);
  config = withWidgetFiles(config, resolved);
  config = withWidgetTarget(config, resolved);
  return config;
};

module.exports = withRidikIosWidget;
