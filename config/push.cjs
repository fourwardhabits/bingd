/**
 * What each release lane declares about push notifications, natively.
 *
 * A plain CommonJS module for the reason `config/backends.cjs` records: `app.config.ts`
 * is loaded by Expo's own config resolver and cannot be imported by a test, so a rule
 * written inside it is a rule nothing can exercise. Independent review 28 raised that as
 * a BLOCKER against the backend allowlist, and this rule decides something with the same
 * shape of failure — a production binary that installs, signs in, and silently cannot
 * receive a notification.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS ACTUALLY WRONG, VERIFIED AGAINST THE INSTALLED PLUGIN
 *
 * `expo-notifications` and its config plugin have been in every build since the first one
 * (PRD §15, AD-10), and `deferred-roadmap.md` §4 concluded from that that **no new native
 * binary would be needed** to turn push on. That conclusion is false, and the proof is
 * six lines of the installed plugin (`expo-notifications@57.0.10`,
 * `plugin/build/withNotificationsIOS.js`):
 *
 *     const withNotificationsIOS = (config, { mode = 'development', ... }) => {
 *       config = withEntitlementsPlist(config, (config) => {
 *         if (!config.modResults['aps-environment']) {
 *           config.modResults['aps-environment'] = mode;
 *         }
 *         ...
 *
 * The plugin entry in `app.config.ts` passes only `{ color }`, so **every binary this
 * project has ever produced carries `aps-environment: development`** — the APNs
 * *sandbox*. A production binary with that entitlement registers against the sandbox and
 * never receives a notification sent to the production APNs environment.
 *
 * The Android half is the same conclusion by a different route: FCM needs
 * `google-services.json` compiled into the binary, and `android.googleServicesFile` is
 * declared nowhere.
 *
 * Both are *native* inputs. Neither can be changed over the air. So push does gate a new
 * native build, and that is why this configuration lands before the release candidate
 * rather than after it.
 *
 * ---------------------------------------------------------------------------
 * THE FINGERPRINT, AND WHY THIS FILE IS REQUIRED LAZILY
 *
 * The friend beta is running on a published binary whose runtime version is a
 * **fingerprint** (`app.config.ts`, `updates`). An update is offered only to builds whose
 * native fingerprint matches, so any movement in the `beta` lane's fingerprint strands
 * that binary: it stops seeing updates entirely, silently, and the only fix is
 * redistributing a build.
 *
 * Two measured facts shape everything below. Both were checked with
 * `@expo/fingerprint@0.20.7` against this project rather than assumed:
 *
 *   1. **The source of `app.config.ts` is not hashed** — appending a comment to it moves
 *      no hash. What is hashed is the *resolved* config, so a value produced for one lane
 *      only is invisible to the others.
 *
 *   2. **A module `app.config.ts` requires *is* hashed.** `config/backends.cjs` appears
 *      in the source list as `expoConfigPlugins`, and adding a second required file moved
 *      all four lanes' fingerprints, beta included. The list comes from the modules
 *      actually loaded while the config resolves — so a `require` that a lane never
 *      executes never enters that lane's hash.
 *
 * Hence `app.config.ts` requires this file from **inside a branch** rather than at the
 * top. That is not a style choice and it is not an optimisation: moving it to the top
 * would strand the friend beta while changing nothing whatsoever about the beta binary.
 *
 * The same fact has a consequence for the API here. For a lane that is not configured
 * these functions return **null meaning "write no key at all"**, never `'development'`
 * meaning "write the plugin's default out loud". Those two produce identical binaries and
 * different fingerprints.
 */

const { existsSync } = require('node:fs');
const { isAbsolute, resolve } = require('node:path');

/** The lanes, in the order `eas.json` declares them. */
const LANES = ['development', 'preview', 'beta', 'production'];

/** The env var EAS exports when the project holds a file-typed secret of this name. */
const GOOGLE_SERVICES_ENV = 'GOOGLE_SERVICES_JSON';

/** The git-ignored path a founder building locally can drop the file at. */
const GOOGLE_SERVICES_LOCAL = './google-services.json';

/**
 * Whether a lane resolves any push-specific native configuration at all.
 *
 * This is the predicate `app.config.ts` guards its `require` with, and it is exported so
 * the guard is stated once rather than duplicated in a file no test can import. It has to
 * be answerable **without** loading this module, which is why `app.config.ts` repeats the
 * two comparisons inline — and why `push.test.mjs` asserts that the two agree.
 *
 * `lane` is `BINGD_LANE`, so it is undefined outside an EAS build. A resolution with no
 * lane is somebody's laptop and declares nothing: it must never demand a credential, and
 * `expo start` must keep working on a machine that has never seen Firebase.
 */
function declaresPushNatively(lane, env = process.env) {
  if (lane === 'production') return true;
  // Development opts in, and opting in is explicit. See googleServicesFileFor.
  if (lane === 'development') return Boolean(env[GOOGLE_SERVICES_ENV]);
  return false;
}

