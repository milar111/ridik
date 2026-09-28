import type { ExpoConfig, ConfigContext } from 'expo/config';

/**
 * Ridik — voice-first personal operating system.
 *
 * Dynamic config so secrets/ids can come from the environment at build time.
 * Nothing secret is committed; `extra` only carries public client identifiers.
 */
/**
 * A build that a **free Apple ID can sign**, for putting Ridik on somebody's
 * iPhone without the $99 Developer Program.
 *
 * Set `RIDIK_FREE_SIGNING=1` for the prebuild. It is off by default and must
 * stay that way: everything it removes is something a store build needs.
 *
 * ```bash
 * RIDIK_FREE_SIGNING=1 npx expo prebuild --clean -p ios
 * ```
 *
 * Then open `ios/Ridik.xcworkspace`, set the Ridik target's team to your
 * personal team, plug the phone in and Run. It works for **seven days** and
 * then stops launching, and re-signing needs the phone back on this Mac.
 *
 * **What it removes, and why it has to.** A personal team cannot be granted
 * capabilities that are provisioned through the Developer portal, and Xcode
 * fails to provision rather than warning:
 *
 *  - **App Groups.** `withRidikIosWidget` is what puts `group.ai.dby.ridik`
 *    into both the app's and the extension's entitlements, so dropping that
 *    one plugin removes the group *and* the WidgetKit target together — which
 *    is correct, because a widget with no shared container is a blank tile
 *    rather than a missing one. `RidikWidgetsModule` then finds no
 *    `RidikAppGroup` key in Info.plist and throws, and `publish.ts` catches it
 *    the same way it does on a build with no native module at all.
 *  - **Time-sensitive notifications.** Reminders still fire; they just cannot
 *    break through a Focus.
 *
 * So the tester gets the whole app — voice, calendar, notes, the ledger, local
 * reminders — and no home-screen widgets. Say so when you hand it over, or the
 * first thing they report is the thing you removed.
 *
 * Nothing here touches Android, which needs none of it: a release APK installs
 * on any phone with no account, no fee and no expiry.
 */
