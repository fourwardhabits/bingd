/**
 * `people_starter_suggestions` over PostgREST, against a **deployed** nonprod project.
 * `20260914000100`, the organic branch of onboarding's People step.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS BESIDE A SUITE THAT ALREADY COVERS THE SAME FUNCTION
 *
 * `supabase/tests/people-starter-suggestions.test.mjs` runs the migration under PGlite
 * with real roles and real policies, and it is thorough: every exclusion is asserted
 * against a candidate that would otherwise have topped the list. Between it and
 * `function-grants.test.mjs` the *logic* and the *grant as written* are settled, and this
 * file re-asserts neither for its own sake.
 *
 * What neither can reach is PostgREST, and this function is new — it had never answered a
 * request over the wire anywhere. Three classes of defect live only there, and every one
 * of them is silent (`social-activation.mjs` records the same three):
 *
 *   - a `returns table` whose columns never reach the client, because the schema cache was
 *     not reloaded after the migration. The step renders an empty list and reports
 *     `could_not_load`, and nothing in the database is wrong;
 *   - an argument name that drifted, so `p_limit` resolves to no function at all and every
 *     call 404s into that same empty list;
 *   - a grant that is right in the migration file and wrong on the running database.
 *     `remote-smoke.mjs` catches that for *anonymous* callers — including this function
 *     since 20260914000100 — and nothing catches it for authenticated ones.
 *
 * So this signs four real accounts in and asks the question onboarding asks: **a caller
 * with no relationships at all, and who may be suggested to them.** The exclusions are
 * re-checked here not to re-test the SQL but because a privacy rule that holds in PGlite
 * and not over the wire is the failure worth spending a suite on. This is the one list in
 * the product put in front of somebody with no social cover at all.
 *
 * ---------------------------------------------------------------------------
 * IT WRITES, SO IT REFUSES TO RUN ANYWHERE BUT NONPROD
 *
 * The guard is `social-activation.mjs`'s, which is `award-privacy.mjs`'s, copied
 * deliberately rather than imported: it is the only thing standing between a service-role
 * key and real users, and a shared helper is a shared helper somebody can change for
 * another caller's convenience. The host is compared on the **parsed hostname**, because
 * `url.includes(ref)` passes for a domain anybody can register.
 *
 *   node supabase/tests/starter-suggestions-remote.mjs
 */
import { randomUUID as uuid } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { LANE_BACKENDS } = require('../../config/backends.cjs');
const { environmentForRef } = require('../../config/production-lane.cjs');

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `.env`, then `.env.local`, then the ambient environment — the precedence its siblings use. */
function loadEnv(name) {
  try {
    const text = readFileSync(join(root, name), 'utf8');
    return Object.fromEntries(
      text
        .split(/\r?\n/)
        .filter((line) => line.trim() && !line.trim().startsWith('#'))
        .map((line) => {
          const at = line.indexOf('=');
          return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
        }),
    );
  } catch {
    return {};
  }
}

const env = { ...loadEnv('.env'), ...loadEnv('.env.local'), ...process.env };
const url = env.EXPO_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL;
const anonKey = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceKey) {
  console.error(
    'Need EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY',
  );
  process.exit(1);
}

const NONPROD_REF = LANE_BACKENDS.preview[0];
if (!NONPROD_REF || environmentForRef(NONPROD_REF) !== 'nonprod') {
  console.error(
    'Refusing to run: the preview lane resolves to ' +
      (NONPROD_REF ?? '(nothing)') +
      ', which is not a project declared nonprod. This script writes with the service-role ' +
      'key and must never be pointed at production.',
  );
  process.exit(1);
}
const NONPROD_HOST = `${NONPROD_REF}.supabase.co`;
{
  let host = null;
  let protocol = null;
  try {
    const parsed = new URL(url);
    host = parsed.host;
    protocol = parsed.protocol;
  } catch {
    host = null;
  }
  if (protocol !== 'https:' || host !== NONPROD_HOST) {
    console.error(`Refusing to run: ${url} is not https://${NONPROD_HOST}.`);
    process.exit(1);
  }
}

console.log(`starter suggestions → ${url}\n`);

// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];

