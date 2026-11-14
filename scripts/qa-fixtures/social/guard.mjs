/**
 * The target guard for the social QA fixture. It runs FIRST, before any key is read.
 *
 * The fixture creates accounts with the service-role key and writes as those accounts, so
 * the one thing that must never happen is that key being sent to production, or to a host
 * that merely looks like staging. The rules, none of which any flag overrides:
 *
 *   1. The URL is parsed with `new URL()`. A string check (`url.includes(ref)`) says yes to
 *      `https://fjxhcbowoxuzulwirzyr.supabase.co.evil.example`, which anybody can register.
 *   2. Production (`abheeqyjzekiowkztfxv`) is refused by name, over any scheme or port.
 *   3. Staging is accepted only as exactly `https://fjxhcbowoxuzulwirzyr.supabase.co`
 *      (default port, no userinfo).
 *   4. A local stack is accepted only as `http://127.0.0.1:<port>` or `http://localhost:<port>`.
 *   5. Everything else is refused, including unknown Supabase refs.
 *   6. Then the database is asked `environment_name()`. `prod` is refused whatever the URL
 *      said; staging and a local stack must both answer `nonprod` (a local stack answers
 *      `nonprod` by default, `20260826000100`).
 *
 * Copied in spirit, not imported, from `supabase/tests/two-user-acceptance.mjs` and
 * `social-activation.mjs`: those files explain why a shared guard is a guard somebody can
 * loosen for another caller. The refs themselves come from `config/backends.cjs` and are
 * cross-checked against `config/production-lane.cjs`, so a transposed ref fails here.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PRODUCTION_REF, STAGING_REF } = require('../../../config/backends.cjs');
const { environmentForRef } = require('../../../config/production-lane.cjs');

export const STAGING_HOST = `${STAGING_REF}.supabase.co`;
export const PRODUCTION_HOST = `${PRODUCTION_REF}.supabase.co`;
export const LOCAL_HOSTS = Object.freeze(['127.0.0.1', 'localhost']);

export class GuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GuardError';
  }
}

/**
 * The declared environments have to agree with what this guard believes, or nothing runs.
 * Asserted every call rather than at import, so a test can see the failure as a GuardError.
 */
function assertDeclarations() {
  if (environmentForRef(PRODUCTION_REF) !== 'prod') {
    throw new GuardError(
      `config/production-lane.cjs does not declare ${PRODUCTION_REF} prod; refusing to guess.`,
    );
  }
  if (environmentForRef(STAGING_REF) !== 'nonprod') {
    throw new GuardError(
      `config/production-lane.cjs does not declare ${STAGING_REF} nonprod; refusing to guess.`,
    );
  }
}

/**
 * Classifies a Supabase URL without touching the network or any key.
 *
 * @param {unknown} rawUrl
 * @returns {{ kind: 'staging' | 'local', ref: string, origin: string, host: string }}
 */
export function classifyTarget(rawUrl) {
  assertDeclarations();

  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw new GuardError('No Supabase URL. Set EXPO_PUBLIC_SUPABASE_URL (or SUPABASE_URL).');
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new GuardError('The Supabase URL does not parse as a URL; refusing.');
  }

  const hostname = parsed.hostname.toLowerCase();

  // Production first and by name, whatever the scheme, port or path. There is no flag
  // that reaches past this line.
  if (
    hostname === PRODUCTION_HOST ||
    hostname === `${PRODUCTION_HOST}.` ||
    hostname.split('.')[0] === PRODUCTION_REF
  ) {
    throw new GuardError(
      `Refusing: ${PRODUCTION_REF} is PRODUCTION. The social QA fixture never runs against production.`,
    );
  }

  if (parsed.username || parsed.password) {
    throw new GuardError('Refusing: the URL carries userinfo, which no Supabase URL needs.');
  }

  if (parsed.protocol === 'https:' && hostname === STAGING_HOST && parsed.port === '') {
    return { kind: 'staging', ref: STAGING_REF, origin: parsed.origin, host: hostname };
  }

  if (parsed.protocol === 'http:' && LOCAL_HOSTS.includes(hostname)) {
    return { kind: 'local', ref: 'local', origin: parsed.origin, host: hostname };
  }

  throw new GuardError(
    `Refusing: ${parsed.protocol}//${hostname}${parsed.port ? `:${parsed.port}` : ''} is neither ` +
      `https://${STAGING_HOST} (staging) nor a local stack on http://127.0.0.1 or http://localhost.`,
  );
}

/**
 * The database's own answer, checked against the classified target.
 *
 * @param {{ kind: string, ref: string }} target
 * @param {unknown} answered what `environment_name()` returned
 */
export function assertEnvironmentAnswer(target, answered) {
  if (answered === 'prod') {
    throw new GuardError(
      `Refusing: ${target.ref} answers environment_name() = 'prod'. The fixture never writes to a ` +
        'database that calls itself production, whatever its URL says.',
    );
  }
  if (answered !== 'nonprod') {
    throw new GuardError(
      `Refusing: ${target.ref} answers environment_name() = ${JSON.stringify(answered)}; ` +
        `the ${target.kind} target must answer 'nonprod'.`,
    );
  }
}

/**
 * The whole guard: classify the URL (no key needed), then ask the database what it is.
 *
 * `askEnvironment` is called only after the URL has been accepted, with the classified
 * target, and is the first thing that may read the anon key. The service-role key and the
 * fixture password are read by the caller only after this resolves.
 *
 * @param {string} rawUrl
 * @param {(target: ReturnType<typeof classifyTarget>) => Promise<unknown>} askEnvironment
 */
export async function guardTarget(rawUrl, askEnvironment) {
  const target = classifyTarget(rawUrl);
  let answered;
  try {
    answered = await askEnvironment(target);
  } catch (cause) {
    throw new GuardError(
      `Refusing: could not ask ${target.ref} environment_name() (${cause?.message ?? cause}).`,
    );
  }
  assertEnvironmentAnswer(target, answered);
  return { ...target, environment: answered };
}