const FREE_SIGNING = process.env.RIDIK_FREE_SIGNING === '1';

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
    /*
     * iPhone only, deliberately.
     *
     * `orientation: 'portrait'` above and the Android manifest's own
     * `screenOrientation="portrait"` say what this app is: a one-handed
     * instrument with a microphone under the thumb. Nothing in it is designed
     * for a 13-inch landscape canvas, and an iPad-capable binary obliges a full
     * set of 13" screenshots at upload.
     *
     * Kept in step with `TARGETED_DEVICE_FAMILY` in
     * `plugins/withRidikIosWidget.js`: a host app declaring "1" while its
     * widget extension declares "1,2" fails upload validation, and the error
     * names neither file.
     *
     * Dropping iPad AFTER a release is treated as removing device support, so
     * this is a decision to take before the first upload rather than after.
     */
    supportsTablet: false,
    bundleIdentifier: 'ai.dby.ridik',
    /**
     * The privacy manifest, declared here because `ios/` is generated.
     *
     * `ios/Ridik/PrivacyInfo.xcprivacy` is written by prebuild and `ios/` is
     * gitignored, so a hand-edit there survives exactly until the next
     * `expo prebuild` and then silently reverts to declaring that this app
     * collects nothing. It shipped saying `NSPrivacyCollectedDataTypes: []`,
     * which stopped being true the day the first turn was sent to a model and
     * is now also wrong about the usage counts and crash reports.
     *
     * `NSPrivacyTracking` stays **false** and must: "tracking" in Apple's sense
     * is linking this data to other apps' data or a data broker's, and nothing
     * here does that or can — there is no identifier in the payload to link on.
     *
     * These entries must stay in step with the App Store Connect questionnaire
     * and with Play's Data safety form; `notes/STORE-CHECKLIST.md` holds all
     * three side by side.
     */
    privacyManifests: {
      NSPrivacyTracking: false,
      NSPrivacyTrackingDomains: [],
      NSPrivacyCollectedDataTypes: [
        /*
         * `Linked` is the question this list gets wrong most easily, so it is
         * answered per row rather than uniformly.
         *
         * A hosted turn carries RevenueCat's anonymous app user id alongside
         * the request, so on that path the content and an identifier arrive at
         * the same server together — which is Apple's definition of linked,
         * whether or not the operator ever joins them. Saying "no" there
         * because the id is anonymous is the answer that gets a build rejected.
         *
         * The three analytics and crash rows are the opposite and genuinely
         * unlinked: `services/analytics/upload.ts` sends counters with no id,
         * no header that could become one, and no account, and `crash.ts`
         * deletes Sentry's `user` before send. That is what `Linked: false`
         * is supposed to mean, and it is only true here because the
         * vocabulary test keeps it true.
         */
        {
          // The counts on the Usage screen, and only if the switch is on.
          NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeProductInteraction',
          NSPrivacyCollectedDataTypeLinked: false,
          NSPrivacyCollectedDataTypeTracking: false,
          NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAnalytics'],
        },
        {
          // Latency buckets and error codes — the same switch.
          NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypePerformanceData',
          NSPrivacyCollectedDataTypeLinked: false,
          NSPrivacyCollectedDataTypeTracking: false,
          NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAnalytics'],
        },
        {
          // Sentry, same switch, off by default.
          NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeCrashData',
          NSPrivacyCollectedDataTypeLinked: false,
          NSPrivacyCollectedDataTypeTracking: false,
          NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        },
        {
          // What the assistant is told: the sentence, plus the index of labels
          // `buildLlmContext` assembles. Not new, and never declared before.
          NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeOtherUserContent',
          NSPrivacyCollectedDataTypeLinked: true,
          NSPrivacyCollectedDataTypeTracking: false,
          NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        },
        {
          // People in the CRM reach the model inside that same index. They used
          // to reach a push provider too, inside the briefing line; that path is
          // gone, and the declaration stays because the first half is enough.
          NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeName',
          NSPrivacyCollectedDataTypeLinked: true,
          NSPrivacyCollectedDataTypeTracking: false,
          NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        },
        {
          // The recording itself, on two paths: Whisper, and the platform
          // dictation service when the phone has no offline voice.
          NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeAudioData',
          NSPrivacyCollectedDataTypeLinked: false,
          NSPrivacyCollectedDataTypeTracking: false,
          NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        },
        {
          // Reverse geocoding a saved place sends coordinates to the platform
          // geocoder. Geofences are evaluated on the device.
          NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypePreciseLocation',
          NSPrivacyCollectedDataTypeLinked: false,
          NSPrivacyCollectedDataTypeTracking: false,
          NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        },
        {
          // RevenueCat, and through it Apple.
          NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypePurchaseHistory',
          NSPrivacyCollectedDataTypeLinked: true,
          NSPrivacyCollectedDataTypeTracking: false,
          NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        },
        {
          // The RevenueCat anonymous app user id. It was this and a push
          // subscription id; the second is gone with the SDK and the first is
          // enough on its own, so the declaration stays exactly as it was.
          NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeDeviceID',
          NSPrivacyCollectedDataTypeLinked: true,
          NSPrivacyCollectedDataTypeTracking: false,
          NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        },
      ],
    },
    // Every upload needs a build number higher than the last one App Store
    // Connect accepted, even when `version` has not moved. `npm run release
    // bump` advances this and `android.versionCode` together, so the two
    // platforms never drift apart mid-release.
    buildNumber: '1',
    // Live Activities + background execution.
    infoPlist: {
      NSSupportsLiveActivities: true,
      NSSupportsLiveActivitiesFrequentUpdates: true,
      /*
       * `audio` is deliberately absent. Nothing plays in the background: the
       * focus ticker is off while backgrounded and phase changes are OS-held
       * local notifications. An unused background mode is a 2.5.4 rejection,
       * and it is also re-appended by expo-audio unless that plugin is told
       * not to — see `enableBackgroundPlayback` below. Removing it here alone
       * does nothing.
       */
      UIBackgroundModes: ['location', 'fetch', 'processing', 'remote-notification'],
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
      // Provisioned through the Developer portal, so a free personal team
      // cannot have it and Xcode refuses the build rather than warning.
      ...(FREE_SIGNING ? {} : { 'com.apple.developer.usernotifications.time-sensitive': true }),
      // The App Group the home-screen widget reads through is deliberately not
      // listed here. `withRidikIosWidget` adds it to this file *and* to the
      // extension's entitlements from one constant, because the two must be
      // byte-identical and a mismatch fails silently — each process gets its
      // own empty container and the widget shows nothing.
    },
  },
  android: {
    package: 'ai.dby.ridik',
    /*
     * The scheme Google redirects into after sign-in, and nothing else.
     *
     * Google's installed-app clients hand the browser back through a custom URI
     * scheme, and `redirectUriFor()` sends the application id — which is what
     * expo-auth-session's own Google provider defaults to. iOS registers the
     * bundle identifier as a URL type by itself (@expo/config-plugins pushes it
     * onto CFBundleURLSchemes and says in a comment that it is for exactly
     * this), so declaring it in `scheme` would only write it into the plist
     * twice. Android registers nothing it is not told about.
     *
     * Left out, the flow failed at the last hop and looked like a success:
     * the consent screen appeared, the user granted it, Google recorded the
     * grant, and the redirect arrived at an OS with nowhere to deliver it. No
     * error, no cancellation — the app simply never heard back.
     */
    intentFilters: [
      {
        action: 'VIEW',
        category: ['BROWSABLE', 'DEFAULT'],
        data: [{ scheme: 'ai.dby.ridik' }],
      },
    ],
    // Play's twin of ios.buildNumber, and it must be an integer that only ever
    // goes up — Play permanently refuses a versionCode it has already seen.
    versionCode: 1,
    predictiveBackGestureEnabled: false,
    adaptiveIcon: {
      backgroundColor: '#FFF7F1',
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
      /*
       * FOREGROUND_SERVICE, _LOCATION and _SPECIAL_USE were declared and
       * unreachable. No service declares `foregroundServiceType="specialUse"`
       * and there is no PROPERTY_SPECIAL_USE_FGS_SUBTYPE, so Android 14+ would
       * reject `startForeground` anyway; the location wake path returns early
       * off iOS and never sets the `foregroundService` key the task consumer
       * requires. Play's permissions policy treats an unused foreground-service
       * declaration as grounds for manual review, and `specialUse` in
       * particular invites it. `isAndroidForegroundServiceEnabled: false` below
       * stops expo-location re-adding them.
       */
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
    /*
      **First in this list, which is what makes it run *last*.**

      Expo's mods compose in reverse: each `withEntitlementsPlist` wraps the one
      registered before it, so the plugin listed *last* has its action executed
      *first*. Registered at the end, this saw an empty entitlements dict and
      deleted nothing — verified by logging the keys it was handed, because the
      failure is silent and the finished plist looked exactly as it had.

      Only present under `RIDIK_FREE_SIGNING`, and it strips the entitlements a
      personal team cannot be granted. It has to be a stripper rather than fewer
      plugins because `expo-notifications` writes `aps-environment`
      unconditionally, with no prop to stop it.
    */
    ...(FREE_SIGNING ? ['./plugins/withRidikFreeSigning'] : []),
    /*
     * Crash reporting, and **only when there is a Sentry account behind it**.
     *
     * The plugin wires the native SDK in and adds a build phase that uploads
     * source maps through `sentry-cli`. That phase is not optional and not
     * skippable: with no organisation configured it fails the whole iOS build
     * with `An organization ID or slug is required`, several thousand lines
     * into a log, long after the JavaScript has bundled cleanly. Adding the
     * plugin unconditionally therefore breaks every build made by anybody who
     * has not signed up for Sentry — including the release script.
     *
     * So it is capability-detected like everything else here: no DSN, no
     * plugin, no upload phase, and `services/analytics/crash.ts` finds no
     * native module and reports nothing. That is exactly the state this repo
     * was in before, which is the right default. Set `EXPO_PUBLIC_SENTRY_DSN`
     * (and `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` for readable
     * stack traces) and the whole path switches on at the next prebuild.
     */
    ...(process.env.EXPO_PUBLIC_SENTRY_DSN
      ? ([
          [
            '@sentry/react-native',
            {
              organization: process.env.SENTRY_ORG,
              project: process.env.SENTRY_PROJECT,
              authToken: process.env.SENTRY_AUTH_TOKEN,
            },
          ],
        ] as NonNullable<ExpoConfig['plugins']>)
      : []),
    'expo-router',
    'expo-status-bar',
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        resizeMode: 'contain',
        backgroundColor: '#FFF7F1',
        // Its own image, not just its own ground. The mark is drawn in the
        // *cold* cell of whichever ramp is showing, and a static PNG cannot
        // follow the system — hand a dark launch the light-mode pink and it
        // pops to brown the instant `SplashCurtain` takes over.
        dark: { image: './assets/splash-icon-dark.png', backgroundColor: '#17100C' },
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
        remindersPermission: 'Ridik creates reminders that match the tasks you capture by voice.',
      },
    ],
    [
      'expo-location',
      {
        locationAlwaysAndWhenInUsePermission:
          'Ridik monitors places you choose so location reminders fire even when the app is closed.',
        locationAlwaysPermission:
          'Ridik monitors places you choose so location reminders fire even when the app is closed.',
        locationWhenInUsePermission: 'Ridik uses your location to trigger place-based reminders.',
        isIosBackgroundLocationEnabled: true,
        isAndroidBackgroundLocationEnabled: true,
        // Geofencing does not need one — the OS holds the regions. See the note
        // on the removed permissions above.
        isAndroidForegroundServiceEnabled: false,
      },
    ],
    [
      'expo-notifications',
      {
        icon: './assets/android-icon-monochrome.png',
        color: '#C7360F',
        defaultChannel: 'default',
      },
    ],
    [
      'expo-audio',
      {
        /*
         * This is the string iOS actually shows.
         *
         * `applyPermissions` resolves `permissions[p] || infoPlist[p] || default`,
         * so this plugin's value beats the `ios.infoPlist` one above and
         * expo-speech-recognition's identical one — regardless of plugin order.
         * It used to describe only the optional Whisper fallback ("short audio
         * clips when on-device transcription is unavailable"), which omits the
         * app's primary and constant use of the microphone: the entire product.
         * 5.1.1(ii) requires the purpose string to be complete, and setting
         * `microphonePermission: false` deletes the key, which is a worse
         * rejection than a poor sentence.
         *
         * It also discloses that audio can leave the device, because it can:
         * the recogniser streams to Apple or Google when the phone has no
         * offline voice, and Whisper posts to OpenAI.
         */
        microphonePermission:
          'Ridik listens to your voice so you can capture tasks, notes and reminders ' +
          'hands-free. When your phone cannot transcribe offline, the recording is sent ' +
          'to a speech service to be turned into text.',
        // Nothing plays or records in the background; both default to true and
        // re-add the iOS `audio` background mode when they do.
        enableBackgroundPlayback: false,
        enableBackgroundRecording: false,
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
            backgroundColor: '#C7360F',
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
          /*
           * What R8 cannot see, and what it cost.
           *
           * Everything background in this app is reached by *class name as a
           * string*, from two places R8 does not read. `AppLoaderProvider` gets
           * the loader's name out of a manifest `meta-data` value and calls
           * `Class.forName`; `TaskService.restoreTasks` gets each consumer's
           * name out of SharedPreferences and does the same. R8 sees no
           * reference to either, so it strips them — and the first release build
           * ever produced logged
           * `ClassNotFoundException: …RNHeadlessAppLoader`.
           *
           * `TaskService.loadApp` then calls `getAppLoader().loadApp(…)` with no
           * null check, so a stripped loader is an NPE at the moment a geofence
           * or a background fetch tries to run JavaScript with the app closed.
           * Place reminders and the daily briefing would simply never fire in a
           * shipped build, while working perfectly in every debug build, because
           * minification is a release-only step.
           *
           * The consumers need their *names* kept as well as their code: a name
           * persisted by one build has to still resolve after an update, and R8
           * renames freely across builds.
           *
           * Sibling to the `keep.xml` that `withRidikAndroidWidget` writes for
           * resources reached through `Resources.getIdentifier` — same blind
           * spot, other half of the build.
           */
          extraProguardRules: [
            '-keep class expo.modules.apploader.** { *; }',
            '-keep class expo.modules.adapters.react.apploader.** { *; }',
            '-keep class * implements expo.modules.interfaces.taskManager.TaskConsumerInterface { *; }',
          ].join('\n'),
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
    //
    // Dropped entirely under `RIDIK_FREE_SIGNING`, because it is the only
    // source of the App Group and a personal team cannot be granted one. The
    // target and the entitlement have to go together — see the note above.
    ...(FREE_SIGNING ? [] : ['./plugins/withRidikIosWidget']),
    // Signs release builds with credentials/android/upload.keystore instead of
    // the template's debug key, which Play rejects. Does nothing until
    // `npm run release keystore` has created one.
    './plugins/withRidikAndroidSigning',
    './plugins/withRidikAndroidBackup',
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
     * Sentry, for crashes only, and read by `services/analytics/crash.ts`.
     *
     * Empty is the normal state and means the build reports nothing — the same
     * capability-detected posture as `assistantApiUrl` above. Even with a DSN
     * set, nothing is sent until the person turns "Help improve Ridik" on;
     * this only decides whether the switch has anywhere to point.
     */
    sentryDsn: process.env.EXPO_PUBLIC_SENTRY_DSN ?? '',
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
    /**
     * RevenueCat. The two SDK keys are *publishable* — they are meant to be in
     * the binary — but they still come from the environment so a fork, a demo
     * build and the store build can each point at their own project without a
     * diff. `src/services/billing/revenuecat.ts` treats an empty key as "not
     * configured" and falls back to the development provider.
     *
     * `entitlement` is the identifier the dashboard hands out on a successful
     * purchase, and it is the single string that decides whether anybody is
     * subscribed. Naming it here means the entitlement can be renamed in
     * RevenueCat without a release; `assistant` is what shipped, so it stays
     * the fallback and an unset env var changes nothing.
     */
    revenueCat: {
      ios: process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY ?? '',
      android: process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY ?? '',
      entitlement: process.env.EXPO_PUBLIC_REVENUECAT_ENTITLEMENT ?? 'assistant',
    },
    /*
     * Google OAuth. Four client ids, and the Android pair is not redundancy.
     *
     * An Android OAuth client is bound to exactly one signing fingerprint, and
     * this project is signed by two different keys: the Expo template keystore
     * for `assembleDebug` and the upload key in `credentials/` for anything
     * shippable. One id therefore cannot serve both builds — `activeClientId()`
     * chooses on `__DEV__`. `androidClientIdDebug` empty is fine and simply
     * falls back to the release id.
     */
    googleOAuth: {
      iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '',
      androidClientId: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ?? '',
      androidClientIdDebug: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID_DEBUG ?? '',
      webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '',
    },
    eas: { projectId: process.env.EAS_PROJECT_ID ?? undefined },
  },
});
