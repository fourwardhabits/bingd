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

// `public_profiles` is **dropped and recreated** by `20260817000800`, and a `drop view`
// takes its grants with it — the `grant select ... to anon, authenticated` that
// `20260813001400` made is against an object that no longer exists. Nothing in the founder
// pass re-grants it, so what the deployed view actually permits depends on the project's
// default privileges rather than on anything written in a migration.
//
// That is precisely the kind of thing the local suite cannot answer: it builds its schema
// from the files as the table owner, for whom the question never arises. Independent
// review 17i asked for the recreated boundary to be asserted rather than assumed, and this
// is that assertion — the view must still be readable, because the public profile route
// and user search both read it.
{
  const res = await get('public_profiles?select=username&limit=1');
  report(
    'the recreated public_profiles view is still readable, grants and all',
    res.status === 200 ? 'pass' : 'fail',
    `${res.status} ${res.body.slice(0, 200)}`,
  );
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

// The oracles closed in 20260813001900. Both are SECURITY DEFINER and were
// granted to anon because policies call them; the argument-taking forms let a
// stranger ask about other people's blocks and approved follows.
expectRefused('anon cannot execute can_view_profile', await rpc('can_view_profile', { viewer: NIL, subject: NIL }));
expectRefused('anon cannot execute blocked_between', await rpc('blocked_between', { a: NIL, b: NIL }));

// The replacements, which take no identity and so must stay reachable.
expectAllowed('anon can execute can_i_view, by design', await rpc('can_i_view', { subject: NIL }));
expectAllowed('anon can execute watch_tag_visible, by design', await rpc('watch_tag_visible', { tag_id: NIL }));

// ---------------------------------------------------------------------------
// The TMDB adapter's write path (20260815000000)
//
// These four functions write the catalogue and run as service_role. The local
// suite asserts the same thing, but only about migrations it just replayed —
// whether the *deployed* database revoked EXECUTE is a separate claim, and it is
// the one that matters. An unguarded tmdb_upsert_titles would let anyone rewrite
// every title in the app.
// ---------------------------------------------------------------------------

expectRefused(
  'anon cannot execute tmdb_upsert_titles',
  await rpc('tmdb_upsert_titles', { p_items: [] }),
);
expectRefused(
  'anon cannot execute tmdb_upsert_seasons',
  await rpc('tmdb_upsert_seasons', { p_parent_id: NIL, p_seasons: [] }),
);
expectRefused(
  'anon cannot execute tmdb_put_facet',
  await rpc('tmdb_put_facet', { p_media_item_id: NIL, p_facet: 'credits', p_payload: {} }),
);
expectRefused(
  'anon cannot execute tmdb_note_request',
  await rpc('tmdb_note_request', { p_user_id: NIL }),
);
// Added 2026-08-16 with the trending cache. It is the only writer of a
// world-readable table, so a stranger reaching it could rewrite what the Feed shows
// everyone.
expectRefused(
  'anon cannot execute tmdb_put_list',
  await rpc('tmdb_put_list', { p_list_key: 'trending.movie.day', p_payload: { ids: [] } }),
);
// Added 2026-08-16 with yearly goals. `authenticated` only — there is no auth.uid()
// for a goal to belong to otherwise, and the function would write a null-owned row
// or fail obscurely.
// Added 2026-08-16 with For You. A client holding this could evict any cached facet
// in the catalogue by claiming it and never fetching, two minutes at a time.
expectRefused(
  'anon cannot execute tmdb_claim_facet',
  await rpc('tmdb_claim_facet', { p_media_item_id: NIL, p_facet: 'similar' }),
);
expectRefused(
  'anon cannot execute set_watch_goal',
  await rpc('set_watch_goal', { p_year: 2026, p_category: 'movies', p_target: 1 }),
);
// Added 2026-08-17 with the Following score. It is `authenticated` only because
// `auth.uid()` is its entire population filter, so anon could only ever receive the
// empty answer — but the grant is what makes that a decision rather than an accident.
// This probe does double duty: `refused` proves the signature resolved, so it also
// asserts the migration is actually on the deployed database and not merely on disk.
expectRefused(
  'anon cannot execute following_score',
  await rpc('following_score', { p_media_item_id: NIL }),
);
// Added 2026-08-17 with Comments V1. Three writers on the first table in this schema
// that holds free text somebody else wrote. Each probe doubles as an assertion that
// the migration is on the deployed database: `refused` means the signature resolved.
expectRefused(
  'anon cannot execute add_comment',
  await rpc('add_comment', { p_operation_id: NIL, p_feed_event_id: NIL, p_body: 'x', p_has_spoilers: false }),
);
expectRefused(
  'anon cannot execute edit_comment',
  await rpc('edit_comment', { p_operation_id: NIL, p_comment_id: NIL, p_body: 'x', p_has_spoilers: false }),
);
expectRefused(
  'anon cannot execute delete_comment',
  await rpc('delete_comment', { p_operation_id: NIL, p_comment_id: NIL }),
);
// Added 2026-08-17 with the social graph writers. These are the first writers this
// database has ever had for `follows` and `blocks` — the two tables `can_view_profile`
// consults — so an anon caller reaching any of them would be able to manufacture the
// relationships every visibility decision is made from.
expectRefused(
  'anon cannot execute follow',
  await rpc('follow', { p_operation_id: NIL, p_followee_id: NIL }),
);
expectRefused(
  'anon cannot execute unfollow',
  await rpc('unfollow', { p_operation_id: NIL, p_followee_id: NIL }),
);
expectRefused(
  'anon cannot execute respond_follow_request',
  await rpc('respond_follow_request', {
    p_operation_id: NIL,
    p_requester_id: NIL,
    p_approve: true,
  }),
);
expectRefused(
  'anon cannot execute remove_follower',
  await rpc('remove_follower', { p_operation_id: NIL, p_follower_id: NIL }),
);
expectRefused(
  'anon cannot execute block',
  await rpc('block', { p_operation_id: NIL, p_blocked_id: NIL }),
);
expectRefused(
  'anon cannot execute unblock',
  await rpc('unblock', { p_operation_id: NIL, p_blocked_id: NIL }),
);
expectRefused('anon cannot execute follow_state_with', await rpc('follow_state_with', { p_user_ids: [NIL] }));
// No argument at all, so it cannot hide behind a 404 the way an argument mismatch can
// — which makes this one of the few probes here whose refusal is unambiguous.
expectRefused('anon cannot execute my_blocks', await rpc('my_blocks', {}));
// Added 2026-08-17 with user discovery. A people search reachable without an account
// would be an enumeration endpoint over every public profile in the database.
expectRefused('anon cannot execute search_users', await rpc('search_users', { p_query: 'a', p_limit: 5 }));
// Added 2026-08-17 with Taste Match. auth.uid() is one half of the pair, so anon has
// no catalogue to compare — but the grant is what makes that a decision.
expectRefused('anon cannot execute taste_match', await rpc('taste_match', { p_user_id: NIL }));

// Own-read only, and a stranger is not the owner. An empty array is the correct
// answer under RLS; a row would mean the policy is not doing its job.
{
  const res = await get('watch_goals?select=*&limit=1');
  const ok = classify(res) === 'refused' || res.body.trim() === '[]';
  report(
    'anon cannot read anyone’s goals',
    ok ? 'pass' : 'fail',
    `${res.status} ${res.body.slice(0, 200)}`,
  );
}

// The revoke, checked on the running database rather than in the migration.
//
// `comments` is the first table here that holds free text somebody else wrote, and the
// RLS policy alone would *admit* an anonymous reader for a public author on a public
// actor's event — which is right for feed_events and reactions and wrong for this.
// The grant is what makes the difference, and a grant revoked in a migration and a
// grant revoked on the running database are different claims.
//
// A 200 with `[]` would be a FAIL here, not a pass: that is what a policy denial looks
// like through PostgREST, and the whole point is that the refusal happens a layer
// earlier. So this asserts a refusal, not an empty result.
{
  const res = await get('comments?select=body&limit=1');
  report(
    'anon is refused comments at the grant, not the policy',
    classify(res) === 'refused' ? 'pass' : 'fail',
    `${res.status} ${res.body.slice(0, 200)}`,
  );
}

// World-readable *by design*, like media_items and media_cache: it is catalogue
// metadata and says nothing about any account. Asserted rather than assumed, because
// the Feed's shelf depends on an unauthenticated-shaped read succeeding.
// Note what this can and cannot tell you: PostgREST answers a policy denial and an
// empty table identically, with `200 []`. So this proves the relation exists and is
// not refused outright; it does not prove a row would come back. The row half is
// covered once the adapter has been deployed and `npm run trending:refresh` has run.
expectAllowed(
  'anon can read the trending cache, by design',
  await get('provider_list_cache?select=list_key&limit=1'),
);

// RLS with no policy at all. How often someone searches is not their own business
// to read and is certainly not a stranger's.
{
  const res = await get('tmdb_request_log?select=*&limit=1');
  const ok = classify(res) === 'refused' || res.body.trim() === '[]';
  report(
    'anon cannot read the adapter request log',
    ok ? 'pass' : 'fail',
    `${res.status} ${res.body.slice(0, 200)}`,
  );
}

// The catalogue is world-readable by design (media_items has `using (true)`), and
// after the backfill that is worth confirming rather than assuming: a search
// result with no artwork is the symptom the whole integration exists to remove.
{
  const res = await get('media_items?select=id&kind=eq.movie&poster_path=not.is.null&limit=1');
  let hasArtwork = false;
  try {
    hasArtwork = JSON.parse(res.body).length === 1;
  } catch {
    // Left false; the report below says what came back instead.
  }
  report(
    'the catalogue is readable and has artwork',
    hasArtwork ? 'pass' : 'fail',
    `${res.status} ${res.body.slice(0, 200)}`,
  );
}

// AD-8's client-facing half. The provider quota sits behind this function, so an
// unauthenticated caller must not reach it — verify_jwt refuses the request before
// the function starts, and the function refuses again if it ever does not.
{
  const res = await fetch(`${url}/functions/v1/tmdb-adapter`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'search', query: 'inception' }),
  });
  const body = await res.text();
  report(
    'anon cannot reach TMDB through the adapter',
    res.status === 401 ? 'pass' : 'fail',
    `${res.status} ${body.slice(0, 200)}`,
  );
}

