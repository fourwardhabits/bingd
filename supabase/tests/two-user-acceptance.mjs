/**
 * The founder's two-user gate, run against the deployed nonprod database.
 *
 *   node supabase/tests/two-user-acceptance.mjs
 *
 * WHY THIS EXISTS ALONGSIDE EVERYTHING ELSE
 *
 * The local suite runs migrations in PGlite as the table owner, and every test that
 * needed a relationship inserted the row directly. That is exactly how it went
 * unnoticed for a fortnight that `follows` and `blocks` had **no writers at all**
 * (20260817000200): the whole visibility architecture was verified against edges no
 * user could create. `remote-smoke.mjs` closes the other half — it probes the deployed
 * PostgREST surface — but only ever signed out.
 *
 * This is the missing third: **two real accounts, two real JWTs, every call through
 * PostgREST**, doing to each other exactly what two beta testers would do. Nothing here
 * runs as `service_role` except creating and destroying the two accounts, and that is
 * deliberate — a check that runs as the owner cannot fail the way a user can.
 *
 * SAFETY
 *
 * Both accounts are created fresh with a run-scoped handle and deleted at the end,
 * through `delete_account` itself rather than through the admin API — so the teardown
 * is also the test of the deletion path. Nothing touches the founder's account or any
 * existing row: every title it ranks is one it looks up, and every edge it creates is
 * between the two accounts it made.
 *
 * WHAT A FAILURE MEANS
 *
 * A failing negative case is a **security finding**, not a flaky test. The negative
 * half of this file is the part that matters: a private account staying invisible, a
 * block severing both directions, a comment on an event the caller may not see being
 * refused with the same error as a comment on an event that does not exist.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadEnv(file) {
  const out = {};
  for (const line of readFileSync(join(root, file), 'utf8').split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2];
  }
  return out;
}

const env = { ...loadEnv('.env'), ...loadEnv('.env.local') };
const url = env.EXPO_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL;
const anonKey = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceKey) {
  console.error('Need EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// The one guard rail that matters. These scripts create and delete accounts and send
// the service-role key to whatever `url` says, so the check has to be on the *host* and
// not on the string. Independent review 15: `url.includes(ref)` passes for
// `https://<ref>.example.com`, which is a hostname anybody can register — and the next
// thing that happens is the service-role key being posted to it.
const NONPROD_HOST = 'abheeqyjzekiowkztfxv.supabase.co';
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

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`pass          ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`FAIL          ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const rpc = async (token, name, args) => {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args ?? {}),
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
};

const get = async (token, path) => {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const uuid = () => crypto.randomUUID();

/**
 * Ranks one title to completion, the way the app does.
 *
 * `set_bucket` puts a title in a band; it is **`_rank_finalize` that writes the feed
 * event**, and that only runs when an insertion session converges. The first version of
 * this file seeded buckets and then failed three checks downstream on an empty feed,
 * which is the same lesson the whole run keeps relearning: a write that was not asserted
 * is a write that did not happen.
 *
 * `decide` picks the winner of each comparison. Always choosing the new title inserts
 * it at the top of its band, which is deterministic and enough for two accounts to
 * overlap on eight films.
 */
const rankToCompletion = async (token, mediaItemId, bucket) => {
  let result = await rpc(token, 'rank_start', {
    p_media_item_id: mediaItemId,
    p_bucket: bucket,
  });
  if (result.status !== 200) return { ok: false, result };

  let state = result.body;
  for (let comparisons = 0; state && !state.done; comparisons += 1) {
    if (comparisons > 64) return { ok: false, result: { body: 'did not converge' } };
    const answer = await rpc(token, 'rank_answer', {
      p_session_id: state.session_id,
      p_winner: mediaItemId,
    });
    if (answer.status !== 200) return { ok: false, result: answer };
    state = answer.body;
  }
  return { ok: Boolean(state?.done), result: state };
};

// ---------------------------------------------------------------------------
// Two accounts, created and destroyed by this run
// ---------------------------------------------------------------------------

