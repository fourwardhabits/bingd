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
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { supabaseProjectRef } = require('../../config/backends.cjs');
const { environmentForRef } = require('../../config/production-lane.cjs');

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadEnv(file) {
  const out = {};
  for (const line of readFileSync(join(root, file), 'utf8').split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2];
  }
  return out;
}

/**
 * `.env` is nonprod's and is committed-adjacent; `.env.local` is git-ignored and overrides
 * it; the ambient environment overrides both.
 *
 * The last of those is new and is what makes a production run possible without writing
 * production credentials to a file on the founder's disk at all:
 *
 *   SUPABASE_URL=... EXPO_PUBLIC_SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node supabase/tests/two-user-acceptance.mjs --target production
 */
const env = { ...loadEnv('.env'), ...loadEnv('.env.local'), ...process.env };
const url = env.EXPO_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL;
const anonKey = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceKey) {
  console.error('Need EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

/**
 * The one guard rail that matters. This script creates and deletes accounts and sends the
 * service-role key to whatever `url` says, so the check has to be on the *parsed host* and
 * not on the string. Independent review 15: `url.includes(ref)` passes for
 * `https://<ref>.example.com`, which is a hostname anybody can register — and the next thing
 * that happens is the service-role key being posted to it.
 *
 * ---------------------------------------------------------------------------
 * IT RUNS AGAINST PRODUCTION NOW, AND ONLY WHEN ASKED IN SO MANY WORDS
 *
 * This was `host !== 'abheeqyjzekiowkztfxv.supabase.co'` and nothing else, which was right
 * while nonprod was the only deployed project. Public launch needs the same two-account
 * proof against production — signup, the under-13 refusal, privacy, block, ranking, review,
 * report, notification, push enqueue, deletion — and there is no other way to get it.
 *
 * So the target is named rather than inferred, and **three independent things have to agree**
 * before anything is written:
 *
 *   1. `--target production` on the command line. Nothing defaults to production.
 *   2. `config/production-lane.cjs` declares the project behind this URL to be production.
 *   3. the database itself answers `prod` to `environment_name()` — checked below, after the
 *      client is built, because a project that was replayed but never bootstrapped answers
 *      `nonprod` and is exactly the case this whole tranche exists to catch.
 *
 * Any two of those agreeing is not enough. The accounts this creates are real accounts in a
 * real database, and the teardown is `delete_account` — the same path a person's own deletion
 * takes — so a wrong target is not recoverable by re-running it.
 */
const targetArg = process.argv.includes('--target')
  ? process.argv[process.argv.indexOf('--target') + 1]
  : 'nonprod';

if (!['nonprod', 'production'].includes(targetArg)) {
  console.error(`--target must be nonprod or production, not "${targetArg}".`);
  process.exit(1);
}

/** What `environment_name()` has to answer. */
const expectedEnvironment = targetArg === 'production' ? 'prod' : 'nonprod';

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

  const ref = supabaseProjectRef(url);
  const declared = ref === null ? null : environmentForRef(ref);

  if (protocol !== 'https:' || host === null || declared === null) {
    console.error(
      `Refusing to run: ${url} is not a Supabase project this repository declares.\n` +
        '  REF_ENVIRONMENTS in config/production-lane.cjs is the list of projects that may\n' +
        '  receive a service-role key.',
    );
    process.exit(1);
  }

  if (declared !== expectedEnvironment) {
    console.error(
      `Refusing to run: --target ${targetArg} means the ${expectedEnvironment} database, and ` +
        `${ref} is declared ${declared}.\n` +
        '  This script creates and deletes real accounts. It does not guess which database.',
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];
const skipped = [];

/**
 * A check the deployed **catalogue** cannot support, as distinct from one that failed.
 *
 * There is exactly one legitimate use and it is worth naming, because "skip" is otherwise the
 * word a red suite gets turned green with. `bingd-nonprod` holds 1,027 movies and **zero**
 * `tv_season` and `tv_series` rows, so M2's season semantics cannot be exercised there at all
 * — not because anything is broken, but because the seed run that filled that project fetched
 * films only.
 *
 * Reporting that as a pass would be a lie; reporting it as a failure would leave the suite
 * permanently red for a data condition and teach everyone to ignore the number. So it is a
 * third outcome, printed on its own at the end, excluded from the pass count, and named in
 * `production-acceptance.md` as something a **production** run may not have any of.
 */
function skip(name, reason) {
  skipped.push(`${name} — ${reason}`);
  console.log(`skip          ${name}\n              ${reason}`);
}

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
// The third agreement: what the database calls itself
//
// The URL says which project, `config/production-lane.cjs` says what that project is meant
// to be, and this is the project's own answer. It is the one of the three that catches the
// bootstrap trap: a production project replayed from zero comes up calling itself `nonprod`
// (`20260826000100`), so a run that got this far on the strength of the other two would be
// creating accounts in a database that is still stamping every invite token `nonprod`.
//
// Before anything is written, because the first write is an account.
// ---------------------------------------------------------------------------

{
  const res = await fetch(`${url}/rest/v1/rpc/environment_name`, {
    method: 'POST',
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const text = await res.text();
  let answered = null;
  try {
    const parsed = JSON.parse(text);
    answered = typeof parsed === 'string' ? parsed : null;
  } catch {
    answered = null;
  }

  if (answered !== expectedEnvironment) {
    console.error(
      `Refusing to run: ${url} answers environment_name() = ${answered ?? `no answer (${res.status} ${text.slice(0, 160)})`}, ` +
        `and --target ${targetArg} needs ${expectedEnvironment}.\n\n` +
        '  A project replayed from zero calls itself nonprod until it is bootstrapped:\n' +
        `    node scripts/bootstrap-production.mjs --target ${targetArg} --apply\n`,
    );
    // A beat before exiting. `process.exit` while undici still holds a keep-alive socket
    // aborts libuv on Windows, and an assertion failure printed under a refusal reads as
    // this script crashing rather than as it declining to run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.exit(1);
  }
}

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

/**
 * Every email this run has used, whether or not its id was ever readable.
 *
 * Independent review 15b: the server can create the account and the *response* still
 * fail to parse — a truncated body, a proxy that ate it — and then nothing knows the
 * id. The email is chosen by this file before the request is made, so it is the one
 * handle that exists no matter what comes back.
 *
 * **Registered only once the create call has succeeded**, which review 15c was right to
 * insist on: an address is registered for deletion, not merely used. If `POST
 * /admin/users` conflicts because that address already exists — a reused stamp, a
 * previous run, somebody's real account — an eagerly registered email would make this
 * file delete an account it did not create. `response.ok` is checked before the push
 * and the body is parsed after it, so a successful creation with an unreadable response
 * is still covered.
 */
const emails = [];

/** Runs a cleanup step so that its failure cannot stop the next one. */
async function attempt(what, fn) {
  try {
    await fn();
  } catch (cause) {
    failed += 1;
    failures.push(`cleanup: ${what} — ${cause.message}`);
  }
}

/**
 * Deletes any account still holding one of this run's emails.
 *
 * **It paginates, and it does not trust `?filter=`.**
 *
 * This asked GoTrue for `?filter=<email>` and read the first page. Two things were assumed
 * there and neither is guaranteed: that the endpoint honours `filter` at all, and that a
 * match would be on the page it returned. Against nonprod, with four accounts, both held.
 * Against **production**, where this is the last thing standing between an interrupted run
 * and a disposable account left in a real database, a silent miss reports success — and this
 * path only runs at all when the id sweep could not, because a creation response was
 * unparseable.
 *
 * So `filter` is still sent as a hint, and the answer is checked rather than believed: pages
 * are walked to the end, and every row is matched on the full address. A page that comes back
 * short is the last one.
 */
async function sweepByEmail(email) {
  const PER_PAGE = 200;
  const MAX_PAGES = 500;
  const seen = [];
  let exhausted = false;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await fetch(
      `${url}/auth/v1/admin/users?page=${page}&per_page=${PER_PAGE}&filter=${encodeURIComponent(email)}`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    if (!res.ok) throw new Error(`could not look up ${email}: ${res.status}`);
    const { users = [] } = await res.json();

    // Matched exactly rather than on the partial filter, so this can never delete an
    // account that merely shares a prefix with a test address.
    for (const user of users) {
      if (user.email === email) seen.push(user);
    }

    if (users.length < PER_PAGE) {
      exhausted = true;
      break;
    }
  }

  // **The cap throws rather than returning quietly**, which is the difference between a
  // bound and a silent truncation. Reaching it means the listing was still going, so
  // "nothing found" would be a claim this function has no basis for — and this is the last
  // thing standing between an interrupted run and a disposable account left in a real
  // database. 100,000 accounts is far past the point where the founder would rather be told.
  if (!exhausted) {
    throw new Error(
      `stopped listing users after ${MAX_PAGES} pages while looking for ${email}. ` +
        'The account may still exist; delete it by hand and raise MAX_PAGES.',
    );
  }

  for (const user of seen) {
    const del = await fetch(`${url}/auth/v1/admin/users/${user.id}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    if (!del.ok && del.status !== 404) {
      throw new Error(`could not delete ${email}: ${del.status}`);
    }
  }
}

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
  // Between the status check and the parse. After it, so this file only ever sweeps an
  // address it was given; before it, so a body nobody can read still leaves a handle.
  emails.push(email);
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

  // A recommendation needs a mutual follow, and right now they are strangers. Refusals
  // come back as a 200 with a body, deliberately: `recommend_title` returns them so that
  // a refused attempt still costs a slot against the hourly ceiling, which a raise would
  // roll back along with the operation claim (independent review 18).
  const strangerSend = await rpc(a.token, 'recommend_title', {
    p_operation_id: uuid(),
    p_recipient_id: b.id,
    p_media_item_id: films[0].id,
  });
  check(
    'a stranger cannot be recommended to',
    strangerSend.status === 200 &&
      strangerSend.body?.status === 'refused' &&
      strangerSend.body?.reason === 'not_mutual',
    JSON.stringify(strangerSend.body),
  );

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

  // Reactions default **off** since 20260819000300 — the before-insert trigger drops
  // the row when the recipient has not asked for them, so without this the inbox
  // assertion below fails for a product reason rather than a wiring one. B opting in
  // is also the only place this script exercises the preference writer.
  const optIn = await rpc(b.token, 'set_notification_preference', {
    p_category: 'reactions',
    p_enabled: true,
  });
  check('B turns reaction notifications on', optIn.status === 200 && optIn.body?.enabled === true);

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

  // -------------------------------------------------------------------------
  console.log('\n— recommending, which needs both edges —');
  // -------------------------------------------------------------------------

  const gift = films[0];
  const second = films[1];

  const sent = await rpc(a.token, 'recommend_title', {
    p_operation_id: uuid(),
    p_recipient_id: b.id,
    p_media_item_id: gift.id,
  });
  check(
    'a mutual follow can be recommended to',
    sent.status === 200 && sent.body?.status === 'ok' && sent.body?.created === true,
    JSON.stringify(sent.body),
  );

  const bSentToYou = await rpc(b.token, 'recommendations_to_me', { p_limit: 20 });
  const gifted = (bSentToYou.body ?? []).find((row) => row.media_item_id === gift.id);
  check(
    'it lands in B’s Sent to you, naming A',
    bSentToYou.status === 200 && gifted && gifted.sender_username === a.username,
    JSON.stringify(bSentToYou.body)?.slice(0, 200),
  );
  check('and arrives unopened', Boolean(gifted) && gifted.opened_at === null, JSON.stringify(gifted));

  const recInbox = await rpc(b.token, 'my_notifications', { p_limit: 30 });
  const recRow = (recInbox.body ?? []).find(
    (row) => row.kind === 'recommendation' && row.subject_id === gift.id,
  );
  check(
    'B is told, and the row points at the exact title',
    Boolean(recRow) && recRow.actor_username === a.username && recRow.subject_type === 'media_item',
    JSON.stringify(recRow),
  );
  check(
    'and carries the kind, so the sentence can say which',
    Boolean(recRow) && recRow.media_kind === 'movie',
    JSON.stringify(recRow?.media_kind),
  );

  // The duplicate rule: one row per sender, recipient and exact title, for good.
  const again = await rpc(a.token, 'recommend_title', {
    p_operation_id: uuid(),
    p_recipient_id: b.id,
    p_media_item_id: gift.id,
  });
  check(
    're-sending the same title updates rather than duplicating',
    again.status === 200 && again.body?.status === 'ok' && again.body?.created === false,
    JSON.stringify(again.body),
  );

  const afterResend = await rpc(b.token, 'recommendations_to_me', { p_limit: 20 });
  check(
    'so B still has exactly one of it',
    (afterResend.body ?? []).filter((row) => row.media_item_id === gift.id).length === 1,
  );

  const noticesAfterResend = await rpc(b.token, 'my_notifications', { p_limit: 50 });
  check(
    'and was not told a second time',
    (noticesAfterResend.body ?? []).filter(
      (row) => row.kind === 'recommendation' && row.subject_id === gift.id,
    ).length === 1,
  );

  // Ordering: unopened first, newest within that.
  await rpc(a.token, 'recommend_title', {
    p_operation_id: uuid(),
    p_recipient_id: b.id,
    p_media_item_id: second.id,
  });

  const opened = await rpc(b.token, 'mark_recommendation_opened', {
    p_recommendation_id: gifted?.id,
  });
  check(
    'B can mark one opened',
    opened.status === 200 && opened.body?.opened === true,
    JSON.stringify(opened.body),
  );

  const openedTwice = await rpc(b.token, 'mark_recommendation_opened', {
    p_recommendation_id: gifted?.id,
  });
  check(
    'and a second call changes nothing',
    openedTwice.status === 200 && openedTwice.body?.opened === false,
    JSON.stringify(openedTwice.body),
  );

  const ordered = await rpc(b.token, 'recommendations_to_me', { p_limit: 20 });
  const orderedRows = ordered.body ?? [];
  check(
    'the unopened one sorts above the opened one',
    orderedRows.findIndex((row) => row.media_item_id === second.id) <
      orderedRows.findIndex((row) => row.media_item_id === gift.id),
    orderedRows
      .map((row) => `${row.media_item_id === gift.id ? 'gift' : 'other'}:${row.opened_at ? 'seen' : 'new'}`)
      .join(' '),
  );

  const senderOpen = await rpc(a.token, 'mark_recommendation_opened', {
    p_recommendation_id: gifted?.id,
  });
  check(
    'the sender cannot mark it opened on their behalf',
    senderOpen.status === 200 && senderOpen.body?.opened === false,
    JSON.stringify(senderOpen.body),
  );

  // A season is the canonical TV unit. A series is not a thing anybody watched, so it
  // is not a thing anybody can be told to watch (PRD §10).
  const seasonRows = await get(a.token, 'media_items?kind=eq.season&select=id,parent_id,title&limit=1');
  const season = (seasonRows.body ?? [])[0];
  if (season) {
    const sentSeason = await rpc(a.token, 'recommend_title', {
      p_operation_id: uuid(),
      p_recipient_id: b.id,
      p_media_item_id: season.id,
    });
    check(
      'an exact season can be recommended',
      sentSeason.body?.status === 'ok',
      JSON.stringify(sentSeason.body),
    );

    const withSeason = await rpc(b.token, 'recommendations_to_me', { p_limit: 20 });
    const seasonRow = (withSeason.body ?? []).find((row) => row.media_item_id === season.id);
    check(
      'and the row names the show it belongs to, not only "Season 2"',
      Boolean(seasonRow) && seasonRow.media_kind === 'season' && Boolean(seasonRow.series_title),
      JSON.stringify(seasonRow)?.slice(0, 200),
    );

    const sentSeries = await rpc(a.token, 'recommend_title', {
      p_operation_id: uuid(),
      p_recipient_id: b.id,
      p_media_item_id: season.parent_id,
    });
    check(
      'a whole series is refused',
      sentSeries.body?.status === 'refused' && sentSeries.body?.reason === 'not_recommendable',
      JSON.stringify(sentSeries.body),
    );
  } else {
    check('the deployed catalogue has a season to recommend', false, 'no season rows');
  }

  const selfSend = await rpc(a.token, 'recommend_title', {
    p_operation_id: uuid(),
    p_recipient_id: a.id,
    p_media_item_id: gift.id,
  });
  check(
    'and so is recommending to yourself',
    selfSend.body?.status === 'refused' && selfSend.body?.reason === 'yourself',
    JSON.stringify(selfSend.body),
  );

  // -------------------------------------------------------------------------
  console.log('\n— Who I watched with, on the same rule —');
  // -------------------------------------------------------------------------

  const tagged = await rpc(a.token, 'set_watch_tags', {
    p_operation_id: uuid(),
    p_media_item_id: shared[0].id,
    p_tagged_ids: [b.id],
  });
  check(
    'a mutual follow can be tagged as a companion',
    tagged.status === 200 && tagged.body?.status === 'ok',
    JSON.stringify(tagged.body),
  );

  const tagNotice = await rpc(b.token, 'my_notifications', { p_limit: 50 });
  check(
    'and they are told once',
    (tagNotice.body ?? []).filter((row) => row.kind === 'watch_tag').length === 1,
  );

  // -------------------------------------------------------------------------
  console.log('\n— the invite link —');
  // -------------------------------------------------------------------------

  const link = await rpc(a.token, 'create_invite_link', {
    p_operation_id: uuid(),
    p_media_item_id: gift.id,
  });
  check(
    'A can mint their one personal invite link',
    link.status === 200 && typeof link.body?.token === 'string' && link.body.token.length === 32,
    JSON.stringify(link.body),
  );

  const linkAgain = await rpc(a.token, 'create_invite_link', {
    p_operation_id: uuid(),
    p_media_item_id: null,
  });
  check(
    'and asking again returns the same link rather than rotating it',
    linkAgain.body?.token === link.body?.token,
    `${link.body?.token} vs ${linkAgain.body?.token}`,
  );

  const myCreations = await get(
    a.token,
    'invite_link_creations?select=id,media_item_id&order=created_at.asc',
  );
  check(
    'each creation is recorded, with the title that was in view',
    (myCreations.body ?? []).length === 2 &&
      myCreations.body[0].media_item_id === gift.id &&
      myCreations.body[1].media_item_id === null,
    JSON.stringify(myCreations.body)?.slice(0, 200),
  );

  const theirCreations = await get(
    b.token,
    `invite_link_creations?inviter_id=eq.${a.id}&select=id`,
  );
  check(
    'and nobody can count somebody else’s',
    (theirCreations.body ?? []).length === 0,
    JSON.stringify(theirCreations.body)?.slice(0, 120),
  );

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
  console.log('\n— the age gate —');
  //
  // Added 2026-08-26 for the public-launch acceptance. **The under-13 refusal is a legal
  // property, not a product one**, and it is the one check in this file whose failure is
  // an immediate stop-the-launch rather than a bug — so it is proved against the deployed
  // database with a real session rather than left to the local suite.
  //
  // A third account, created and destroyed inside this block, because it must reach the
  // point of having a session and no profile. `created`/`emails` carry it into the same
  // teardown as A and B either way.
  // -------------------------------------------------------------------------
  {
    /**
     * Two accounts, not one, and the reason is a real property of the refusal.
     *
     * **`create_profile` deletes the `auth.users` row when it refuses an under-13 date.**
     * (`20260813002200`; `20260815030000` §avatars and `20260817000600` both reference the
     * same mechanism.) So the session that was refused no longer has an account behind it,
     * and re-using it for the over-13 control fails with a foreign-key violation rather than
     * with anything about age — which is what the first version of this block did, and it
     * looked exactly like a broken age gate.
     */
    const signUp = async (suffix) => {
      const email = `bingd-acceptance-${suffix}-${stamp}@example.invalid`;
      const password = `Acc!${stamp}${Math.random().toString(36).slice(2, 10)}`;

      const response = await fetch(`${url}/auth/v1/admin/users`, {
        method: 'POST',
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, email_confirm: true }),
      });
      if (!response.ok) throw new Error(`could not create ${suffix}: ${await response.text()}`);
      emails.push(email);
      created.push((await response.json()).id);

      const session = await fetch(`${url}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      return (await session.json()).access_token;
    };

    /** Ages computed rather than hardcoded, or this quietly tests a fifteen-year-old in 2028. */
    const birthday = (years, months = 0) => {
      const d = new Date();
      d.setUTCFullYear(d.getUTCFullYear() - years);
      d.setUTCMonth(d.getUTCMonth() - months);
      return d.toISOString().slice(0, 10);
    };

    const tooYoung = await rpc(await signUp('young'), 'create_profile', {
      p_username: `acc_y_${stamp}`.toLowerCase().slice(0, 24),
      p_display_name: 'Acceptance Young',
      p_date_of_birth: birthday(12, 11), // twelve years and eleven months
    });
    check(
      'an account under 13 is refused a profile',
      tooYoung.status >= 400 || tooYoung.body?.ok !== true,
      JSON.stringify(tooYoung.body)?.slice(0, 160),
    );

    // The control. Without it the refusal above passes just as well against a create_profile
    // that refuses everything.
    const oldEnoughToken = await signUp('old');
    const oldEnoughHandle = `acc_o_${stamp}`.toLowerCase().slice(0, 24);
    const oldEnough = await rpc(oldEnoughToken, 'create_profile', {
      p_username: oldEnoughHandle,
      p_display_name: 'Acceptance Old Enough',
      p_date_of_birth: birthday(13),
    });
    check(
      'and exactly 13 today is not',
      oldEnough.status === 200 && oldEnough.body?.ok === true,
      JSON.stringify(oldEnough.body)?.slice(0, 160),
    );

    // DOB-1: the date is retained privately and reaches no social surface. Read from another
    // account's position, which is the one that matters.
    const publicRow = await get(a.token, `public_profiles?username=eq.${oldEnoughHandle}&select=*`);
    const columns = Object.keys((publicRow.body ?? [])[0] ?? {});
    check(
      'and the date of birth is on no public column',
      columns.length > 0 && !columns.some((c) => /dob|birth/i.test(c)),
      columns.join(', ') || 'the profile was not readable — fixture problem, not a pass',
    );

    const gone = await rpc(oldEnoughToken, 'delete_account', { p_confirmation: oldEnoughHandle });
    check('and the age-gate account cleans itself up', gone.status === 200);
  }

  // -------------------------------------------------------------------------
  console.log('\n— ranking again, and a season —');
  //
  // M2 and M3, proved against the deployed database. `rank_again` is one RPC rather than
  // `rank_unrank` + `rank_start`, which is the whole point of `20260825000200`: the pair
  // could leave a title logged, in its bucket, with no position.
  // -------------------------------------------------------------------------
  {
    const mine = await get(a.token, 'user_media?select=media_item_id,bucket&bucket=not.is.null&limit=1');
    const first = (mine.body ?? [])[0];
    check('A has something ranked to rank again', Boolean(first));

    if (first) {
      const again = await rpc(a.token, 'rank_again', {
        p_media_item_id: first.media_item_id,
        p_bucket: first.bucket,
        p_operation_id: uuid(),
      });
      check(
        'Rank Again opens a session in one call',
        again.status === 200 && (again.body?.session_id || again.body?.done === true),
        JSON.stringify(again.body)?.slice(0, 160),
      );

      // And it converges, so the title is never left without a position.
      let state = again.body;
      for (let i = 0; state && !state.done && i < 64; i += 1) {
        const answer = await rpc(a.token, 'rank_answer', {
          p_session_id: state.session_id,
          p_winner: first.media_item_id,
          p_operation_id: uuid(),
        });
        state = answer.body;
      }
      check('and it converges rather than stranding the title', state?.done === true);

      // `position` is on `rankings`, not on `user_media` — the split between the two
      // tables is deliberate, and reading the wrong one turns "it still has a position"
      // into a check that cannot fail.
      const after = await get(
        a.token,
        `rankings?select=position,bucket&media_item_id=eq.${first.media_item_id}`,
      );
      const placed = (after.body ?? [])[0];
      check(
        'the title still has a position and the same bucket',
        typeof placed?.position === 'number' && placed.bucket === first.bucket,
        JSON.stringify(placed),
      );
    }

    // A season is rankable; a whole series is not (AD-1). The negative half is the one
    // worth having — the catalogue may hold no season at all, which is a skip rather than
    // a pass, so both are reported honestly.
    const seasons = await get(a.token, 'media_items?kind=eq.tv_season&select=id,title&limit=1');
    const season = (seasons.body ?? [])[0];
    if (!season) {
      skip(
        'a season can be ranked',
        'this project holds no tv_season rows. `npm run seed:fetch` fetches series and ' +
          'seasons, and the run that filled bingd-nonprod fetched films only — so M2 has ' +
          'never been exercised against a deployed database. A production catalogue with ' +
          'no television is a launch decision, not a test condition.',
      );
    } else {
      const started = await rpc(a.token, 'rank_start', {
        p_media_item_id: season.id,
        p_bucket: 'liked',
        p_operation_id: uuid(),
      });
      check(
        'a season can be ranked',
        started.status === 200,
        JSON.stringify(started.body)?.slice(0, 160),
      );
    }

    const series = await get(a.token, 'media_items?kind=eq.tv_series&select=id&limit=1');
    const show = (series.body ?? [])[0];
    if (!show) {
      skip('but a whole series is refused', 'this project holds no tv_series rows either');
    } else {
      const refused = await rpc(a.token, 'rank_start', {
        p_media_item_id: show.id,
        p_bucket: 'liked',
        p_operation_id: uuid(),
      });
      check('but a whole series is refused', refused.status >= 400, JSON.stringify(refused.body)?.slice(0, 120));
    }
  }

  // -------------------------------------------------------------------------
  console.log('\n— a review, a private note, and reporting both —');
  //
  // M1, end to end on the deployed database: the two writing surfaces a stranger can see,
  // and the report path that is the whole reason `20260825000100` exists. NR-1 is checked
  // beside it — new unspecified text defaults private **server-side**, not in the client.
  // -------------------------------------------------------------------------
  {
    const mine = await get(a.token, 'user_media?select=media_item_id&limit=1');
    const titleId = (mine.body ?? [])[0]?.media_item_id;
    check('A has a logged title to write about', Boolean(titleId));

    if (titleId) {
      // No visibility given at all. NR-1: the server decides, and it decides private.
      const unspecified = await rpc(a.token, 'save_note', {
        p_operation_id: uuid(),
        p_media_item_id: titleId,
        p_note: 'Acceptance run: an unspecified note.',
        p_base_updated_at: null,
        p_note_visibility: null,
        p_note_spoilers: null,
      });
      check('an unspecified note is accepted', unspecified.status === 200, JSON.stringify(unspecified.body)?.slice(0, 160));

      const stored = await get(a.token, `user_media?select=note_visibility&media_item_id=eq.${titleId}`);
      check(
        'and the server defaults it to private, not the client',
        (stored.body ?? [])[0]?.note_visibility === 'private',
        JSON.stringify((stored.body ?? [])[0]),
      );

      // B must not be able to read it, which is the property the default exists for.
      const bSees = await rpc(b.token, 'public_notes', {
        p_user_ids: [a.id],
        p_media_item_ids: [titleId],
        p_limit: 10,
      });
      check(
        'and nobody else can read a private note',
        bSees.status === 200 && (bSees.body ?? []).length === 0,
        JSON.stringify(bSees.body)?.slice(0, 160),
      );

      // Then a real Review — a note somebody chose to publish — and the report on it.
      const published = await rpc(a.token, 'save_note', {
        p_operation_id: uuid(),
        p_media_item_id: titleId,
        p_note: 'Acceptance run: a published review.',
        p_base_updated_at: null,
        p_note_visibility: 'public',
        p_note_spoilers: false,
      });
      check('a note can be published as a Review', published.status === 200, JSON.stringify(published.body)?.slice(0, 160));

      const reviewRow = await get(a.token, `user_media?select=id&media_item_id=eq.${titleId}`);
      const reviewId = (reviewRow.body ?? [])[0]?.id;

      const reported = await rpc(b.token, 'report', {
        p_subject_type: 'review',
        p_subject_id: reviewId,
        p_reason: 'other',
      });
      check(
        'and somebody else can report it',
        reported.status === 200,
        JSON.stringify(reported.body)?.slice(0, 160),
      );

      // Reporting your own writing is not a moderation action, and the refusal is what
      // stops the queue filling with self-reports.
      const own = await rpc(a.token, 'report', {
        p_subject_type: 'review',
        p_subject_id: reviewId,
        p_reason: 'other',
      });
      check('but not their own', own.status >= 400, JSON.stringify(own.body)?.slice(0, 120));
    }

    // A comment, and the report on that. B's activity is readable by A at this point in
    // the run, which is why the comment goes this direction.
    // `feed_events` read directly, the way the rest of this file does it. There is no
    // `following_activity` RPC to reach for, and an RPC name that does not resolve answers
    // 404 — which reads here as "no events" and turns the checks below into nothing.
    const bEvents = await get(
      a.token,
      `feed_events?actor_id=eq.${b.id}&select=id&order=created_at.desc&limit=1`,
    );
    const event = (bEvents.body ?? [])[0];
    check('there is an event of B’s to comment on', Boolean(event?.id), JSON.stringify(bEvents.body)?.slice(0, 120));

    if (event?.id) {
      const commented = await rpc(a.token, 'add_comment', {
        p_operation_id: uuid(),
        p_feed_event_id: event.id,
        p_body: 'Acceptance run: a reportable comment.',
        p_has_spoilers: false,
      });
      const commentId = commented.body?.comment_id;
      check('a comment can be written', commented.status === 200, JSON.stringify(commented.body)?.slice(0, 160));

      if (commentId) {
        const reported = await rpc(b.token, 'report', {
          p_subject_type: 'comment',
          p_subject_id: commentId,
          p_reason: 'other',
        });
        check('and reported', reported.status === 200, JSON.stringify(reported.body)?.slice(0, 160));
      }
    }
  }

  // -------------------------------------------------------------------------
  console.log('\n— a notification becomes a queued push —');
  //
  // The half of T3 no client-side check can see. `push_outbox` has no client surface at
  // all — no policy, no grant — so this reads it as `service_role`, which is the only
  // position from which the enqueue is observable.
  //
  // The point is the *coupling*: a notification of an eligible type, for a recipient with
  // a live device, produces a row; and the preference gate suppresses the push by
  // suppressing the notification rather than by a second check.
  // -------------------------------------------------------------------------
  {
    const asService = async (path) => {
      const res = await fetch(`${url}/rest/v1/${path}`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };

    const token = `ExponentPushToken[acceptance-${stamp}]`;
    const registered = await rpc(a.token, 'register_device_token', {
      p_operation_id: uuid(),
      p_token: token,
      p_platform: 'ios',
    });
    check('a device can be registered for push', registered.status === 200, JSON.stringify(registered.body)?.slice(0, 160));

    // B follows A back by this point, so B's `following_activity` is A's events — which is
    // how a comment *from B on A's activity* is arranged, and `comment` is an eligible push
    // type. There is no `my_activity` RPC; reaching for one is how this check first came to
    // silently not run at all.
    const before = await asService(`push_outbox?select=notification_id&recipient_id=eq.${a.id}`);
    const aEvents = await get(
      b.token,
      `feed_events?actor_id=eq.${a.id}&select=id&order=created_at.desc&limit=1`,
    );
    const aEvent = (aEvents.body ?? [])[0];

    check(
      'B can see an event of A’s to comment on',
      Boolean(aEvent?.id),
      `${aEvents.status} ${JSON.stringify(aEvents.body)?.slice(0, 160)}`,
    );

    if (aEvent?.id) {
      const commented = await rpc(b.token, 'add_comment', {
        p_operation_id: uuid(),
        p_feed_event_id: aEvent.id,
        p_body: 'Acceptance run: a comment that should buzz a phone.',
        p_has_spoilers: false,
      });
      check('and comment on it', commented.status === 200, JSON.stringify(commented.body)?.slice(0, 160));

      const after = await asService(`push_outbox?select=notification_id&recipient_id=eq.${a.id}`);
      check(
        'and a notification for them lands in the push outbox',
        (after.body ?? []).length > (before.body ?? []).length,
        `${(before.body ?? []).length} → ${(after.body ?? []).length} queued for A`,
      );
    }

    // The outbox is not a client surface, asserted rather than assumed — a grant added by
    // accident would be a table of other people's device addresses.
    const asA = await get(a.token, 'push_outbox?select=notification_id&limit=1');
    check(
      'and the outbox is unreadable by the account it is about',
      asA.status >= 400 || (asA.body ?? []).length === 0,
      `${asA.status} ${JSON.stringify(asA.body)?.slice(0, 120)}`,
    );

    const released = await rpc(a.token, 'revoke_device_token', { p_operation_id: uuid(), p_token: token });
    check('and the device can be released again', released.status === 200);
  }

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

  // 20260819000100 separated *being found* from *being read*, because one setting was
  // carrying two meanings: private used to make an account unfindable, so the only way
  // to be found was to publish your collection. A private account is now discoverable
  // by identity — which is what makes the request below possible at all — and it is
  // the content that stays gated. This assertion was the old rule and was inverted on
  // 2026-08-19; the pair of checks is the current one.
  const stillFound = await rpc(a.token, 'search_users', { p_query: b.username, p_limit: 10 });
  check(
    'a private account stays findable by name after you stop following them',
    (stillFound.body ?? []).some((row) => row.username === b.username),
    JSON.stringify(stillFound.body)?.slice(0, 120),
  );

  const gone = await get(a.token, `public_profiles?id=eq.${b.id}&select=id`);
  check('but their profile is not readable', (gone.body ?? []).length === 0);

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

  const recommendWhileBlocked = await rpc(a.token, 'recommend_title', {
    p_operation_id: uuid(),
    p_recipient_id: b.id,
    p_media_item_id: shared[0].id,
  });
  check(
    'and cannot recommend their way back in either',
    recommendWhileBlocked.body?.status === 'refused' &&
      recommendWhileBlocked.body?.reason === 'not_mutual',
    JSON.stringify(recommendWhileBlocked.body),
  );
  check(
    'which reads the same as a stranger, so a block is not announced',
    recommendWhileBlocked.body?.reason === strangerSend.body?.reason,
    `${recommendWhileBlocked.body?.reason} vs ${strangerSend.body?.reason}`,
  );

  const sentToYouAfterBlock = await rpc(b.token, 'recommendations_to_me', { p_limit: 20 });
  check(
    'and what A already sent leaves B’s Sent to you',
    !(sentToYouAfterBlock.body ?? []).some((row) => row.sender_id === a.id),
    JSON.stringify(sentToYouAfterBlock.body)?.slice(0, 160),
  );

  const tagAfterBlock = await rpc(a.token, 'set_watch_tags', {
    p_operation_id: uuid(),
    p_media_item_id: shared[1].id,
    p_tagged_ids: [b.id],
  });
  check(
    'nor tag them on a watch they were never on',
    tagAfterBlock.status >= 400,
    JSON.stringify(tagAfterBlock.body)?.slice(0, 120),
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
  // Three passes, each step independently caught. Independent review 15b: a teardown
  // that throws used to abort every cleanup after it, so one network blip could leave
  // an account behind in a project two people are about to test against — which is
  // worse than any failing check in this file.
  // The result is inspected rather than discarded. `destroyAccount` reports a non-200
  // by returning rather than throwing, so an `attempt` that ignored it would let a
  // failed self-delete be quietly repaired by the sweep below and never reach the exit
  // code — review 15c's second Minor.
  const destroy = async (label, account) => {
    const outcome = await destroyAccount(account);
    if (outcome && !outcome.deleted) {
      throw new Error(`delete_account returned ${outcome.result?.status}`);
    }
  };
  await attempt('delete A', () => destroy('A', a));
  await attempt('delete B', () => destroy('B', b));

  // By id, for everything whose creation response was readable.
  for (const id of created) {
    await attempt(`sweep auth user ${id}`, async () => {
      const res = await fetch(`${url}/auth/v1/admin/users/${id}`, {
        method: 'DELETE',
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      // 404 is the ordinary case: `delete_account` already removed it.
      if (!res.ok && res.status !== 404) {
        throw new Error(`${res.status} ${await res.text()}`);
      }
    });
  }

  // And by email, which catches the account whose id was never readable at all.
  for (const email of emails) {
    await attempt(`sweep ${email}`, () => sweepByEmail(email));
  }
}

console.log(
  `\n${passed}/${passed + failed} passed, ${failed} failed` +
    (skipped.length ? `, ${skipped.length} skipped` : ''),
);
if (failures.length) {
  console.log('\nFailures:');
  for (const line of failures) console.log(`  · ${line}`);
}
if (skipped.length) {
  // Printed after the failures and never folded into the pass count. A production
  // acceptance run is not complete while this list has anything in it — see
  // docs/release/production-acceptance.md.
  console.log('\nSkipped, because this project has no data to exercise them:');
  for (const line of skipped) console.log(`  · ${line}`);
}
process.exit(failed ? 1 : 0);