// Added 2026-08-17 with Phase E. `person_cache` is a third sibling of `media_cache`
// and `provider_list_cache`, and its two writers are service_role only for the same
// reasons the facet writers are: one could write any filmography onto any person id
// and every viewer of that page would render it, and the other could keep any person
// blank indefinitely, two minutes at a time. Each probe also asserts the migration is
// on the deployed database rather than merely on disk -- `refused` means the signature
// resolved.
expectRefused(
  'anon cannot execute tmdb_put_person',
  await rpc('tmdb_put_person', { p_person_id: 1, p_payload: { person: {}, credits: [] } }),
);
expectRefused(
  'anon cannot execute tmdb_claim_person',
  await rpc('tmdb_claim_person', { p_person_id: 1 }),
);

// The person cache is world-readable, like every other catalogue table. A filmography
// is what TMDB publishes on a public page and nothing viewer-relative is stored in it.
{
  const res = await get('person_cache?select=tmdb_person_id&limit=1');
  report(
    'anon can read the person cache, by design',
    res.status === 200 ? 'pass' : 'fail',
    `${res.status} ${res.body.slice(0, 160)}`,
  );
}

// Added 2026-08-17 with Settings. Every one of these is about the caller's own account
// and `auth.uid()` is null for anon, so a grant would buy nothing but a surface --
// and `delete_account` reaching an unauthenticated caller would be the worst of them.
// `update_profile` and `change_username` were **dropped** by `20260817000800` and replaced
// by one `save_profile` -- the founder's "one Save" correction, which made a name, a handle
// and a bio a single atomic write rather than three buttons that could half-succeed.
//
// Their probes were left behind, and this run's `test:remote` is what exposed it: both came
// back `inconclusive` with PGRST202, which is the suite correctly reporting that it had
// verified *nothing*. Two probes aimed at functions that no longer exist, while the function
// that replaced them -- the one that can now rename an account and rewrite its bio -- had no
// deployed anon probe at all. That is the more serious half, and it is why these are
// replaced rather than deleted.
expectRefused(
  'anon cannot execute save_profile',
  await rpc('save_profile', {
    p_operation_id: NIL,
    p_display_name: 'x',
    p_username: 'nobody_at_all',
    p_bio: 'x',
  }),
);
// The rest of what `20260817000800` added, none of which had a boundary probe until
// independent review 17h swept for the same rot that left the two dead ones behind.
//
// `title_reviews` matters most of the three. It is the function this entire deployment was
// about, it was **recreated** by `20260817001100`, and `create or replace` is precisely the
// operation that has silently dropped a guarantee in this schema before -- so a probe that
// resolves its signature *and* finds anon refused is worth more here than anywhere else in
// this file. It follows `public_notes`' rule: a note is readable by people, not by the
// internet.
expectRefused(
  'anon cannot execute title_reviews',
  await rpc('title_reviews', { p_media_item_id: NIL, p_sort: 'top', p_limit: 1 }),
);
// `social`, not an invented category. The function accepts only `social` and `follows`,
// and a rejected *input* would be classified `executed` and fail this probe rather than
// pass it — so the value cannot manufacture a false pass either way. It is correct here so
// that the probe would reach normal behaviour if the grant ever regressed, which is the
// only state in which the argument matters. Independent review 17i.
expectRefused(
  'anon cannot execute set_notification_preference',
  await rpc('set_notification_preference', { p_category: 'social', p_enabled: true }),
);
// The two definer helpers the same migration added. `_notifies` is the sensitive one: it
// answers a question about a *named third party's* settings, so an execute grant reaching
// anon would be a disclosure about somebody who never called anything.
expectRefused(
  'anon cannot execute _notifies',
  await rpc('_notifies', { p_recipient: NIL, p_category: 'social' }),
);
// `_apply_notification_preference()` is the third object `20260817000800` revoked, and it
// is **deliberately not probed here**: it returns `trigger`, which PostgREST cannot expose
// as an RPC at all, so a probe would resolve nothing and report `inconclusive` forever.
// The limitation is written down rather than left as a silent omission, because a missing
// probe and an unprobeable object look identical in a passing run — which is how the two
// dead probes above survived. Its grant is covered locally by `function-grants.test.mjs`.
expectRefused(
  'anon cannot execute my_notification_preferences',
  await rpc('my_notification_preferences', {}),
);
expectRefused(
  'anon cannot execute set_profile_visibility',
  await rpc('set_profile_visibility', { p_operation_id: NIL, p_visibility: 'public' }),
);
expectRefused('anon cannot execute my_notifications', await rpc('my_notifications', { p_limit: 1 }));
expectRefused('anon cannot execute mark_notifications_read', await rpc('mark_notifications_read', {}));
expectRefused('anon cannot execute delete_account', await rpc('delete_account', { p_confirmation: 'x' }));

