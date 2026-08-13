/**
 * Smoke test against a deployed Supabase project, from an unauthenticated
 * client's position.
 *
 * Why this exists alongside the local suite. The local tests run migrations in
 * PGlite, which is Postgres compiled to WebAssembly — close, but not the thing
 * we ship on. It has no `citext`, so the harness shims it as plain `text`, and it
 * knows nothing about PostgREST, which is the surface an attacker actually
 * reaches. A grant revoked in a migration and a grant revoked on the running
 * database are different claims, and only one of them matters.
 *
 * Two rules this file learned the hard way, on its first run.
 *
 * **Probe with real arguments.** PostgREST answers an argument mismatch with 404,
 * so calling every function with `{}` produces a page of passes that would pass
 * just as well against a wide-open database. The one finding of that first run
 * came from `my_capabilities()`, which takes no arguments and therefore could not
 * hide behind a 404.
 *
 * **An application error means the call succeeded.** If a probe comes back with
 * `unauthenticated` rather than `permission denied for function`, the function
 * *ran* — control reached its body, so the role holds EXECUTE. That distinction
 * is the entire point of the test, and conflating the two is what makes a
 * security check comforting instead of useful.
 *
 * Checks are also chosen to be meaningful against an *empty* database: a select
 * returning no rows proves nothing when there is nothing to return.
 *
 *   node supabase/tests/remote-smoke.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadEnv() {
  const text = readFileSync(join(root, '.env'), 'utf8');
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2];
  }
  return out;
}

const env = loadEnv();
const url = env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.error('Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY in .env');
  process.exit(1);
}

const headers = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };
const NIL = '00000000-0000-0000-0000-000000000000';

async function get(path) {
  const res = await fetch(`${url}/rest/v1/${path}`, { headers });
  return { status: res.status, body: await res.text() };
}

async function rpc(name, args) {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  return { status: res.status, body: await res.text() };
}

async function insert(table, row) {
  const res = await fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(row),
  });
  return { status: res.status, body: await res.text() };
}

let passed = 0;
const failures = [];
const inconclusive = [];

function report(name, verdict, detail) {
  if (verdict === 'pass') {
    passed += 1;
    console.log(`pass          ${name}`);
  } else if (verdict === 'inconclusive') {
    inconclusive.push({ name, detail });
    console.log(`inconclusive  ${name}\n              ${detail}`);
  } else {
    failures.push({ name, detail });
    console.log(`FAIL          ${name}\n              ${detail}`);
  }
}

/**
 * Classifies a response into what it says about privilege.
 *
 *   'refused'   — Postgres rejected the call on EXECUTE. What we want.
 *   'executed'  — control reached the function body, whatever it then returned.
 *   'not-found' — signature did not resolve. Says nothing about privilege.
 *
 * This switches on the SQLSTATE and not the HTTP status, which the first version
 * got wrong in a way worth recording. PostgREST maps SQLSTATE class 28 to HTTP
 * 403, and `assert_can_write` raises 28000 for a caller with no account — so a
 * guarded function that anon *could* execute answered 403, identical to a real
 * privilege refusal. The guard's own error was impersonating the control we were
 * trying to test, and four write paths passed because of it.
 *
 * Only 42501 with a "permission denied" message is Postgres declining to run the
 * function at all. Every other SQLSTATE means the body ran.
 */
function classify({ status, body }) {
  let code = null;
  try {
    code = JSON.parse(body)?.code ?? null;
  } catch {
    // Not a PostgREST error document; fall through to the status checks.
  }

  if (code === 'PGRST202') return 'not-found';
  if (code === '42501' && /permission denied/i.test(body)) return 'refused';
  // Any other SQLSTATE is an error raised from inside the function.
  if (code && /^[0-9A-Z]{5}$/.test(code)) return 'executed';

  if (status === 404) return 'not-found';
  if (status === 401 || status === 403) return 'refused';
  return 'executed';
}

