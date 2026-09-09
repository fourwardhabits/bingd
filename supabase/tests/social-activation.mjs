/**
 * Social connection activation, against a **deployed** nonprod project.
 * `20260912000100` and its corrective `20260912000200`, founder tranche 2026-09-08 §§A4–A14.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS BESIDE TWO SUITES THAT ALREADY COVER THE SAME FUNCTIONS
 *
 * `supabase/tests/follow-activity.test.mjs` runs the migrations under PGlite with real
 * roles and real policies, and `concurrency/races/follow-activity.mjs` runs them under a
 * real PostgreSQL with real transactions. Between them the *logic* is settled, and this
 * file does not re-assert any of it.
 *
 * What neither can reach is **PostgREST**, which is the surface the app actually talks to.
 * Three classes of defect live only there and every one of them is silent:
 *
 *   - a `returns table` function whose new column never reaches the wire, because the
 *     schema cache was not reloaded after the migration;
 *   - an RPC whose argument names drifted, so every call resolves to no function and the
 *     client reads an empty list as "nobody to suggest";
 *   - a grant or a policy that is right in the migration file and wrong in the database,
 *     which is what `remote-smoke.mjs` catches for *anonymous* callers and nothing catches
 *     for authenticated ones.
 *
 * So this signs three real accounts in and walks the founder's own scenario: Suraj invites
 * Abi, Abi joins, and the two of them come out connected with one story in front of
 * Suraj's network. It is the acceptance test for §A7 and §A14 as a person experiences them.
 *
 * ---------------------------------------------------------------------------
 * IT WRITES, SO IT REFUSES TO RUN ANYWHERE BUT NONPROD
 *
 * The guard is `award-privacy.mjs`'s, copied deliberately rather than imported: it is the
 * only thing standing between a service-role key and real users, and a shared helper is a
 * shared helper somebody can change for another caller's convenience. The host is compared
 * on the **parsed hostname**, because `url.includes(ref)` passes for a domain anybody can
 * register.
 *
 *   node supabase/tests/social-activation.mjs
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

console.log(`social activation → ${url}\n`);

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
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text ? JSON.parse(text) : null };
}

const stamp = Date.now().toString(36).slice(-6);
const emails = [];

async function createAccount(label) {
  const email = `bingd_social_${label}_${stamp}@example.com`;
  const password = `Social-${uuid()}`;

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

  const username = `sa_${label}_${stamp}`.toLowerCase().slice(0, 24);
  const profile = await rpc(token, 'create_profile', {
    p_username: username,
    p_display_name: `Social ${label.toUpperCase()}`,
    p_date_of_birth: '1990-01-01',
  });
  if (profile.status !== 200 || profile.body?.ok !== true) {
    throw new Error(`could not create profile for ${label}: ${JSON.stringify(profile)}`);
  }

  return { id: created.body.id, email, token, username, label };
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

let suraj;
let abi;
let stranger;

try {
  console.log('— three accounts —');
  suraj = await createAccount('suraj');
  abi = await createAccount('abi');
  stranger = await createAccount('stranger');
  console.log('');

  // -------------------------------------------------------------------------
  console.log('— an invitation becomes a connection (§A7) —');

  const link = await rpc(suraj.token, 'create_invite_link', { p_operation_id: uuid() });
  report(
    'the inviter mints a personal link',
    link.status === 200 && link.body?.status === 'ok' && typeof link.body?.token === 'string',
    JSON.stringify(link),
  );

  const redeemed = await rpc(abi.token, 'redeem_invite', {
    p_operation_id: uuid(),
    p_token: link.body?.token,
  });
  report(
    'the invitee redeems it',
    redeemed.status === 200 && redeemed.body?.status === 'ok',
    JSON.stringify(redeemed),
  );
  /**
   * The key that only reaches the client if PostgREST is serving the migrated function.
   * `follow_state` was already there; a run where this comes back `undefined` is a schema
   * cache that never reloaded, and the app would silently stop emitting
   * `invite_auto_follow_succeeded` while everything else looked fine.
   */
  report(
    'and the answer says the two are connected',
    redeemed.body?.connected === true,
    `connected: ${JSON.stringify(redeemed.body?.connected)}`,
  );

  const edges = await rpc(abi.token, 'follow_state_with', { p_user_ids: [suraj.id] });
  report(
    'the invitee follows the inviter',
    edges.status === 200 && edges.body?.[0]?.following === 'approved',
    JSON.stringify(edges),
  );
  report(
    'and the inviter follows them back, without either of them pressing anything',
    edges.body?.[0]?.followed_by === 'approved',
    JSON.stringify(edges),
  );

  /**
   * §A8. Two edges, one relationship, one row in each inbox — the reverse edge is written
   * directly rather than through `follow`, precisely so it files no third notification.
   */
  const inbox = await rpc(abi.token, 'my_notifications', { p_limit: 20 });
  // The projection calls it `kind`, not `type` — `my_notifications` renames the column so
  // the client never sees the raw enum name (`20260817000600`).
  const kinds = (inbox.body ?? []).map((row) => row.kind).sort();
  report(
    'the invitee is told once, by the welcome',
    inbox.status === 200 && kinds.length === 1 && kinds[0] === 'invite_welcome',
    JSON.stringify(kinds),
  );

  const inviterInbox = await rpc(suraj.token, 'my_notifications', { p_limit: 20 });
  const inviterKinds = (inviterInbox.body ?? []).map((row) => row.kind).sort();
  report(
    'the inviter is told once, and told that they joined',
    inviterInbox.status === 200 &&
      inviterKinds.length === 1 &&
      inviterKinds[0] === 'invite_joined',
    JSON.stringify(inviterKinds),
  );

  console.log('');

  // -------------------------------------------------------------------------
  console.log('— one story, and only for the people it is for (§§A10, A12, A14) —');

  const story = await service(
    `/rest/v1/feed_events?select=id,actor_id,payload&type=eq.follow_added` +
      `&actor_id=in.(${suraj.id},${abi.id})`,
  );
  const rows = story.body ?? [];
  report(
    'the redemption posted exactly one follow story',
    rows.length === 1,
    JSON.stringify(rows),
  );
  report(
    'and its actor is the inviter, which is the direction with an audience',
    rows[0]?.actor_id === suraj.id,
    `actor: ${rows[0]?.actor_id} inviter: ${suraj.id}`,
  );
  /**
   * The payload holds nothing, which is the §A10 decision made visible on the wire: an
   * array of ids here would be readable by every reader of the event, blocked and private
   * accounts included.
   */
  report(
    'the payload names nobody',
    JSON.stringify(rows[0]?.payload ?? null) === '{}',
    JSON.stringify(rows[0]?.payload),
  );

  const eventId = rows[0]?.id;

  const named = await rpc(abi.token, 'follow_activity_people', {
    p_event_ids: [eventId],
  });
  report(
    'the story names nobody to the person it is about',
    named.status === 200 && Array.isArray(named.body) && named.body.length === 0,
    JSON.stringify(named),
  );

  const strangerRead = await rpc(stranger.token, 'follow_activity_people', {
    p_event_ids: [eventId],
  });
  report(
    'and names them to an unrelated reader who is allowed to identify them',
    strangerRead.status === 200 &&
      strangerRead.body?.length === 1 &&
      strangerRead.body[0].user_id === abi.id &&
      strangerRead.body[0].username === abi.username,
    JSON.stringify(strangerRead),
  );

  /**
   * A block removes the member, which is §A12's rule enforced by `can_identify_profile`
   * rather than by the client that draws the sheet. Asserted here because it is the one
   * exclusion that depends on a *second* account's action rather than on a setting.
   */
  const blocked = await rpc(abi.token, 'block', {
    p_operation_id: uuid(),
    p_blocked_id: stranger.id,
  });
  report(
    'the block itself commits',
    blocked.status === 200 && blocked.body?.status === 'ok',
    JSON.stringify(blocked),
  );
  const afterBlock = await rpc(stranger.token, 'follow_activity_people', {
    p_event_ids: [eventId],
  });
  report(
    'a block in either direction removes the member from the story',
    afterBlock.status === 200 && afterBlock.body?.length === 0,
    JSON.stringify(afterBlock),
  );
  await rpc(abi.token, 'unblock', { p_operation_id: uuid(), p_blocked_id: stranger.id });

  console.log('');

  // -------------------------------------------------------------------------
  console.log('— following from People (§§A5, A6, A9) —');

  const follow = await rpc(stranger.token, 'follow', {
    p_operation_id: uuid(),
    p_followee_id: suraj.id,
  });
  report(
    'a follow of a public account lands approved',
    follow.status === 200 && follow.body?.state === 'approved',
    JSON.stringify(follow),
  );

  const ownStory = await service(
    `/rest/v1/feed_events?select=id&type=eq.follow_added&actor_id=eq.${stranger.id}`,
  );
  report(
    'and posts one story of its own',
    (ownStory.body ?? []).length === 1,
    JSON.stringify(ownStory.body),
  );

  /**
   * §A11, through the deployed writer: the follow back inside the window announces nothing,
   * because the relationship was announced once already. The edge is created either way,
   * which is the half that must never be traded for the presentation rule.
   */
  const followBack = await rpc(suraj.token, 'follow', {
    p_operation_id: uuid(),
    p_followee_id: stranger.id,
  });
  const backStory = await service(
    `/rest/v1/feed_events?select=id&type=eq.follow_added&actor_id=eq.${suraj.id}`,
  );
  report(
    'a follow back inside the window creates the edge',
    followBack.status === 200 && followBack.body?.state === 'approved',
    JSON.stringify(followBack),
  );
  report(
    'and adds no second story — the inviter still has exactly the one',
    (backStory.body ?? []).length === 1,
    JSON.stringify(backStory.body),
  );

  /**
   * The two People lists, through PostgREST. What is being checked is not the ranking —
   * that is `people-discovery.test.mjs` — but that both functions resolve, answer 200, and
   * that the Match projection carries `shared_count`, which is the column the migration
   * added and the column a stale schema cache would silently drop.
   */
  const mutuals = await rpc(stranger.token, 'people_mutuals', { p_limit: 10 });
  report(
    'people_mutuals resolves and answers',
    mutuals.status === 200 && Array.isArray(mutuals.body),
    JSON.stringify(mutuals).slice(0, 200),
  );

  const matches = await rpc(stranger.token, 'people_taste_matches', { p_limit: 10 });
  report(
    'people_taste_matches resolves and answers',
    matches.status === 200 && Array.isArray(matches.body),
    JSON.stringify(matches).slice(0, 200),
  );
  /**
   * An empty list cannot prove the column exists, so the shape is checked against the
   * function's declared columns instead of against a row. A `select` naming a column
   * PostgREST does not know answers 400, which is exactly the signal wanted here.
   */
  const shaped = await fetch(`${url}/rest/v1/rpc/people_taste_matches?select=shared_count`, {
    method: 'POST',
    headers: asUser(stranger.token),
    body: JSON.stringify({ p_limit: 1 }),
  });
  report(
    'and Match carries the shared count the People row prints',
    shaped.status === 200,
    `${shaped.status} ${(await shaped.text()).slice(0, 200)}`,
  );

  console.log('');

  // -------------------------------------------------------------------------
  console.log('— the corrective migrations, on the wire (20260912000200 .. 400) —');

  /**
   * `follow_activity_people` was **dropped and recreated twice** — first with a narrower
   * return type, then with a narrower *signature* — and that is the change PostgREST is most
   * able to get wrong: a stale schema cache keeps serving the old one, and everything below
   * would then be about a function that no longer exists. Both assertions are negative,
   * because a negative is what a stale cache fails.
   */
  const gone = await fetch(`${url}/rest/v1/rpc/follow_activity_people?select=ordinal`, {
    method: 'POST',
    headers: asUser(stranger.token),
    body: JSON.stringify({ p_event_ids: [eventId] }),
  });
  report(
    'the reader no longer has an ordinal column, so the recreate reached the cache',
    gone.status === 400,
    `${gone.status} ${(await gone.text()).slice(0, 160)}`,
  );

  const limited = await rpc(stranger.token, 'follow_activity_people', {
    p_event_ids: [eventId],
    p_limit: 1,
  });
  report(
    'and it no longer takes a limit at all, so nothing can ask it to truncate a story',
    limited.status === 404,
    `${limited.status} ${JSON.stringify(limited.body).slice(0, 160)}`,
  );

  const whole = await rpc(stranger.token, 'follow_activity_people', { p_event_ids: [eventId] });
  report(
    'while the one-argument form answers the whole story',
    whole.status === 200 && whole.body?.length === 1,
    JSON.stringify(whole).slice(0, 200),
  );

  const cap = await service(
    `/rest/v1/app_config?select=key,value&key=eq.feed.follow_story_max_people`,
  );
  report(
    'the story ceiling is configured, so the count the row prints is the whole set',
    (cap.body ?? [])[0]?.value === 50,
    JSON.stringify(cap.body),
  );

  /**
   * The founder's decision, in the combination that used to behave differently: a private
   * inviter and a private invitee. Both edges must come out approved, and neither inbox may
   * keep a `follow_request` for a decision the invitation already made.
   */
  const pi = await createAccount('privinviter');
  const pj = await createAccount('privinvitee');
  for (const who of [pi, pj]) {
    const set = await rpc(who.token, 'set_profile_visibility', {
      p_operation_id: uuid(),
      p_visibility: 'private',
    });
    report(`${who.label} goes private`, set.status === 200 && set.body?.status === 'ok', JSON.stringify(set));
  }

  const privLink = await rpc(pi.token, 'create_invite_link', { p_operation_id: uuid() });
  const privRedeem = await rpc(pj.token, 'redeem_invite', {
    p_operation_id: uuid(),
    p_token: privLink.body?.token,
  });
  report(
    'a private invitee redeeming a private inviter`s personal link comes out connected',
    privRedeem.status === 200 &&
      privRedeem.body?.status === 'ok' &&
      privRedeem.body?.follow_state === 'approved' &&
      privRedeem.body?.connected === true,
    JSON.stringify(privRedeem),
  );

  const privEdges = await rpc(pj.token, 'follow_state_with', { p_user_ids: [pi.id] });
  report(
    'both directed edges are approved, with nothing left pending',
    privEdges.body?.[0]?.following === 'approved' && privEdges.body?.[0]?.followed_by === 'approved',
    JSON.stringify(privEdges),
  );

  const privInbox = await rpc(pi.token, 'my_notifications', { p_limit: 20 });
  const privKinds = (privInbox.body ?? []).map((row) => row.kind).sort();
  report(
    'and the private inviter is told once, by the join row rather than a request',
    privKinds.length === 1 && privKinds[0] === 'invite_joined',
    JSON.stringify(privKinds),
  );

  console.log('');
} finally {
  console.log('— cleanup —');
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
