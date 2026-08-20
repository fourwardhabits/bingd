import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Three variants per docs/architecture/client.md §8. Selected by APP_VARIANT so
 * all three can sit on one home screen and be told apart at a glance.
 */
type Variant = 'development' | 'preview' | 'production';

const variant = (process.env.APP_VARIANT ?? 'development') as Variant;

const variants: Record<Variant, { name: string; bundleId: string; scheme: string }> = {
  development: { name: 'bingd dev', bundleId: 'app.bingd.dev', scheme: 'bingd-dev' },
  preview: { name: 'bingd preview', bundleId: 'app.bingd.preview', scheme: 'bingd-preview' },
  production: { name: 'bingd', bundleId: 'app.bingd', scheme: 'bingd' },
};

const current = variants[variant];

/**
 * `eas init` could not write this itself: it edits app.json, and this project uses a
 * TypeScript config so the variant logic above is expressible.
 */
const EAS_PROJECT_ID = 'd10f76cc-fac0-4812-9938-d32e8bcea008';

/**
 * Destinations for the share sheet. Declared in every build even though v1 never
 * calls them directly, because a manifest change cannot ship over the air —
 * see PRD §16 and docs/architecture/README.md.
 */
const shareDestinationSchemes = [
  'instagram',
  'instagram-stories',
  'facebook-stories',
  'snapchat',
  'tiktoksharesdk',
  'threads',
];

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: current.name,
  slug: 'bingd',
  owner: 'fourward',
  version: '0.1.0',
  orientation: 'portrait',
  scheme: current.scheme,
  userInterfaceStyle: 'light',
  // Paper. Mirrors surface.base in src/ui/tokens/color.ts — this file cannot
  // import from src, so the value is duplicated and has to be changed in step.
  backgroundColor: '#FBF8F4',
  // Rendered from bingd-icon.svg by `npm run brand:render`, not drawn by hand.
  icon: './assets/brand/icon.png',

  // The Android system navigation bar is configured by omission, and it is
  // worth writing down why there is no key for it here.
  //
  // SDK 57 draws edge to edge and dropped `androidNavigationBar` from the
  // config entirely — under edge-to-edge the app draws *behind* that bar rather
  // than colouring it, so a background colour had nothing left to mean. What
  // shows through is whatever the app paints there, which on the tab screens is
  // the tab bar: the navigator sizes it to `49 + insets.bottom`, so its
  // `surface.raised` extends under the buttons.
  //
  // Button colour follows `userInterfaceStyle: 'light'` above, which is what
  // makes them dark and legible on that surface — and dark buttons are also
  // what stops Android drawing its own contrast scrim behind them, which was
  // the grey band under the tab bar. `expo-navigation-bar` would let this be
  // forced at runtime and is deliberately not installed: it is a native module,
  // the fingerprint runtime policy means adding one puts every tester on a new
  // build, and there is nothing here for it to fix.

  ios: {
    supportsTablet: false,
    bundleIdentifier: current.bundleId,
    associatedDomains: ['applinks:bingd.app'],
    // Adds the entitlement, which EAS then turns into the Sign In with Apple
    // capability on the App ID during the first build — so there is nothing to do
    // by hand in the Apple portal.
    //
    // iOS only, deliberately. Apple mandates the button wherever a third-party
    // sign-in is offered (App Review 4.8), and that mandate is an iOS one. Adding
    // it on Android would mean the OAuth redirect flow, which needs a Services ID
    // and a JWT signed with a .p8 that expires after six months and fails with no
    // warning — sign-in would simply stop working one day. Android has Google and
    // email, so there is nothing to buy with that risk.
    usesAppleSignIn: true,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      LSApplicationQueriesSchemes: shareDestinationSchemes,
    },
  },

  android: {
    package: current.bundleId,
    // A launcher masks this to its own shape and may crop the outer third of
    // each axis, so the foreground is the mark well inside a Paper field rather
    // than the square icon above.
    adaptiveIcon: {
      foregroundImage: './assets/brand/icon-adaptive.png',
      backgroundColor: '#FBF8F4',
    },
    intentFilters: [
      {
        action: 'VIEW',
        autoVerify: true,
        data: [{ scheme: 'https', host: 'bingd.app' }],
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ],
  },

  web: { bundler: 'metro', output: 'server' },

  /**
   * Over-the-air updates, so a fix reaches testers without redistributing a build.
   *
   * The `fingerprint` runtime version policy is the load-bearing part. It derives a
   * hash of everything native in the project, and an update is only offered to
   * builds whose native side matches. So adding a native module and publishing an
   * update means older builds simply do not see it — they stay on the last version
   * that works, instead of downloading JavaScript that calls into a module they do
   * not contain and crashing on launch. That crash is unrecoverable from the user's
   * side and is the single worst failure mode of OTA updates.
   *
   * The cost of that safety is honest: whenever the fingerprint changes, testers
   * need a new build. `eas update` says so rather than leaving it to be discovered.
   */
  updates: {
    url: `https://u.expo.dev/${EAS_PROJECT_ID}`,
    // Start from the cached bundle immediately and fetch in the background. A
    // blocking check costs every user a slow launch on a bad connection to save one
    // relaunch after an update, which is the wrong trade for a film app.
    fallbackToCacheTimeout: 0,
  },
  runtimeVersion: { policy: 'fingerprint' },

  plugins: [
    'expo-router',
    'expo-font',
    'expo-image',
    'expo-localization',
    // Uploads source maps at build time, using SENTRY_AUTH_TOKEN from the EAS
    // secret. Without it a crash report shows minified output instead of a
    // filename and a line number, which is most of the value gone.
    [
      '@sentry/react-native/expo',
      { organization: 'fourward-habits', project: 'bingd-react-native' },
    ],
    'expo-apple-authentication',
    'expo-secure-store',
    'expo-sqlite',
    'expo-sharing',
    'expo-status-bar',
    'expo-web-browser',
    // Sets the Android root view background, so the first frame is Paper rather
    // than white. It is also what makes userInterfaceStyle above mean anything
    // on Android — prebuild says so out loud: "userInterfaceStyle: Install
    // expo-system-ui in your project to enable this feature."
    'expo-system-ui',
    // Configured now that there is an image to configure it with.
    //
    // This entry was omitted for a while, and the reason is worth keeping: the
    // plugin writes `windowSplashScreenAnimatedIcon="@drawable/splashscreen_logo"`
    // into the Android theme whether or not an `image` was given, but only
    // generates that drawable when one was. A colour-only configuration therefore
    // fails the Android build at resource linking with "resource
    // drawable/splashscreen_logo not found", ten minutes in. So `image` is not
    // optional here, and removing it is not a simplification.
    [
      'expo-splash-screen',
      {
        image: './assets/brand/splash.png',
        backgroundColor: '#FBF8F4',
        // The mark is 5:3, so a width in points reads more predictably across
        // devices than `imageWidth` scaled from a square.
        imageWidth: 180,
        // Android 12+ draws the splash icon inside a masked circle regardless,
        // which crops a wide mark. The in-app LoadingScreen is what carries the
        // brand moment; this only has to not flash white.
        resizeMode: 'contain',
      },
    ],
    // Profile pictures, and nothing else. The strings matter: both stores
    // reject a build whose photo-access prompt does not say what the photos are
    // for, and "Allow Bingd to access your photos" is the version that gets
    // rejected. No camera permission is requested — the picker offers the
    // library only, because a profile picture taken on the spot is not a flow
    // anyone asked for and the permission would have to be justified anyway.
    [
      'expo-image-picker',
      {
        photosPermission: 'Bingd uses your photos so you can choose a profile picture.',
        // Drops NSCameraUsageDescription and the Android CAMERA permission
        // outright, rather than shipping a permission the app never asks for
        // and a reviewer has to ask about.
        cameraPermission: false,
      },
    ],
    // Present in all variants from the first build (PRD §15). Delivery is
    // flagged off server-side in production rather than omitted here.
    // Icon and sound assets are added with the brand asset pass (PRD §5).
    ['expo-notifications', { color: '#773744' }],
    [
      'expo-build-properties',
      {
        android: {
          manifestQueries: {
            package: [
              'com.instagram.android',
              'com.facebook.katana',
              'com.zhiliaoapp.musically',
              'com.snapchat.android',
            ],
          },
        },
      },
    ],
  ],

  experiments: { typedRoutes: true, reactCompiler: true },

  extra: {
    eas: { projectId: EAS_PROJECT_ID },

    variant,
    supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
    supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    // Both are publishable by design: a Sentry DSN only accepts events, and a
    // PostHog project token is write-only. Neither reads anything back, which is
    // why they can sit in a client bundle at all.
    sentryDsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
    posthogKey: process.env.EXPO_PUBLIC_POSTHOG_KEY,
    posthogHost: process.env.EXPO_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com',
  },
});