// ---------------------------------------------------------------------------
// Friend recommendations (20260817001300)
//
// Two new tables that hold facts about two named accounts, and four new functions,
// three of which name a person. This is the only place the deployed grants on them can
// be observed: the local suite builds its schema from the files and runs as the table
// owner, for whom `revoke all ... from anon` is a question that never comes up. That
// is the "owner is not the caller" blind spot that cost `public_profiles` two days.
// ---------------------------------------------------------------------------

for (const table of ['title_recommendations', 'invite_link_creations']) {
  const res = await get(`${table}?select=id&limit=1`);
  // Either the grant is absent (401/403) or RLS returns nothing. Both are correct and
  // neither may return a row: every row in these tables is about somebody by name.
  report(
    `anon reads no rows from ${table}`,
    res.status >= 400 || res.body.trim() === '[]' ? 'pass' : 'fail',
    `${res.status} ${res.body.slice(0, 160)}`,
  );
  expectRefused(`anon cannot insert into ${table}`, await insert(table, {}));
}

expectRefused(
  'anon cannot execute recommend_title',
  await rpc('recommend_title', { p_operation_id: NIL, p_recipient_id: NIL, p_media_item_id: NIL }),
);
expectRefused(
  'anon cannot execute recommendations_to_me',
  await rpc('recommendations_to_me', { p_limit: 1 }),
);
expectRefused(
  'anon cannot execute mark_recommendation_opened',
  await rpc('mark_recommendation_opened', { p_recommendation_id: NIL }),
);
expectRefused(
  'anon cannot execute create_invite_link',
  await rpc('create_invite_link', { p_operation_id: NIL, p_media_item_id: null }),
);