const stamp = Date.now().toString(36).slice(-6);

/**
 * Every auth user this run has created, recorded the instant it exists.
 *
 * Independent review 15: `a` and `b` were assigned only after sign-in and profile
 * creation succeeded, so a failure in between left an account in the project that the
 * `finally` block had no id for. The id is the only thing needed to clean up, and it is
 * known before any of the steps that can fail.
 */
const created = [];

async function createAccount(label) {
  const email = `bingd_accept_${label}_${stamp}@example.com`;
  const password = `Accept-${uuid()}`;

  const response = await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!response.ok) throw new Error(`could not create ${label}: ${await response.text()}`);
  const user = await response.json();
  created.push(user.id);

  const session = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!session.ok) throw new Error(`could not sign in ${label}: ${await session.text()}`);
  const { access_token: token } = await session.json();

  const username = `acc_${label}_${stamp}`.toLowerCase().slice(0, 24);
  const profile = await rpc(token, 'create_profile', {
    p_username: username,
    p_display_name: `Acceptance ${label.toUpperCase()}`,
    p_date_of_birth: '1990-01-01',
  });
  if (profile.status !== 200 || profile.body?.ok !== true) {
    throw new Error(`could not create profile for ${label}: ${JSON.stringify(profile)}`);
  }

  return { id: user.id, email, token, username, label };
}

