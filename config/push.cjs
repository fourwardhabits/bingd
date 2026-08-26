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
  // Beta joins production because both are store-distributed. See apnsEnvironmentFor.
  if (lane === 'production' || lane === 'beta') return true;
  // Development opts in, and opting in is explicit. See googleServicesFileFor.
  if (lane === 'development') return Boolean(env[GOOGLE_SERVICES_ENV]);
  return false;
}

/**
 * The APNs environment a lane's binary should be entitled to, or null to leave the
 * plugin's own default in place.
 *
 * `production` and `beta` are named. The other two keep `aps-environment: development`,
 * which is not a compromise — it is correct for them:
 *
 *   - a **development** or **preview** build is signed for internal distribution and
 *     talks to the APNs sandbox, which is exactly what `development` means. One APNs
 *     `.p8` auth key serves both environments, so iOS push can be exercised end to end on
 *     a development build with no native change at all;
 *   - **beta** is store-distributed. A TestFlight build is signed with an App Store
 *     distribution profile and its notifications come from the **production** APNs
 *     environment, so a beta binary entitled to the sandbox registers against a service
 *     nothing will ever send to. It receives no notification and reports no error.
 *
 * **Beta was deliberately left on the sandbox until now, and the reason it changes here is
 * the reason it was left.** The argument recorded against configuring it was that the
 * published beta binary had no push credentials, no client asking for permission and no
 * token writer, so entitling it would buy nothing and cost the fingerprint that keeps
 * every tester on over-the-air updates — and that the next beta build should take
 * `production` with it, as a founder decision with a redistribution attached.
 *
 * All three of those premises have since gone the other way. The client asks for
 * permission (`src/features/notifications/push-permission.ts`), writes tokens
 * (`push.ts`), and the sender and its scheduler are deployed. `device_tokens` is
 * nevertheless **empty**, because no binary in anybody's hands can register — which is
 * that argument's own prediction, observed. The redistribution is the decision being
 * taken: this lands with a new TestFlight build and a new closed-test build, not as an
 * over-the-air update, because an entitlement cannot ship over the air.
 *
 * `expo-application`'s `getIosPushNotificationServiceEnvironmentAsync()` reads this same
 * entitlement at runtime, and `getExpoPushTokenAsync` defaults its `development` flag from
 * it — so the token the client acquires follows this value automatically and there is no
 * second place to keep in step.
 */
function apnsEnvironmentFor(lane) {
  return lane === 'production' || lane === 'beta' ? 'production' : null;
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
 * **Beta requires it, on the same terms as production and for the same reason.** A
 * TestFlight or closed-test binary with no FCM configuration installs, signs in, asks for
 * notification permission, is granted it, and then cannot obtain a token at all — the
 * exact state `device_tokens` is in today. The beta profile in `eas.json` names the
 * `preview` EAS environment, so the file secret has to exist **there**, not under
 * `production`.
 *
 * **The local fallback matters more for beta than for production, and it is a trap worth
 * naming.** `eas update --branch beta` resolves this config on the founder's own machine
 * (`scripts/release.mjs` supplies `BINGD_LANE=beta` for updates as well as builds), and
 * `@expo/fingerprint` hashes the file's *contents*. So a laptop holding a **different**
 * `google-services.json` than the build machine publishes an update under a runtime
 * version no binary has, which is silent: the update succeeds and reaches nobody. The
 * file on disk must be byte-for-byte the one in the EAS secret. Absent entirely, this
 * throws rather than resolving to `null` — resolving to `null` is the same silent
 * mismatch with nothing to read.
 *
 * **Preview never takes it**, and that is now the load-bearing exclusion rather than a
 * pair of them: preview shares the `preview` EAS environment with beta, so
 * `GOOGLE_SERVICES_JSON` is present in its build environment and only the lane gate keeps
 * it out. Preview is internally distributed and belongs on the sandbox.
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
  if (lane !== 'production' && lane !== 'beta') return null;

  if (fromSecret) return fromSecret;

  // The local fallback, for a founder building production from their own machine.
  // Git-ignored — `.gitignore` names `google-services.json` — so this is never a
  // committed credential.
  if (exists(isAbsolute(GOOGLE_SERVICES_LOCAL)
    ? GOOGLE_SERVICES_LOCAL
    : resolve(projectRoot, GOOGLE_SERVICES_LOCAL))) {
    return GOOGLE_SERVICES_LOCAL;
  }

  // The EAS *environment* a lane's build profile names, which is not the lane's own name
  // for beta — `eas.json` points the beta profile at `preview`. Naming the wrong one here
  // sends somebody to create a secret the build will not see.
  const environment = lane === 'beta' ? 'preview' : 'production';

  throw new Error(
    `A ${lane} build needs Android push configuration and there is none.\n` +
      '\n' +
      'Supply google-services.json one of two ways:\n' +
      '\n' +
      '  · as an EAS file secret, which is how a build machine should get it:\n' +
      '      npx eas env:create --scope project --name GOOGLE_SERVICES_JSON \\\n' +
      `        --type file --value ./google-services.json --environment ${environment}\n` +
      '\n' +
      '  · or as ./google-services.json in the project root, for a local build and for\n' +
      `    \`npm run update:${lane}\`, which resolves this config on your own machine.\n` +
      '    It is git-ignored and must stay that way, and it must be byte-for-byte the\n' +
      '    file in the EAS secret — @expo/fingerprint hashes its contents, so a\n' +
      '    different copy publishes an update under a runtime version no binary has.\n' +
      '\n' +
      'Download it from the Firebase console for the Android app app.bingd.\n' +
      'The whole credential checklist is in supabase/functions/push-sender/README.md.\n' +
      '\n' +
      `This refuses rather than building, because a ${lane} binary with no FCM\n` +
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