// The two internals. `_is_mutual_follow` answers a question about somebody else's
// follow graph and `_can_tag` now delegates to it, so both are revoked from every
// client role — the rule 20260813001900 exists to enforce.
expectRefused('anon cannot execute _is_mutual_follow', await rpc('_is_mutual_follow', { p_other: NIL }));
expectRefused('anon cannot execute _can_tag', await rpc('_can_tag', { p_tagged: NIL }));

// The same rule again, and this one was granted by mistake and revoked by
// 20260819000200. Given two ids known to name active accounts, a `false` from it means
// a block between two strangers — the one thing `blocks_read` exists to keep in.
// Probed against the deployed database rather than only in the local harness, because
// what matters is the grant that is actually in place.
expectRefused(
  'anon cannot execute can_discover_profile',
  await rpc('can_discover_profile', { viewer: NIL, subject: NIL }),
);

// Maintenance actions are service_role only. The anon key is a valid JWT, so
// verify_jwt lets it through and resolveCaller is what stops it — which means this
// probe is testing the function's own logic rather than the platform's.
{
  const res = await fetch(`${url}/functions/v1/tmdb-adapter`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'enrich', limit: 1 }),
  });
  const body = await res.text();
  report(
    'anon cannot trigger a bulk enrichment',
    res.status === 401 || res.status === 403 ? 'pass' : 'fail',
    `${res.status} ${body.slice(0, 200)}`,
  );
}