/**
 * The APNs environment a lane's binary should be entitled to, or null to leave the
 * plugin's own default in place.
 *
 * Only `production` is named. The other three keep `aps-environment: development`, which
 * is not a compromise — it is correct for them:
 *
 *   - a **development** or **preview** build is signed for internal distribution and
 *     talks to the APNs sandbox, which is exactly what `development` means. One APNs
 *     `.p8` auth key serves both environments, so iOS push can be exercised end to end on
 *     a development build with no native change at all;
 *   - **beta** is the interesting one, and it is left alone deliberately rather than by
 *     oversight. It is store-distributed (TestFlight), so its binary *should* eventually
 *     carry `production` — but the beta binary that exists today has no push credentials,
 *     no client that asks for permission and no token writer, so configuring it would buy
 *     nothing and cost the fingerprint that keeps every tester on over-the-air updates.
 *     The next beta build, if there is one, should take `production` with it. That is a
 *     founder decision with a redistribution attached, not a line to slip in here.
 *
 * `expo-application`'s `getIosPushNotificationServiceEnvironmentAsync()` reads this same
 * entitlement at runtime, and `getExpoPushTokenAsync` defaults its `development` flag from
 * it — so the token the client acquires follows this value automatically and there is no
 * second place to keep in step.
 */
function apnsEnvironmentFor(lane) {
  return lane === 'production' ? 'production' : null;
}

/**
 * The `google-services.json` a lane's binary should compile in, or null for none.
 *
 * **Production requires it and says so.** A production build with no FCM configuration
 * reaches the Play Store unable to receive a notification, and nothing about it looks
 * wrong — which is the failure mode this project's config rules exist to refuse. So the
 * production lane throws rather than resolving to nothing, and the message names both
 * ways to supply the file.
 *
 * **Development may opt in through the environment, and defaults to not.** This is the
 * one place the rule is wider than "production only", and the reason is the release
 * candidate. Android push cannot be exercised at all without this file in *some* binary,
 * and a first exercise that happens inside the RC is an RC nobody can trust. Setting
 * `GOOGLE_SERVICES_JSON` before `eas build --profile development` is enough to prove the
 * Android path end to end; setting nothing — which is what every existing command does —
 * resolves to exactly the configuration that shipped before this module existed.
 *
 * Development deliberately does **not** fall back to the file on disk. An opt-in that
 * triggers on a file somebody happened to download is not an opt-in, and the lane's
 * fingerprint would then depend on the contents of a directory rather than on a decision.
 *
 * **Preview and beta never take it.** Those are the two lanes with binaries in other
 * people's hands.
 *
 * `env` and `exists` are injected so the rule is testable without a filesystem. The
 * defaults are the real ones.
 */
function googleServicesFileFor(
  lane,
  // `process.cwd()` rather than a path derived from this file. Expo resolves the config
  // with the project root as the working directory — `eas build`, `eas update` and
  // `expo config` all do — and the relative path this returns is resolved by Expo the
  // same way, so the two agree by construction. Injected so a test does not depend on
  // either.
  { env = process.env, exists = existsSync, projectRoot = process.cwd() } = {},
) {
  // The path EAS exports for a file-typed secret. It is absolute and outside the project
  // on a build machine, which @expo/fingerprint handles: it hashes the file's *contents*
  // as an external source and deletes the path from the config before hashing that,
  // precisely so a build-machine path cannot move the runtime version.
  const fromSecret = env[GOOGLE_SERVICES_ENV];

  if (lane === 'development') return fromSecret || null;
  if (lane !== 'production') return null;

  if (fromSecret) return fromSecret;

  // The local fallback, for a founder building production from their own machine.
  // Git-ignored — `.gitignore` names `google-services.json` — so this is never a
  // committed credential.
  if (exists(isAbsolute(GOOGLE_SERVICES_LOCAL)
    ? GOOGLE_SERVICES_LOCAL
    : resolve(projectRoot, GOOGLE_SERVICES_LOCAL))) {
    return GOOGLE_SERVICES_LOCAL;
  }

  throw new Error(
    'A production build needs Android push configuration and there is none.\n' +
      '\n' +
      'Supply google-services.json one of two ways:\n' +
      '\n' +
      '  · as an EAS file secret, which is how a build machine should get it:\n' +
      '      npx eas env:create --scope project --name GOOGLE_SERVICES_JSON \\\n' +
      '        --type file --value ./google-services.json --environment production\n' +
      '\n' +
      '  · or as ./google-services.json in the project root, for a local build.\n' +
      '    It is git-ignored and must stay that way.\n' +
      '\n' +
      'Download it from the Firebase console for the Android app app.bingd.\n' +
      'The whole credential checklist is in supabase/functions/push-sender/README.md.\n' +
      '\n' +
      'This refuses rather than building, because a production binary with no FCM\n' +
      'configuration installs, signs in and silently cannot receive a notification —\n' +
      'and fixing that costs another store submission.',
  );
}

/**
 * The plugin props for `expo-notifications`, assembled so an unconfigured lane produces
 * the object it produced before this module existed.
 *
 * `color` is the brand plum and is unconditional: it has been in every build, and
 * dropping it for one lane would move that lane's fingerprint for no reason.
 */
function notificationPluginProps(lane, { color }) {
  const mode = apnsEnvironmentFor(lane);
  return mode ? { color, mode } : { color };
}

module.exports = {
  LANES,
  GOOGLE_SERVICES_ENV,
  GOOGLE_SERVICES_LOCAL,
  declaresPushNatively,
  apnsEnvironmentFor,
  googleServicesFileFor,
  notificationPluginProps,
};