function report(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`pass          ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`FAIL          ${name}\n              ${detail}`);
  }
}

const asUser = (token) => ({
  apikey: anonKey,
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

async function rpc(token, name, args) {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: asUser(token),
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function service(path, init = {}) {
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body };
}

const stamp = Date.now().toString(36).slice(-6);
const emails = [];

async function createAccount(label, visibility = 'public') {
  const email = `bingd_starter_${label}_${stamp}@example.com`;
  const password = `Starter-${uuid()}`;

  const created = await service('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!created.ok) throw new Error(`could not create ${label}: ${JSON.stringify(created.body)}`);
  emails.push(email);

  const session = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!session.ok) throw new Error(`could not sign in ${label}: ${await session.text()}`);
  const { access_token: token } = await session.json();

  const username = `st_${label}_${stamp}`.toLowerCase().slice(0, 24);
  const profile = await rpc(token, 'create_profile', {
    p_username: username,
    p_display_name: `Starter ${label.toUpperCase()}`,
    p_date_of_birth: '1990-01-01',
  });
  if (profile.status !== 200 || profile.body?.ok !== true) {
    throw new Error(`could not create profile for ${label}: ${JSON.stringify(profile)}`);
  }

  if (visibility !== 'public') {
    const set = await service(`/rest/v1/profiles?id=eq.${created.body.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ visibility }),
    });
    if (!set.ok) {
      throw new Error(`could not make ${label} ${visibility}: ${JSON.stringify(set.body)}`);
    }
  }

  return { id: created.body.id, email, token, username, label };
}

/**
 * Rankings, written with the service key rather than through `rank_start`.
 *
 * A real session per title would make a four-account fixture a dozen comparisons, and
 * nothing under test reads `position`: this function returns counts, deliberately, and
 * never a score. The positions are still per account and per category, because
 * `rankings_position_unique` is.
 */
const positions = new Map();
async function rank(userId, mediaItemId) {
  const position = (positions.get(userId) ?? 0) + 1;
  positions.set(userId, position);
  const written = await service('/rest/v1/rankings', {
    method: 'POST',
    headers: { Prefer: 'return=minimal,resolution=ignore-duplicates' },
    body: JSON.stringify({
      user_id: userId,
      media_item_id: mediaItemId,
      category: 'movies',
      bucket: 'loved',
      position,
    }),
  });
  if (!written.ok) throw new Error(`could not rank: ${JSON.stringify(written.body)}`);
}

async function sweep(email) {
  const found = await service(`/auth/v1/admin/users?filter=${encodeURIComponent(email)}`);
  for (const user of found.body?.users ?? []) {
    if (user.email !== email) continue;
    await service(`/auth/v1/admin/users/${user.id}`, { method: 'DELETE' });
    console.log(`swept         ${email}`);
  }
}

// ---------------------------------------------------------------------------

const accounts = [];