/** Removes an account through `delete_account`, so the teardown tests the real path. */
async function destroyAccount(account) {
  if (!account) return;
  const result = await rpc(account.token, 'delete_account', {
    p_confirmation: account.username,
  });
  // No admin fallback here. The loop in the `finally` block below sweeps every id this
  // run created, checks the response, and reports a failure to clean up as a failure —
  // which the fallback that used to live here did not.
  if (result.status !== 200) return { deleted: false, result };
  return { deleted: true, result };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

let a;
let b;

try {
  console.log(`Two-user acceptance against ${url}\n`);

  a = await createAccount('a');
  b = await createAccount('b');
  console.log(`A = @${a.username}   B = @${b.username}\n`);

  // Titles both of them can rank, taken from the deployed catalogue rather than
  // created — this run adds no rows to `media_items`.
  const catalogue = await get(a.token, 'media_items?kind=eq.movie&select=id,title&limit=12');
  const films = catalogue.body ?? [];
  check('the catalogue is readable by a signed-in account', films.length >= 8, `${films.length} films`);

  // -------------------------------------------------------------------------
  console.log('\n— A finds B and follows them —');
  // -------------------------------------------------------------------------

  const found = await rpc(a.token, 'search_users', { p_query: b.username, p_limit: 10 });
  check(
    'A finds B through user search',
    found.status === 200 && (found.body ?? []).some((row) => row.username === b.username),
    JSON.stringify(found.body)?.slice(0, 120),
  );

  const profileOfB = await get(a.token, `public_profiles?username=eq.${b.username}&select=id,username`);
  check('A can open B’s public profile', (profileOfB.body ?? []).length === 1);

  const follow = await rpc(a.token, 'follow', { p_operation_id: uuid(), p_followee_id: b.id });
  check(
    'A follows B, and a public account is approved outright',
    follow.status === 200 && follow.body?.state === 'approved',
    JSON.stringify(follow.body),
  );

  const bInbox = await rpc(b.token, 'my_notifications', { p_limit: 20 });
  check(
    'B is told, and the row names A',
    bInbox.status === 200 &&
      (bInbox.body ?? []).some((row) => row.kind === 'follow' && row.actor_username === a.username),
    JSON.stringify(bInbox.body)?.slice(0, 200),
  );

  // -------------------------------------------------------------------------
  console.log('\n— B ranks things, A sees them —');
  // -------------------------------------------------------------------------

  // Enough shared titles for Taste Match, which needs five in common.
  const shared = films.slice(0, 8);
  let seeded = 0;
  const seededErrors = [];
  for (const [index, film] of shared.entries()) {
    await rpc(b.token, 'log_watched', {
      p_operation_id: uuid(),
      p_media_item_id: film.id,
      p_watched_on: '2026-08-01',
      p_note: index === 0 ? 'A note of B’s, public.' : null,
      p_note_visibility: 'public',
      p_note_spoilers: false,
    });
    const rankedByB = await rankToCompletion(b.token, film.id, index < 4 ? 'loved' : 'fine');
    if (!rankedByB.ok) seededErrors.push(JSON.stringify(rankedByB.result).slice(0, 120));
    await rpc(a.token, 'log_watched', {
      p_operation_id: uuid(),
      p_media_item_id: film.id,
      p_watched_on: '2026-08-02',
      p_note: null,
      p_note_visibility: 'private',
      p_note_spoilers: false,
    });
    // Counted rather than assumed. PostgREST answers an argument-name mismatch with a
    // 404, so a fire-and-forget seed is indistinguishable from one that wrote nothing
    // — which is precisely how the first run of this file reported an empty feed
    // three checks later instead of a broken call here.
    const rankedByA = await rankToCompletion(a.token, film.id, index < 5 ? 'loved' : 'fine');
    if (rankedByA.ok) seeded += 1;
    else seededErrors.push(JSON.stringify(rankedByA.result).slice(0, 120));
  }
  check(
    'the seed ranked what it meant to, on both sides',
    seeded === shared.length && seededErrors.length === 0,
    `${seeded}/${shared.length}; ${seededErrors.slice(0, 2).join(' | ')}`,
  );

  const feed = await get(
    a.token,
    `feed_events?actor_id=eq.${b.id}&select=id,type,media_item_id&order=created_at.desc&limit=20`,
  );
  const events = feed.body ?? [];
  check('A sees B’s activity now that they follow them', events.length > 0, `${events.length} events`);

  const taste = await rpc(a.token, 'taste_match', { p_user_id: b.id });
  const match = (taste.body ?? [])[0] ?? taste.body;
  check(
    'A sees a Taste Match with B once there is overlap',
    taste.status === 200 && match && match.common_count >= 5 && match.score !== null,
    JSON.stringify(match),
  );

  // -------------------------------------------------------------------------
  console.log('\n— A reacts and comments, and can edit and delete their own —');
  // -------------------------------------------------------------------------

  const event = events[0];
  const reaction = await rpc(a.token, 'set_reaction', {
    p_operation_id: uuid(),
    p_feed_event_id: event.id,
    p_kind: 'love',
  });
  check('A reacts to B’s activity', reaction.status === 200 && reaction.body?.status === 'ok');

  const comment = await rpc(a.token, 'add_comment', {
    p_operation_id: uuid(),
    p_feed_event_id: event.id,
    p_body: 'A said something.',
    p_has_spoilers: false,
  });
  const commentId = comment.body?.comment_id;
  check('A comments on it', comment.status === 200 && Boolean(commentId), JSON.stringify(comment.body));

  const edited = await rpc(a.token, 'edit_comment', {
    p_operation_id: uuid(),
    p_comment_id: commentId,
    p_body: 'A said something else.',
    p_has_spoilers: false,
  });
  check('A edits their own comment', edited.status === 200);

  const bSeesComment = await get(
    b.token,
    `comments?feed_event_id=eq.${event.id}&select=id,body,author_id`,
  );
  check(
    'B can read the comment on their own activity',
    (bSeesComment.body ?? []).some((row) => row.id === commentId),
  );

  const bInboxAfter = await rpc(b.token, 'my_notifications', { p_limit: 30 });
  check(
    'B’s inbox carries the reaction and the comment, with the title named',
    (bInboxAfter.body ?? []).some((row) => row.kind === 'reaction') &&
      (bInboxAfter.body ?? []).some((row) => row.kind === 'comment' && row.media_title),
    JSON.stringify((bInboxAfter.body ?? []).map((r) => [r.kind, r.media_title])).slice(0, 200),
  );

  // -------------------------------------------------------------------------
  console.log('\n— B reciprocates —');
  // -------------------------------------------------------------------------

  const back = await rpc(b.token, 'follow', { p_operation_id: uuid(), p_followee_id: a.id });
  check('B follows A back', back.status === 200 && back.body?.state === 'approved');

  const bComment = await rpc(b.token, 'add_comment', {
    p_operation_id: uuid(),
    p_feed_event_id: event.id,
    p_body: 'And B replied on their own activity.',
    p_has_spoilers: false,
  });
  check('B comments on their own activity', bComment.status === 200);

  const notMine = await rpc(b.token, 'delete_comment', {
    p_operation_id: uuid(),
    p_comment_id: commentId,
  });
  check(
    'B cannot delete A’s comment',
    notMine.status >= 400 || notMine.body?.status !== 'ok',
    JSON.stringify(notMine.body),
  );

  const mine = await rpc(a.token, 'delete_comment', {
    p_operation_id: uuid(),
    p_comment_id: commentId,
  });
  check('A deletes their own comment', mine.status === 200);

  // -------------------------------------------------------------------------
  console.log('\n— B goes private —');
  // -------------------------------------------------------------------------

  const goPrivate = await rpc(b.token, 'set_profile_visibility', {
    p_operation_id: uuid(),
    p_visibility: 'private',
  });
  check('B can make their account private', goPrivate.status === 200);

  // A already follows B and stays approved: going private is not retroactive.
  const stillVisible = await get(a.token, `public_profiles?id=eq.${b.id}&select=id`);
  check('an approved follower keeps their access when the account goes private', (stillVisible.body ?? []).length === 1);

  const strangerSearch = await rpc(a.token, 'search_users', { p_query: b.username, p_limit: 10 });
  check(
    'and A, who follows them, can still find them',
    (strangerSearch.body ?? []).some((row) => row.username === b.username),
  );

  // -------------------------------------------------------------------------
  console.log('\n— the request flow, from a standing start —');
  // -------------------------------------------------------------------------

  await rpc(a.token, 'unfollow', { p_operation_id: uuid(), p_followee_id: b.id });

  const notFound = await rpc(a.token, 'search_users', { p_query: b.username, p_limit: 10 });
  check(
    'a private account is undiscoverable by name once you stop following them',
    !(notFound.body ?? []).some((row) => row.username === b.username),
    JSON.stringify(notFound.body)?.slice(0, 120),
  );

  const gone = await get(a.token, `public_profiles?id=eq.${b.id}&select=id`);
  check('and their profile is not readable', (gone.body ?? []).length === 0);

  const requested = await rpc(a.token, 'follow', { p_operation_id: uuid(), p_followee_id: b.id });
  check(
    'following a private account files a request rather than an edge',
    requested.status === 200 && requested.body?.state === 'pending',
    JSON.stringify(requested.body),
  );

  const requestInbox = await rpc(b.token, 'my_notifications', { p_limit: 30 });
  const theRequest = (requestInbox.body ?? []).find((row) => row.kind === 'follow_request');
  check(
    'B sees the request, with A named — the surface that did not exist before Phase F',
    Boolean(theRequest) && theRequest.actor_username === a.username,
  );

  const approved = await rpc(b.token, 'respond_follow_request', {
    p_operation_id: uuid(),
    p_requester_id: a.id,
    p_approve: true,
  });
  check('B approves it', approved.status === 200 && approved.body?.approved === true);

  const requestCleared = await rpc(b.token, 'my_notifications', { p_limit: 30 });
  check(
    'and the request stops asking',
    !(requestCleared.body ?? []).some((row) => row.kind === 'follow_request'),
  );

  const aTold = await rpc(a.token, 'my_notifications', { p_limit: 30 });
  check(
    'A is told they are in',
    (aTold.body ?? []).some((row) => row.kind === 'follow_approved' && row.actor_username === b.username),
  );

  const readable = await get(a.token, `public_profiles?id=eq.${b.id}&select=id`);
  check('and B’s profile is readable again', (readable.body ?? []).length === 1);

  // -------------------------------------------------------------------------
  console.log('\n— the negative half —');
  // -------------------------------------------------------------------------

  const bEvents = await get(a.token, `feed_events?actor_id=eq.${b.id}&select=id&limit=5`);
  const visibleEvent = (bEvents.body ?? [])[0];

  const blocked = await rpc(b.token, 'block', { p_operation_id: uuid(), p_blocked_id: a.id });
  check('B blocks A', blocked.status === 200);

  const afterBlockProfile = await get(a.token, `public_profiles?id=eq.${b.id}&select=id`);
  check('a blocked account is not readable by the person blocked', (afterBlockProfile.body ?? []).length === 0);

  const afterBlockReverse = await get(b.token, `public_profiles?id=eq.${a.id}&select=id`);
  check('nor the other way round — a block cuts both directions', (afterBlockReverse.body ?? []).length === 0);

  const afterBlockFeed = await get(a.token, `feed_events?actor_id=eq.${b.id}&select=id&limit=5`);
  check('and their activity is gone from A’s reach', (afterBlockFeed.body ?? []).length === 0);

  const followsAfterBlock = await rpc(a.token, 'follow_state_with', { p_user_ids: [b.id] });
  const edge = (followsAfterBlock.body ?? [])[0];
  check(
    'the follow was severed in both directions',
    edge && edge.following === null && edge.followed_by === null,
    JSON.stringify(edge),
  );

  check(
    'and A is not told they were blocked',
    edge && edge.blocked === false,
    'blocked:true would tell A that B blocked them',
  );

  const commentAfterBlock = await rpc(a.token, 'add_comment', {
    p_operation_id: uuid(),
    p_feed_event_id: visibleEvent?.id ?? uuid(),
    p_body: 'Should not land.',
    p_has_spoilers: false,
  });
  check(
    'a comment on an event A may no longer see is refused',
    commentAfterBlock.status >= 400,
    JSON.stringify(commentAfterBlock.body)?.slice(0, 120),
  );

  const commentOnNothing = await rpc(a.token, 'add_comment', {
    p_operation_id: uuid(),
    p_feed_event_id: uuid(),
    p_body: 'Should not land either.',
    p_has_spoilers: false,
  });
  check(
    'and it is the same refusal as an event that does not exist',
    commentOnNothing.status === commentAfterBlock.status &&
      JSON.stringify(commentOnNothing.body?.message ?? commentOnNothing.body) ===
        JSON.stringify(commentAfterBlock.body?.message ?? commentAfterBlock.body),
    `${JSON.stringify(commentAfterBlock.body)} vs ${JSON.stringify(commentOnNothing.body)}`,
  );

  const tasteAfterBlock = await rpc(a.token, 'taste_match', { p_user_id: b.id });
  const blockedMatch = (tasteAfterBlock.body ?? [])[0] ?? tasteAfterBlock.body;
  check(
    'Taste Match returns the insufficient shape rather than a number',
    tasteAfterBlock.status === 200 && blockedMatch && blockedMatch.score === null && blockedMatch.common_count === 0,
    JSON.stringify(blockedMatch),
  );

  const followingAfterBlock = await rpc(a.token, 'following_score', {
    p_media_item_id: shared[0].id,
  });
  const score = (followingAfterBlock.body ?? [])[0] ?? followingAfterBlock.body;
  check(
    'the Following score no longer counts them',
    followingAfterBlock.status === 200 && (score?.rating_count ?? 0) === 0,
    JSON.stringify(score),
  );

  const searchAfterBlock = await rpc(a.token, 'search_users', { p_query: b.username, p_limit: 10 });
  check(
    'and they are not findable by name',
    !(searchAfterBlock.body ?? []).some((row) => row.username === b.username),
  );

  const blockList = await rpc(b.token, 'my_blocks', {});
  check(
    'B can see who they blocked, which is the only surface that names them',
    (blockList.body ?? []).some((row) => row.username === a.username),
  );

  const aBlockList = await rpc(a.token, 'my_blocks', {});
  check(
    'and A’s own list is empty, because it answers "who have I blocked"',
    (aBlockList.body ?? []).length === 0,
  );

  const followWhileBlocked = await rpc(a.token, 'follow', {
    p_operation_id: uuid(),
    p_followee_id: b.id,
  });
  check(
    'A cannot follow their way back in',
    followWhileBlocked.status >= 400,
    JSON.stringify(followWhileBlocked.body)?.slice(0, 120),
  );

  await rpc(b.token, 'unblock', { p_operation_id: uuid(), p_blocked_id: a.id });
  const afterUnblockEdge = await rpc(a.token, 'follow_state_with', { p_user_ids: [b.id] });
  check(
    'unblocking does not resurrect the follow it removed',
    (afterUnblockEdge.body ?? [])[0]?.following === null,
  );

  // -------------------------------------------------------------------------
  console.log('\n— suspension —');
  // -------------------------------------------------------------------------

  await fetch(`${url}/rest/v1/profiles?id=eq.${b.id}`, {
    method: 'PATCH',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ status: 'suspended' }),
  });

  const suspendedProfile = await get(a.token, `public_profiles?id=eq.${b.id}&select=id`);
  check('a suspended account leaves every read surface', (suspendedProfile.body ?? []).length === 0);

  const suspendedWrite = await rpc(b.token, 'add_comment', {
    p_operation_id: uuid(),
    p_feed_event_id: event.id,
    p_body: 'Suspended accounts do not write.',
    p_has_spoilers: false,
  });
  check('and cannot write', suspendedWrite.status >= 400, JSON.stringify(suspendedWrite.body)?.slice(0, 120));

  const suspendedRead = await rpc(b.token, 'my_notifications', { p_limit: 5 });
  check('but can still read their own inbox', suspendedRead.status === 200);

  // -------------------------------------------------------------------------
  console.log('\n— leaving —');
  // -------------------------------------------------------------------------

  const wrongHandle = await rpc(b.token, 'delete_account', { p_confirmation: a.username });
  check(
    'deletion refuses somebody else’s handle',
    wrongHandle.status >= 400,
    JSON.stringify(wrongHandle.body)?.slice(0, 120),
  );

  const bGone = await destroyAccount(b);
  check(
    'a suspended account can still delete itself',
    bGone?.deleted === true,
    JSON.stringify(bGone?.result?.body)?.slice(0, 160),
  );
  b = null;

  const bProfile = await get(a.token, `public_profiles?username=eq.acc_b_${stamp}&select=id`);
  check('and nothing of theirs is left to read', (bProfile.body ?? []).length === 0);

  const aInboxAfter = await rpc(a.token, 'my_notifications', { p_limit: 30 });
  check(
    'A’s inbox no longer names them',
    aInboxAfter.status === 200 &&
      !(aInboxAfter.body ?? []).some((row) => row.actor_username?.startsWith('acc_b_')),
  );

  const aGone = await destroyAccount(a);
  check('and A can leave too', aGone?.deleted === true, JSON.stringify(aGone?.result?.body)?.slice(0, 160));
  a = null;
} catch (cause) {
  failed += 1;
  failures.push(`the run itself: ${cause.message}`);
  console.error(`\nFAILED: ${cause.message}`);
} finally {
  await destroyAccount(a);
  await destroyAccount(b);

  // The backstop, from the ids rather than from the objects. Anything still standing
  // here is an account a failure left behind, and a leaked test account in a project
  // two people are about to test against is worse than a failing check.
  for (const id of created) {
    const res = await fetch(`${url}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    // 404 is the ordinary case: `delete_account` already removed it.
    if (!res.ok && res.status !== 404) {
      failed += 1;
      failures.push(`could not clean up auth user ${id}: ${res.status} ${await res.text()}`);
    }
  }
}

console.log(`\n${passed}/${passed + failed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const line of failures) console.log(`  · ${line}`);
}
process.exit(failed ? 1 : 0);
