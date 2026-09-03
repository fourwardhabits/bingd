/**
 * Which Supabase project each release lane is allowed to talk to.
 *
 * A plain CommonJS module, and the format is the point: `app.config.ts` is loaded by
 * Expo's own resolver and can `require` this, while `node --test` can import it
 * directly. The alternative — the logic living inside `app.config.ts` — is what
 * independent review 28 called out, because a rule that only executes inside a config
 * resolver is a rule nothing can test.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PREVENTS, AND WHY IT IS NOT A STYLE PREFERENCE
 *
 * The Supabase URL is an EAS environment variable — a value in a web dashboard, edited
 * by hand — and it is compiled into the JavaScript bundle. A build or an update pointed
 * at the wrong project **does not crash, does not warn, and does not look different**.
 * It signs in and shows an empty collection, and every acceptance result taken on it is
 * about a database nobody meant to test.
 *
 * Review 28 raised two BLOCKERs against an earlier version of this that lived in
 * `app.config.ts` and both are fixed here:
 *
 *   1. **It only ran on EAS Build.** `eas update` resolves the config on the developer's
 *      own machine, so an update could be compiled against whatever was in a local
 *      `.env` and published to any channel. The `EAS_BUILD` gate is gone: the rule now
 *      fires wherever the config is resolved, which is the only place that covers both.
 *
 *   2. **The allowlist was global.** One flat set of refs meant that the day a
 *      production project is added, a Beta build pointed at production — or a Production
 *      build pointed at nonprod — would pass. The mapping is per lane now, so adding a
 *      production ref grants it to the production lane and to nothing else.
 * ---------------------------------------------------------------------------
 */

/**
 * The two projects, named once.
 *
 * Every other file that needs to say "staging" says `STAGING_REF` rather than reaching
 * for `LANE_BACKENDS.beta[0]`, which is how several tests and one CI step came to mean
 * "staging" by pointing at a lane that no longer uses it. A ref is twenty characters of
 * nothing; the names are the readable half.
 */
const PRODUCTION_REF = 'abheeqyjzekiowkztfxv';
const STAGING_REF = 'fjxhcbowoxuzulwirzyr';

/**
 * Lane → the project refs that lane may use.
 *
 * ---------------------------------------------------------------------------
 * BETA POINTS AT PRODUCTION, ON PURPOSE, SINCE 2026-09-03
 * ---------------------------------------------------------------------------
 *
 * This is the line most likely to look like a mistake, so here is why it is not.
 *
 * **The closed testers are already there.** The Android closed test and the production
 * app are the same `app.bingd` package by design, and the binary those testers installed
 * was built before 2026-08-31, when `abheeqyjzekiowkztfxv` was the friend-beta backend.
 * That project was then promoted in place and became production, with every account,
 * ranking and collection row still in it. So the closed test has been running against
 * what is now the production database for as long as production has existed, and
 * `release-lanes.md` already recorded that as deliberate.
 *
 * Pointing a *new* beta build at staging would therefore not keep testers where they
 * are. It would move them, to an empty database, and the move has no symptom: they sign
 * in, and their collection is gone.
 *
 * **Staging is also not ready to receive them.** It stands at 53 of 103 migrations, and
 * `award_unlocks` and `invite_link_opens` do not exist in it yet. Awards and the
 * invitation funnel would fail against it.
 *
 * **What this does not mean.** Staging is not redefined as production, and the two refs
 * are still distinct everywhere. `development` and `preview` still use staging, which is
 * what makes staging worth repairing. `assertProductionBackend` in `production-lane.cjs`
 * is untouched and still refuses a production build pointed anywhere but production.
 *
 * **How beta goes back to staging**, when it should: staging reaches 103/103, its smoke
 * tests pass, and the founder says so. Then this line changes back to `STAGING_REF` and
 * `beta.environment` in `eas.json` changes back to `preview` in the same commit. The test
 * in `backends.test.mjs` that pins this pair is the thing that will fail if only one of
 * them is edited.
 */
const LANE_BACKENDS = {
  development: [STAGING_REF],
  preview: [STAGING_REF],
  beta: [PRODUCTION_REF],
  production: [PRODUCTION_REF],
};

/** Human names, for the error message. A ref is 20 characters of nothing. */
const REF_NAMES = {
  [PRODUCTION_REF]: 'bingd-production',
  [STAGING_REF]: 'bingd-staging',
};

