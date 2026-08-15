import type { ExpoConfig, ConfigContext } from 'expo/config';

/**
 * Ridik — voice-first personal operating system.
 *
 * Dynamic config so secrets/ids can come from the environment at build time.
 * Nothing secret is committed; `extra` only carries public client identifiers.
 */
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Ridik',
  slug: 'ridik',
  scheme: 'ridik',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  assetBundlePatterns: ['**/*'],
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'ai.raisen.ridik',
    // Every upload needs a build number higher than the last one App Store
    // Connect accepted, even when `version` has not moved. `npm run release
    // bump` advances this and `android.versionCode` together, so the two
    // platforms never drift apart mid-release.
    buildNumber: '1',
    // Live Activities + background execution.
    infoPlist: {
      NSSupportsLiveActivities: true,
      NSSupportsLiveActivitiesFrequentUpdates: true,
      UIBackgroundModes: ['location', 'fetch', 'processing', 'audio', 'remote-notification'],
      NSMicrophoneUsageDescription:
        'Ridik listens to your voice so you can capture tasks, notes and reminders hands-free.',
      NSSpeechRecognitionUsageDescription:
        'Ridik transcribes your speech on-device to understand your commands.',
      NSCalendarsUsageDescription:
        'Ridik reads and writes your calendar so it can schedule and adjust events by voice.',
      NSCalendarsFullAccessUsageDescription:
        'Ridik reads and writes your calendar so it can schedule and adjust events by voice.',
      NSRemindersFullAccessUsageDescription:
        'Ridik creates reminders that match the tasks you capture by voice.',
      NSLocationWhenInUseUsageDescription:
        'Ridik uses your location to trigger place-based reminders such as "remind me at the lab".',
      NSLocationAlwaysAndWhenInUseUsageDescription:
        'Ridik monitors places you choose in the background so location reminders fire even when the app is closed.',
      NSLocationAlwaysUsageDescription:
        'Ridik monitors places you choose in the background so location reminders fire even when the app is closed.',
      ITSAppUsesNonExemptEncryption: false,
    },
    entitlements: {
      'com.apple.developer.usernotifications.time-sensitive': true,
      // The App Group the home-screen widget reads through is deliberately not
      // listed here. `withRidikIosWidget` adds it to this file *and* to the
      // extension's entitlements from one constant, because the two must be
      // byte-identical and a mismatch fails silently — each process gets its
      // own empty container and the widget shows nothing.
    },
  },
  android: {
    package: 'ai.raisen.ridik',
    // Play's twin of ios.buildNumber, and it must be an integer that only ever
    // goes up — Play permanently refuses a versionCode it has already seen.
    versionCode: 1,
    predictiveBackGestureEnabled: false,
    adaptiveIcon: {
      backgroundColor: '#0B0B0F',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    permissions: [
      'android.permission.RECORD_AUDIO',
      'android.permission.INTERNET',
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.ACCESS_BACKGROUND_LOCATION',
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_LOCATION',
      'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.READ_CALENDAR',
      'android.permission.WRITE_CALENDAR',
      'android.permission.SCHEDULE_EXACT_ALARM',
      'android.permission.USE_EXACT_ALARM',
      'android.permission.WAKE_LOCK',
      'android.permission.RECEIVE_BOOT_COMPLETED',
      'android.permission.VIBRATE',
    ],
  },
  web: {
    favicon: './assets/favicon.png',
    bundler: 'metro',
  },
  plugins: [
    'expo-router',
    'expo-status-bar',
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        resizeMode: 'contain',
        backgroundColor: '#FBFBFD',
        dark: { backgroundColor: '#0B0B0F' },
        imageWidth: 180,
      },
    ],
    'expo-secure-store',
    'expo-web-browser',
    [
      'expo-speech-recognition',
      {
        microphonePermission:
          'Ridik listens to your voice so you can capture tasks, notes and reminders hands-free.',
        speechRecognitionPermission:
          'Ridik transcribes your speech on-device to understand your commands.',
        androidSpeechServicePackages: ['com.google.android.googlequicksearchbox'],
      },
    ],
    [
      'expo-calendar',
      {
        calendarPermission:
          'Ridik reads and writes your calendar so it can schedule and adjust events by voice.',
        remindersPermission:
          'Ridik creates reminders that match the tasks you capture by voice.',
      },
    ],
    [
      'expo-location',
      {
        locationAlwaysAndWhenInUsePermission:
          'Ridik monitors places you choose so location reminders fire even when the app is closed.',
        locationAlwaysPermission:
          'Ridik monitors places you choose so location reminders fire even when the app is closed.',
        locationWhenInUsePermission:
          'Ridik uses your location to trigger place-based reminders.',
        isIosBackgroundLocationEnabled: true,
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
      },
    ],
    [
      'expo-notifications',
      {
        icon: './assets/android-icon-monochrome.png',
        color: '#7C5CFF',
        defaultChannel: 'default',
      },
    ],
    [
      'expo-audio',
      {
        microphonePermission:
          'Ridik records short audio clips when on-device transcription is unavailable.',
      },
    ],
    [
      'expo-quick-actions',
      {
        // Long-press the home-screen icon to start talking without opening a
        // screen first — the spec's "system shortcut" route to the mic.
        androidIcons: {
          mic: {
            foregroundImage: './assets/android-icon-foreground.png',
            backgroundColor: '#7C5CFF',
          },
        },
        iosActions: [
          {
            id: 'speak',
            title: 'Speak to Ridik',
            subtitle: 'Capture a thought hands-free',
            icon: 'symbol:mic.fill',
            params: { href: '/?speak=1' },
          },
          {
            id: 'briefing',
            title: "Today's briefing",
            icon: 'symbol:sparkles',
            params: { href: '/briefing' },
          },
        ],
      },
    ],
    [
      'expo-build-properties',
      {
        ios: { deploymentTarget: '16.4' },
        android: {
          compileSdkVersion: 36,
          targetSdkVersion: 36,
          minSdkVersion: 26,
          // No x86. Those two ABIs exist for Intel emulators and no shipping
          // phone, and carrying them put 51MB of unusable native code in the
          // APK — more than a third of it. Apple Silicon emulators are arm64,
          // so this costs nothing here; anyone on an Intel Mac can build one
          // with `./gradlew <task> -PreactNativeArchitectures=x86_64`.
          buildArchs: ['armeabi-v7a', 'arm64-v8a'],
          // R8 off left 53MB of dex across five files. Resource shrinking needs
          // it, and the widget resources are protected from it by the keep.xml
          // that `withRidikAndroidWidget` writes — they are reached through
          // `Resources.getIdentifier`, which R8 cannot see.
          enableMinifyInReleaseBuilds: true,
          enableShrinkResourcesInReleaseBuilds: true,
        },
      },
    ],
    // The Android home-screen widget's manifest receiver and resources. Its
    // Kotlin lives in modules/ridik-widgets/; only the app-module half needs
    // rewriting after a prebuild.
    './plugins/withRidikAndroidWidget',
    // The iOS WidgetKit extension: a second Xcode target that prebuild does not
    // create on its own, plus the App Group the app publishes snapshots into.
    // Its Swift lives in targets/RidikWidget/ and modules/ridik-widgets/ios/.
    './plugins/withRidikIosWidget',
    // Signs release builds with credentials/android/upload.keystore instead of
    // the template's debug key, which Play rejects. Does nothing until
    // `npm run release keystore` has created one.
    './plugins/withRidikAndroidSigning',
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: false,
  },
  extra: {
    /**
     * Set this in store builds and the app routes every assistant request
     * through your backend, which holds the model key and checks the
     * subscription. Leave it unset for your own builds and the app uses a
     * personal key from the device keychain instead — which is how one
     * codebase serves both "my free-tier key" and "paying customers".
     */
    assistantApiUrl: process.env.EXPO_PUBLIC_RIDIK_API_URL ?? '',
    /**
     * Both are required before an App Store submission that sells a
     * subscription, and the Settings screen links to them. Left empty here on
     * purpose: a placeholder URL that 404s is worse than an honest "not set up
     * yet" in the app.
     */
    legal: {
      privacy: process.env.EXPO_PUBLIC_PRIVACY_URL ?? '',
      terms: process.env.EXPO_PUBLIC_TERMS_URL ?? '',
    },
    googleOAuth: {
      iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '',
      androidClientId: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ?? '',
      webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '',
    },
    eas: { projectId: process.env.EAS_PROJECT_ID ?? undefined },
  },
});
