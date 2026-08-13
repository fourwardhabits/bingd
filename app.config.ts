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
  backgroundColor: '#F5EBDD',

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
    ['expo-splash-screen', { backgroundColor: '#F5EBDD' }],
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