try {
  /**
   * Four titles out of the catalogue this project already has. The function counts shared
   * *titles*, so which ones they are does not matter — only that the caller and a candidate
   * hold the same row, which is what makes an eligible candidate outrank every account left
   * behind by every other suite that has ever run here. (The local file's header explains
   * why that device is necessary: this function has no social horizon to isolate a caller.)
   */
  const catalogue = await service('/rest/v1/media_items?select=id,title&limit=4&order=id');
  const titles = catalogue.body ?? [];
  if (titles.length < 4) {
    throw new Error(`this project's catalogue has ${titles.length} titles; the fixture needs 4`);
  }

  console.log('— four accounts —');
  const newcomer = await createAccount('newcomer');
  const open = await createAccount('open');
  const shy = await createAccount('shy', 'private');
  const blocked = await createAccount('blocked');
  accounts.push(newcomer, open, shy, blocked);
  console.log('');

  // The caller is exactly who this step is for: somebody who has just finished the ranking
  // run and has no relationships at all. Three of their titles are shared with a candidate.
  for (const title of titles) await rank(newcomer.id, title.id);
  await rank(open.id, titles[0].id);
  await rank(shy.id, titles[1].id);
  await rank(blocked.id, titles[2].id);

  const block = await service('/rest/v1/blocks', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ blocker_id: newcomer.id, blocked_id: blocked.id }),
  });
  if (!block.ok) throw new Error(`could not block: ${JSON.stringify(block.body)}`);

  // -------------------------------------------------------------------------
  console.log('— the call itself —');

  const answer = await rpc(newcomer.token, 'people_starter_suggestions', { p_limit: 10 });
  report(
    'an authenticated caller can execute it',
    answer.status === 200 && Array.isArray(answer.body),
    JSON.stringify(answer).slice(0, 300),
  );

  const rows = Array.isArray(answer.body) ? answer.body : [];
  const ids = rows.map((candidate) => candidate.user_id);
  const row = rows.find((candidate) => candidate.user_id === open.id);

  report(
    'the public candidate with a shared title is suggested',
    Boolean(row),
    `ids: ${JSON.stringify(ids)}`,
  );

  /**
   * The check that only exists here. A `returns table` whose columns never reach the client
   * is a schema cache that was not reloaded, and the step's failure mode is an empty list
   * rather than an error — so nothing else in the stack would say a word about it.
   */
  report(
    'and every declared column reaches the client',
    row
      ? JSON.stringify(Object.keys(row).sort()) ===
        JSON.stringify([
          'avatar_path',
          'display_name',
          'ranked_count',
          'shared_count',
          'user_id',
          'username',
          'visibility',
        ])
      : false,
    JSON.stringify(row ? Object.keys(row).sort() : null),
  );
  report(
    'the two numbers are counts, and they are right',
    row?.shared_count === 1 && row?.ranked_count === 1,
    JSON.stringify(row),
  );

  // -------------------------------------------------------------------------
  console.log('\n— who is excluded, over the wire —');

  report(
    'the caller is never suggested to themselves',
    !ids.includes(newcomer.id),
    JSON.stringify(ids),
  );
  report(
    'a private account is never put in front of a stranger, however well it matches',
    !ids.includes(shy.id),
    JSON.stringify(ids),
  );
  report('a blocked account is dropped', !ids.includes(blocked.id), JSON.stringify(ids));

  // `follow(p_operation_id, p_followee_id)`. The idempotency key is supplied by the app's
  // own `rpc` wrapper rather than by the call site, which is why it is easy to leave out
  // here — and leaving it out is a 404, not an error, so the omission would have read as
  // "the function is gone".
  const followed = await rpc(newcomer.token, 'follow', {
    p_operation_id: uuid(),
    p_followee_id: open.id,
  });
  report(
    'the caller can follow the one they were shown',
    followed.status === 200 && followed.body?.status === 'ok',
    JSON.stringify(followed).slice(0, 200),
  );

  const after = await rpc(newcomer.token, 'people_starter_suggestions', { p_limit: 10 });
  report(
    'and somebody already followed stops being a suggestion',
    Array.isArray(after.body) && !after.body.some((candidate) => candidate.user_id === open.id),
    JSON.stringify(after).slice(0, 300),
  );

  // -------------------------------------------------------------------------
  console.log('\n— the argument —');

  const limited = await rpc(newcomer.token, 'people_starter_suggestions', { p_limit: 1 });
  report(
    'p_limit resolves and is honoured',
    limited.status === 200 && Array.isArray(limited.body) && limited.body.length <= 1,
    JSON.stringify(limited).slice(0, 200),
  );

  const clamped = await rpc(newcomer.token, 'people_starter_suggestions', { p_limit: 9999 });
  report(
    'and an absurd one is clamped to ten rather than refused',
    clamped.status === 200 && Array.isArray(clamped.body) && clamped.body.length <= 10,
    JSON.stringify(clamped).slice(0, 200),
  );

  /**
   * The default, which the client relies on when the step asks for its own size. PostgREST
   * resolves a call with no arguments only against a function whose parameter is defaulted,
   * so this is the one probe that would catch that default being dropped.
   */
  const bare = await rpc(newcomer.token, 'people_starter_suggestions', {});
  report(
    'it answers with no argument at all, so the default is real',
    bare.status === 200 && Array.isArray(bare.body),
    JSON.stringify(bare).slice(0, 200),
  );

  console.log('');
} finally {
  console.log('— cleanup —');
  for (const account of accounts) {
    try {
      await service(`/rest/v1/rankings?user_id=eq.${account.id}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=minimal' },
      });
    } catch (error) {
      console.log(`could not clear rankings for ${account.label}: ${error.message}`);
    }
  }
  for (const email of emails) {
    try {
      await sweep(email);
    } catch (error) {
      console.log(`could not sweep ${email}: ${error.message}`);
    }
  }
}

const total = passed + failures.length;
console.log(`\n${passed}/${total} passed, ${failures.length} failed\n`);
process.exit(failures.length === 0 ? 0 : 1);
