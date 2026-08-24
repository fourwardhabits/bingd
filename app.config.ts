import type { ConfigContext, ExpoConfig } from 'expo/config';

// Expo resolves this file as CommonJS, and `config/backends.cjs` has to be importable by
// `node --test` as well — which is the whole reason the lane rule lives outside this file.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { assertBackendIsAllowed } = require('./config/backends.cjs');

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
 * Which Supabase project this lane may talk to.
 *
 * The rule and its reasoning live in `config/backends.cjs`, which is a plain CommonJS
 * module for one reason: this file is loaded by Expo's config resolver and cannot be
 * imported by a test, so a rule written here is a rule nothing can exercise. Independent
 * review 28 raised that as a BLOCKER along with the two substantive holes it hid — the
 * check only ran on EAS Build, so an `eas update` could publish a bundle compiled against
 * anything, and the allowlist was global, so the day a production project exists a Beta
 * build could quietly use it.
 *
 * `BINGD_LANE` is set on every profile in `eas.json`, and by `scripts/release.mjs` for
 * `eas update`, which does not read a build profile. Absent — a local `expo start`, a CI
 * config resolution — the **development** lane's backends are accepted: a resolution with
 * no lane is somebody's laptop, and the union of every lane's would hand a bare
 * `eas update` a production ref the day one exists.
 */
const lane = process.env.BINGD_LANE;

assertBackendIsAllowed(process.env.EXPO_PUBLIC_SUPABASE_URL, lane);

/** The brand plum the notification plugin tints an Android notification with. */
const NOTIFICATION_COLOR = '#773744';

/**
 * The push notification declarations, which are native and therefore fingerprint-bearing.
 *
 * **The `require` is inside this function on purpose, and moving it to the top of the
 * file would strand the friend beta.** `@expo/fingerprint` hashes the modules actually
 * loaded while a config resolves — `config/backends.cjs` is in the source list today, and
 * adding a second required file was measured to move all four lanes' hashes, beta
 * included. A lane that never takes the branch never loads the module and never sees it
 * in its hash. `config/push.cjs` records the measurements.
 *
 * The two comparisons below are `declaresPushNatively` restated, and they have to be:
 * answering "does this lane configure push" is what decides whether the module may be
 * loaded at all, so it cannot come from the module. `config/push.test.mjs` asserts the
 * two agree for every lane, which is the seam this arrangement creates.
 *
 * Production **throws** from here when its credential is missing, which is why this
 * resolves once, early, rather than inside the config object below.
 */
function pushNative(): { plugin: { color: string; mode?: string }; googleServicesFile: string | null } {
  const declared =
    lane === 'production' || (lane === 'development' && Boolean(process.env.GOOGLE_SERVICES_JSON));

  if (!declared) {
    // Byte-identical to what every lane produced before push was configured.
    return { plugin: { color: NOTIFICATION_COLOR }, googleServicesFile: null };
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const push = require('./config/push.cjs');
  return {
    plugin: push.notificationPluginProps(lane, { color: NOTIFICATION_COLOR }),
    googleServicesFile: push.googleServicesFileFor(lane),
  };
}

const push = pushNative();

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
    /**
     * FCM, spread rather than assigned, because the key has to be **absent** — not
     * present and undefined — for every lane that does not configure push.
     *
     * `@expo/fingerprint` stringifies the resolved config, and a key whose value is
     * undefined is dropped by `JSON.stringify` anyway; the spread says the intent out
     * loud rather than relying on that. What it protects is the friend beta's runtime
     * version: any movement in the `beta` lane's resolved config strands the published
     * binary on its last update, silently. See `config/push.cjs`.
     */
    ...(push.googleServicesFile ? { googleServicesFile: push.googleServicesFile } : {}),
    // A launcher masks this to its own shape and may crop the outer third of
    // each axis, so the foreground is the mark well inside a Paper field rather
    // than the square icon above.
    adaptiveIcon: {
      foregroundImage: './assets/brand/icon-adaptive.png',
      backgroundColor: '#FBF8F4',
    },
    // Four path prefixes, not the whole host.
    //
    // This used to declare the scheme and the host with no path at all, which
    // claims *every* URL on the domain. That was harmless only for as long as every
    // path either had a screen or was the site root, and it stopped being true the day
    // bingd.app started serving /privacy, /support and /account-deletion — pages the
    // stores require, which Android would then have handed to the app to render as
    // `+not-found`. Apple's file has always claimed only these four; this is the
    // Android half finally saying the same thing.
    //
    // Each entry repeats scheme and host deliberately. Android unions the attributes of
    // the <data> elements inside one intent filter independently, so a bare
    // `{ pathPrefix }` would combine with any scheme and any host in the filter rather
    // than only with this one.
    //
    // Kept in step with `web/deep-links.config.json` by `web/router.test.mjs`, which
    // fails if the two path sets ever diverge.
    intentFilters: [
      {
        action: 'VIEW',
        autoVerify: true,
        data: [
          { scheme: 'https', host: 'bingd.app', pathPrefix: '/u/' },
          { scheme: 'https', host: 'bingd.app', pathPrefix: '/lists/' },
          { scheme: 'https', host: 'bingd.app', pathPrefix: '/title/' },
          { scheme: 'https', host: 'bingd.app', pathPrefix: '/i/' },
        ],
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
    /**
     * Present in all variants from the first build (PRD §15), and until now that was
     * taken to mean push needed no new binary. It did.
     *
     * The plugin defaults `mode` to `'development'` and writes it into
     * `aps-environment`, so every binary this project has ever produced was entitled to
     * the APNs **sandbox** — including the ones bound for the App Store, which would
     * have registered against a service the production sender never talks to. That is a
     * native entitlement and cannot be changed over the air, which is why this lands
     * before the release candidate.
     *
     * `notificationPluginProps` adds `mode` for the production lane and returns exactly
     * `{ color }` for every other, so the beta and preview fingerprints do not move.
     * Icon and sound assets are still deferred to the brand asset pass (PRD §5).
     */
    ['expo-notifications', push.plugin],
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
    /**
     * The release lane, which is not the same question as the variant.
     *
     * `beta` builds the *production* variant — a bundle identifier cannot change between
     * a TestFlight build and the App Store release that replaces it — so `variant` alone
     * cannot tell a friend beta apart from a public release. Everything gated on "is this
     * a build somebody is testing" has to ask this instead, and review 28 was right that
     * gating the diagnostics block on the variant hid the backend from precisely the
     * people running a production-variant binary against a nonproduction database.
     *
     * Undefined outside an EAS build, where there is no lane.
     */
    lane,
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
