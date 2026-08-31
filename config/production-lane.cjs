/**
 * The production lane's extra rules, and the reasons they are not in `backends.cjs`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE FILE AND NOT FOUR LINES IN `backends.cjs`
 *
 * `config/backends.cjs` is a **fingerprint input**. `app.config.ts` requires it, so
 * `@expo/fingerprint` hashes its contents as `expoConfigPlugins`, and any edit to it moves
 * every lane's runtime version — including `beta`, which is the one that must not move.
 * The friend beta runs on a published binary pinned to its fingerprint: shift it and those
 * testers stop receiving over-the-air updates, silently, with a redistribution as the only
 * fix.
 *
 * That is measured rather than assumed. Adding the rule below to `backends.cjs` and
 * fingerprinting a clean worktree either side moved beta from `ab794b37…` to `08e341d1…`.
 *
 * So this file follows `config/push.cjs`'s arrangement exactly, and for exactly its reason:
 * **`app.config.ts` requires it from inside a branch**, and the branch is
 * `lane === 'production'`. A lane that never executes the `require` never loads the module
 * and never enters its hash. Development, preview and beta are byte-identical to before.
 * The production lane's fingerprint moves, and it was already moving — T3's push
 * configuration is production-lane only and is why a release-candidate binary is required
 * at all.
 *
 * ---------------------------------------------------------------------------
 * WHY BETA IS NOT COVERED BY THE SAME RULE, WHICH IS A GAP AND NOT A DECISION ABOUT RISK
 *
 * The check below is exactly as correct for `beta` as it is for `production` — both lanes
 * are installed by other people and neither has any business being built with no backend.
 * Beta is excluded because including it would require beta to load this module, which is
 * the stranding above.
 *
 * The gap it leaves is small and worth stating rather than leaving implied: a beta build
 * whose EAS environment lost `EXPO_PUBLIC_SUPABASE_URL` would compile and fail at startup
 * with `Invalid app configuration` instead of failing the build. The preview environment
 * holds all four variables today, `docs/release/production-environment.md` lists them, and
 * the next beta build is a redistribution anyway — at which point beta belongs in the
 * branch in `app.config.ts` alongside production, and this paragraph comes out.
 */

const { LANE_BACKENDS, REF_NAMES, supabaseProjectRef } = require('./backends.cjs');

/**
 * Which environment each project **says it is**, checked against the database itself.
 *
 * `LANE_BACKENDS` decides which project a lane may compile against, and it can only be as
 * right as the twenty characters somebody typed into it. This decides what that project has
 * to answer to `environment_name()` (`supabase/migrations/20260826000100`), which is a fact
 * about the database rather than about this file — so two refs transposed here stop being
 * invisible and become a `remote-smoke.mjs` failure naming both.
 *
 * Read by `supabase/tests/remote-smoke.mjs`, `supabase/tests/two-user-acceptance.mjs` and
 * `scripts/bootstrap-production.mjs`. None of those is loaded by `app.config.ts`, so none of
 * them costs a fingerprint.
 *
 * **A production project ref is added here, to `LANE_BACKENDS.production` and to
 * `REF_NAMES`, in one change.** `config/production-lane.test.mjs` asserts the three agree,
 * so a ref added to one and forgotten in the others fails a test rather than a release.
 */
const REF_ENVIRONMENTS = {
  abheeqyjzekiowkztfxv: 'prod',
  fjxhcbowoxuzulwirzyr: 'nonprod',
};

/** The production project's ref, or null while there is not one. */
function productionRef() {
  return LANE_BACKENDS.production[0] ?? null;
}

/** What a deployed project must call itself, or null if this project is not one of ours. */
function environmentForRef(ref) {
  return REF_ENVIRONMENTS[ref] ?? null;
}

/**
 * Throws unless a production build is pointed at a real, allowlisted production project.
 *
 * **THE HOLE THIS CLOSES.** `assertBackendIsAllowed` returns early on a URL it cannot parse
 * as a Supabase project — `if (ref === null) return;` — and that early return is deliberate
 * and load-bearing: CI resolves the config against `https://ci.invalid` on purpose, and a
 * local stack is `http://127.0.0.1:54321`. It was also doing something nobody intended.
 * **An absent `EXPO_PUBLIC_SUPABASE_URL` is not a Supabase URL either**, so a production
 * build with no Supabase variables at all passed the guard completely.
 *
 * That is not hypothetical. The production EAS environment holds **zero** variables today.
 * The one lane that must never be wrong about its database was the one lane the guard said
 * nothing about, and the failure would have surfaced as `Invalid app configuration` on a
 * phone, after a signed store build and a submission.
 *
 * It does not fall back to nonprod — `LANE_BACKENDS.production` is empty and grants nothing
 * — so the failure mode being fixed is a broken binary rather than a leaked database. It is
 * still a binary that should never have been produced.
 */
function assertProductionBackend(url, anonKey) {
  const ref = supabaseProjectRef(url);

  /**
   * **The anon key too, and leaving it out was the same bug one field along.**
   *
   * A URL with no key is a build that resolves, signs, submits and then throws
   * `Invalid app configuration` from `src/lib/env.ts` on somebody's phone — which is exactly
   * the failure the URL check exists to prevent. The two variables are set in the same
   * dashboard, in the same sitting, and are forgotten the same way.
   *
   * Not validated beyond being present. Whether a key is *the right project's* key is not
   * answerable here — it is an opaque string, and `remote-smoke.mjs` asking the database
   * what it calls itself is what actually checks that.
   */
  if (typeof anonKey !== 'string' || anonKey.trim() === '') {
    throw new Error(
      'The production lane must be built with EXPO_PUBLIC_SUPABASE_ANON_KEY set, and it is ' +
        'not.\n\n' +
        '  eas env:create --environment production --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value <key>\n\n' +
        '  Without it the build succeeds and the installed app throws "Invalid app\n' +
        '  configuration" at startup. docs/release/production-environment.md lists every\n' +
        '  variable a production build needs.',
    );
  }

  if (ref === null) {
    throw new Error(
      'The production lane must be built against a Supabase project, and ' +
        `EXPO_PUBLIC_SUPABASE_URL is ${
          url === undefined || url === '' ? 'not set' : `"${url}", which is not one`
        }.\n\n` +
        '  The production EAS environment is where this comes from:\n' +
        '    eas env:list production\n' +
        '    eas env:create --environment production --name EXPO_PUBLIC_SUPABASE_URL --value https://<ref>.supabase.co\n\n' +
        '  docs/release/production-environment.md lists every variable a production build\n' +
        '  needs. This refuses here rather than letting a signed store build fail as\n' +
        '  "Invalid app configuration" on somebody\'s phone.',
    );
  }

  if (!LANE_BACKENDS.production.includes(ref)) {
    const name = REF_NAMES[ref] ? `${ref} (${REF_NAMES[ref]})` : ref;
    throw new Error(
      `The production lane may not build against ${name}. Permitted: ${
        LANE_BACKENDS.production.length
          ? LANE_BACKENDS.production.map((r) => (REF_NAMES[r] ? `${r} (${REF_NAMES[r]})` : r)).join(', ')
          : 'nothing — there is no production Supabase project yet, and until there is, ' +
            'no production binary should exist. See docs/release/production-bootstrap.md.'
      }.`,
    );
  }
}

module.exports = {
  REF_ENVIRONMENTS,
  productionRef,
  environmentForRef,
  assertProductionBackend,
};
