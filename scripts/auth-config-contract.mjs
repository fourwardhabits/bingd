/**
 * What `supabase/auth-templates/templates.json` says, split into the two things it is.
 *
 * `scripts/check-auth-config.mjs` reads a live project and compares; this module is the
 * comparison, with no network and no credential, so `config/auth-templates.test.mjs` can
 * run it in CI against a hand-built "live" response.
 *
 * **Two kinds of key, and only one of them is ever written.**
 *
 * - *Canonical settings* — `settings` plus each template's subject and body. The repo is
 *   their source of truth, and `--apply` PATCHes whichever of them differ.
 * - *Limits* — `limits`. The dashboard is their source of truth: an abuse or capacity
 *   control the founder sets there. The repo records the value the client was built
 *   against, and the check fails when the two disagree. It never writes one, because a
 *   repair script that put a limit back would silently undo a deliberate raise.
 */

/** Every key `--apply` may write, with its canonical value. */
export function canonicalSettings(manifest, readBody) {
  const wanted = new Map();
  for (const [key, value] of Object.entries(manifest.settings)) {
    if (key !== '//') wanted.set(key, value);
  }
  for (const entry of manifest.templates) {
    wanted.set(entry.subjectKey, entry.subject);
    wanted.set(entry.bodyKey, readBody(entry));
  }
  for (const key of limitsOf(manifest).keys()) {
    // A key in both lists would be written by `--apply`, which is what `limits` exists
    // to prevent. Refuse the manifest rather than pick one.
    if (wanted.has(key))
      throw new Error(`templates.json names ${key} as both a setting and a limit`);
  }
  return wanted;
}

/** Every recorded limit: `{ value, unit, clientDependsOn, onDrift }` by Management API key. */
export function limitsOf(manifest) {
  const limits = new Map();
  for (const [key, entry] of Object.entries(manifest.limits ?? {})) {
    if (key !== '//') limits.set(key, entry);
  }
  return limits;
}

/**
 * The limits a live `/v1/projects/{ref}/config/auth` response disagrees with.
 *
 * Absent or `null` counts as drift, not as agreement. The Management API returns `null`
 * for a field it has no value for, and "we could not read it" must not print as "ok".
 */
export function limitDrift(manifest, live) {
  const drift = [];
  for (const [key, entry] of limitsOf(manifest)) {
    const actual = live?.[key];
    if (actual !== entry.value)
      drift.push({ key, expected: entry.value, actual: actual ?? null, ...entry });
  }
  return drift;
}

/** The lines the check prints for one drifted limit. */
export function describeLimitDrift({ key, expected, actual, unit, clientDependsOn, onDrift }) {
  return [
    `  DRIFT  ${key}`,
    `        recorded: ${JSON.stringify(expected)} (${unit})`,
    `        deployed: ${JSON.stringify(actual)}`,
    `        client:   ${clientDependsOn}`,
    `        effect:   ${onDrift}`,
  ].join('\n');
}