function expectRefused(name, res) {
  const verdict = classify(res);
  const detail = `${res.status} ${res.body.slice(0, 200)}`;
  if (verdict === 'refused') return report(name, 'pass', detail);
  if (verdict === 'not-found') {
    return report(name, 'inconclusive', `signature did not resolve, privilege untested — ${detail}`);
  }
  report(name, 'fail', `function executed, so anon holds EXECUTE — ${detail}`);
}

function expectAllowed(name, res) {
  const verdict = classify(res);
  const detail = `${res.status} ${res.body.slice(0, 200)}`;
  report(name, verdict === 'executed' ? 'pass' : 'fail', detail);
}

console.log(`\nProbing ${url} as an unauthenticated client\n`);

// A wiring check, not a security one: a 401 here would mean the anon key is
// wrong and every result below is noise.
{
  const res = await get('profiles?select=id&limit=1');
  report(
    'anon can reach the REST surface at all',
    res.status === 200 ? 'pass' : 'fail',
    `${res.status} ${res.body.slice(0, 200)}`,
  );
}

// Every write goes through a function (AD-4). Table privileges were revoked so
// that a carelessly added `for insert` policy cannot open a direct write path on
// its own — these must fail on privilege, before any policy is consulted.
for (const table of ['profiles', 'user_media', 'rankings', 'follows', 'reactions', 'reports']) {
  expectRefused(`anon cannot insert into ${table}`, await insert(table, {}));
}

// Private columns live in their own table with no read policy, so a future
// permissive policy on profiles cannot expose a date of birth.
{
  const res = await get('profile_private?select=*&limit=1');
  const ok = classify(res) === 'refused' || res.body.trim() === '[]';
  report('date of birth is not reachable', ok ? 'pass' : 'fail', `${res.status} ${res.body.slice(0, 200)}`);
}

// Security definer helpers run as their owner and bypass row level security.
// Postgres grants EXECUTE to PUBLIC on creation, so each had to be revoked
// explicitly. Probed with real arguments so a 404 cannot masquerade as a pass.
expectRefused('anon cannot execute resolve_capabilities', await rpc('resolve_capabilities', { target: NIL }));
expectRefused('anon cannot execute is_over_13', await rpc('is_over_13', { target: NIL }));
expectRefused('anon cannot execute assert_ranking_valid', await rpc('assert_ranking_valid', { target: NIL, cat: 'film' }));
expectRefused('anon cannot execute _rank_pivot_at', await rpc('_rank_pivot_at', { target: NIL, cat: 'film', pos: 1 }));
expectRefused('anon cannot execute _rank_session_state', await rpc('_rank_session_state', { p_session_id: NIL, p_user: NIL }));
expectRefused('anon cannot execute _rank_start_unguarded', await rpc('_rank_start_unguarded', { p_media_item_id: NIL, p_bucket: 'loved' }));

// Its own capabilities and nobody else's — but only for someone signed in.
expectRefused('anon cannot execute my_capabilities', await rpc('my_capabilities', {}));

// The guard itself, and the write paths that depend on it.
expectRefused('anon cannot execute assert_can_write', await rpc('assert_can_write', { target: NIL }));
expectRefused('anon cannot execute rank_start', await rpc('rank_start', { p_media_item_id: NIL, p_bucket: 'loved' }));
expectRefused('anon cannot execute rank_answer', await rpc('rank_answer', { p_session_id: NIL, p_winner: NIL }));
expectRefused('anon cannot execute rank_reorder', await rpc('rank_reorder', { p_media_item_id: NIL, p_new_position: 1 }));
expectRefused(
  'anon cannot execute report',
  await rpc('report', { p_subject_type: 'profile', p_subject_id: NIL, p_reason: 'spam', p_note: null }),
);

// Deliberately reachable without an account: a shared link has to resolve for
// someone who is not signed in, and possession of the identifier is the gate.
expectAllowed('anon can execute list_by_id, by design', await rpc('list_by_id', { target: NIL }));
expectAllowed('anon can execute list_items_by_list, by design', await rpc('list_items_by_list', { target: NIL }));

const total = passed + failures.length + inconclusive.length;
console.log(`\n${passed}/${total} passed, ${failures.length} failed, ${inconclusive.length} inconclusive\n`);
process.exit(failures.length === 0 ? 0 : 1);