// The one thing the local suite structurally cannot check: citext is shimmed as a
// domain in PGlite, so no local function carries an extension dependency and the
// pg_depend exclusion that keeps 20260813001800's sweep off citext's operator
// functions is never exercised. If that predicate were wrong, username lookups
// would break for anon here and nowhere else.
{
  const res = await get('profiles?select=id&username=eq.nobody-should-exist');
  report(
    'anon can still compare a citext username',
    res.status === 200 ? 'pass' : 'fail',
    `${res.status} ${res.body.slice(0, 200)}`,
  );
}

const total = passed + failures.length + inconclusive.length;
console.log(`\n${passed}/${total} passed, ${failures.length} failed, ${inconclusive.length} inconclusive\n`);

// An inconclusive result is a probe that never ran: PostgREST could not resolve the
// signature, so the privilege behind it is untested. Exiting zero on those turned
// the suite into a wiring test for its own argument names — drift a parameter and
// the function silently stops being checked while the run still looks green. A
// probe that cannot reach its target is a failure of the probe.
if (inconclusive.length > 0) {
  console.log('Inconclusive probes never reached their function, so nothing was verified:');
  for (const probe of inconclusive) console.log(`  - ${probe.name}`);
  console.log('');
}

process.exit(failures.length === 0 && inconclusive.length === 0 ? 0 : 1);