/**
 * The project ref in a Supabase URL, or null if this is not one.
 *
 * Parsed rather than pattern-matched. A regex over a URL string is the shape of check
 * that says yes to `https://evil.example/?x=abheeqyjzekiowkztfxv.supabase.co`, and this
 * one decides which database a shipped binary talks to.
 */
function supabaseProjectRef(url) {
  if (typeof url !== 'string' || url.length === 0) return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:') return null;
  // Userinfo cannot be used to smuggle a hostname past this: `new URL` puts it in
  // `username`/`password` and `hostname` is the real host either way. Asserted in the
  // tests rather than trusted.
  if (parsed.username || parsed.password) return null;

  const suffix = '.supabase.co';
  const host = parsed.hostname.toLowerCase();
  if (!host.endsWith(suffix)) return null;

  const ref = host.slice(0, -suffix.length);
  if (ref.length === 0 || ref.includes('.')) return null;
  return ref;
}

/**
 * THERE IS NO ESCAPE HATCH, AND THERE USED TO BE.
 *
 * `BINGD_ALLOW_UNLISTED_BACKEND=yes-i-am-testing-locally` existed for one round, refused
 * only when `EAS_BUILD=true`, and was meant for a contributor running against their own
 * Supabase project. Independent review 28b found the hole, and it is worth recording
 * rather than quietly deleting: **`eas update` does not set `EAS_BUILD`.** It resolves the
 * config on a laptop and compiles the URL into the bundle it publishes, so the one
 * variable that was supposed to close the hatch for shipped artifacts was never set on the
 * path that ships them. The hatch could publish an unlisted backend to the Beta channel.
 *
 * It is gone rather than narrowed. It existed for a contributor this project does not
 * have, and anybody who genuinely needs another project adds its ref to the development
 * lane above — a line in a diff somebody reads, and about as much work.
 */

/**
 * Throws unless this configuration is allowed to talk to this backend.
 *
 * `lane` comes from `BINGD_LANE`. Every profile in `eas.json` sets it, and
 * `scripts/release.mjs` sets it for `eas update` too — which does **not** read a build
 * profile's `env`, the second half of the same review-28b finding and the reason those npm
 * scripts exist rather than a documented `eas` invocation.
 *
 * **An undeclared lane gets the development lane's permissions, not the union of every
 * lane's.** A resolution with no lane is somebody's laptop. The union was the earlier
 * behaviour and it is a trap that springs later: the day a production ref is added, a
 * lane-less resolution could compile production credentials and publish them anywhere.
 *
 * A URL that is not a Supabase URL at all passes: `https://ci.invalid` is what CI uses on
 * purpose, and a local stack on `http://127.0.0.1:54321` is not a Bingd project by any
 * reading. `src/lib/env.ts` refuses an unusable one at startup, loudly, which is the check
 * that belongs there rather than here.
 */
function assertBackendIsAllowed(url, lane) {
  const ref = supabaseProjectRef(url);
  if (ref === null) return;

  if (lane !== undefined && LANE_BACKENDS[lane] === undefined) {
    throw new Error(
      `BINGD_LANE is "${lane}", which is not a Bingd release lane. Expected one of: ` +
        `${Object.keys(LANE_BACKENDS).join(', ')}. It is set per profile in eas.json.`,
    );
  }

  const allowed = lane ? LANE_BACKENDS[lane] : LANE_BACKENDS.development;
  if (allowed.includes(ref)) return;

  const name = (r) => (REF_NAMES[r] ? `${r} (${REF_NAMES[r]})` : r);
  const permitted = allowed.length
    ? allowed.map(name).join(', ')
    : 'nothing — this lane has no backend yet';

  throw new Error(
    `EXPO_PUBLIC_SUPABASE_URL resolves to the Supabase project ${name(ref)}, which the ` +
      `${lane ? `"${lane}" lane` : 'undeclared lane, which gets development permissions,'} ` +
      `may not use. Permitted: ${permitted}. Check the EAS environment this build profile ` +
      'names, or add the project to the right lane in config/backends.cjs if it is ' +
      'genuinely intended. Publish with `npm run update:preview` or `npm run update:beta` ' +
      'rather than `eas update` directly — those set the lane, and a bare `eas update` ' +
      'cannot.',
  );
}

module.exports = {
  PRODUCTION_REF,
  STAGING_REF,
  LANE_BACKENDS,
  REF_NAMES,
  supabaseProjectRef,
  assertBackendIsAllowed,
};
