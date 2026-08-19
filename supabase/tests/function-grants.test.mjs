import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Pins the function-privilege model established by 20260813001800.
 *
 * The bug this guards against is not subtle once seen, and was invisible for
 * four migrations: Postgres grants EXECUTE on a new function to PUBLIC, so
 *
 *     grant execute on function f() to authenticated;
 *
 * adds a role to a set that already contains everyone. It reads as a restriction
 * and is an expansion. Six functions were reachable by `anon` on the deployed
 * database before this was caught.
 *
 * The test is written as a whole-schema sweep against an allow-list rather than
 * as one assertion per function, because the failure mode is *a function nobody
 * remembered to check*. A per-function test only covers the functions someone
 * thought of, which is the same set that was already thought about.
 */

/** Every function a client role may execute, and which roles may execute it. */
const ALLOWED = {
  // Called from inside RLS policies, which are evaluated as the querying role, so
  // these grants are unavoidable. What matters is the *signature*: neither takes
  // an identity to check, so a caller can only ask about themselves or about a row
  // that already exists. The two-argument forms they replaced — can_view_profile
  // and blocked_between — were social-graph oracles for exactly that reason, and
  // are now server-side only. See 20260813001900 and oracles.test.mjs.
  'can_i_view(uuid)': ['anon', 'authenticated'],
  'watch_tag_visible(uuid)': ['anon', 'authenticated'],

  // Retrieval by identifier: a shared link has to resolve without an account.
  'list_by_id(uuid)': ['anon', 'authenticated'],
  'list_items_by_list(uuid)': ['anon', 'authenticated'],

  // Signed-in reads.
  'my_capabilities()': ['authenticated'],
  'unranked_queue(integer)': ['authenticated'],
  // Not anon: it answers which usernames exist, and a signed-out client has no
  // account to create, so the grant would buy enumeration and nothing else.
  'username_available(text)': ['authenticated'],
  // Not anon either, per PRD §26.2 AC 1, which gives search to a signed-in user.
  'search_titles(text,integer)': ['authenticated'],
  // Only because search_titles runs as the caller and folds the query text through it. A
  // security invoker function cannot call what the caller may not. It is a pure function
  // of a string and knows nothing about anybody. media_search and media_sort_key are
  // deliberately absent: they exist to generate columns, not to be called.
  'media_fold(text)': ['authenticated'],

  // Account creation. Authenticated because a session exists before a profile
  // does — the user has completed a sign-in method and has no profile row yet.
  'create_profile(text,text,date)': ['authenticated'],

  // Signed-in writes.
  'rank_start(uuid,taste_bucket)': ['authenticated'],
  'rank_answer(uuid,uuid)': ['authenticated'],
  'rank_skip(uuid)': ['authenticated'],
  'rank_back(uuid)': ['authenticated'],
  'rank_unrank(uuid)': ['authenticated'],
  // Added 2026-08-14 with the comparison screen, which needed a way out of a session.
  'rank_cancel(uuid)': ['authenticated'],
  'rank_reorder(uuid,integer)': ['authenticated'],
  'rank_rebucket(uuid,taste_bucket)': ['authenticated'],
  'report(report_subject,uuid,text,text)': ['authenticated'],

  // The collection writes (api.md §1). Their helpers are absent on purpose:
  // _media_kind and _assert_unranked answer questions about a row, _claim_operation
  // called directly would let a client burn an operation id so that a later genuine
  // write returns success without happening.
  //
  // log_watched and save_note gained note_visibility and a spoiler flag on
  // 2026-08-16. The old four- and three-argument forms were dropped rather than
  // left as overloads: PostgREST resolves an RPC by the argument names present in
  // the body, and two candidates whose argument sets nest resolve ambiguously.
  'log_watched(uuid,uuid,date,text,note_visibility,boolean)': ['authenticated'],
  'set_bucket(uuid,uuid,taste_bucket)': ['authenticated'],
  'unlog(uuid,uuid)': ['authenticated'],
  'set_watchlist(uuid,uuid,boolean)': ['authenticated'],
  'set_season_progress(uuid,uuid,season_progress)': ['authenticated'],
  'save_note(uuid,uuid,text,timestamp with time zone,note_visibility,boolean)': ['authenticated'],

  // Added 2026-08-16 with social notes. Both are definer reads, and both take a
  // subject rather than a viewer, so neither can be pointed at someone else's
  // perspective the way 20260813001900 describes. public_notes projects only the
  // note columns, because the row it reads also carries the watch date, which PRD
  // §22 keeps private at every visibility level. Not anon: the public web pages do
  // not render notes yet, and a grant should follow a surface rather than precede it.
  'public_notes(uuid[],uuid[],integer)': ['authenticated'],
  'community_score(uuid)': ['authenticated'],

  // Added 2026-08-16 with the Following score (20260816001100). A definer read taking
  // a title rather than a viewer: the population is `auth.uid()`'s own approved
  // followees, so it cannot be pointed at somebody else's perspective, which is
  // 20260813001900's rule. Not anon — `auth.uid()` is the whole population filter, so
  // an anon caller could only ever get the empty answer.
  'following_score(uuid)': ['authenticated'],

  // Added 2026-08-16 with reactions (PRD §14). The only writer for a table that has
  // a select policy and, deliberately, no insert policy: a policy cannot express
  // "and only on an event you are allowed to see", which is the check that stops a
  // leaked event id becoming a way to put your name against a private account's
  // activity.
  'set_reaction(uuid,uuid,text)': ['authenticated'],

  // Added 2026-08-17 with Comments V1 (20260817000100). Same shape as set_reaction
  // and for the same reason: `comments` has a select policy and no insert policy,
  // because a policy cannot express "and only on an event you are allowed to see".
  //
  // All three refuse with P0002 for a row that is missing *and* for one the caller
  // may not touch, so a comment id or an event id learned from a screenshot or a
  // crash report confirms nothing. `_assert_comment_length` is deliberately absent:
  // nothing outside these three needs it.
  'add_comment(uuid,uuid,text,boolean)': ['authenticated'],
  'edit_comment(uuid,uuid,text,boolean)': ['authenticated'],
  'delete_comment(uuid,uuid)': ['authenticated'],

  // Added 2026-08-17 with the social graph writers (20260817000200). `follows` and
  // `blocks` had read policies and no writers at all until this migration, so the
  // whole visibility architecture rested on edges no user could create.
  //
  // `follow` is the one writer in this schema that deliberately does **not** gate on
  // can_view_profile — a private account fails it by definition, and gating would make
  // the pending state unreachable. `_assert_reachable` is its gate instead, and it is
  // deliberately absent from this list: it answers "does this account exist, is it
  // active, is there a block" about a named third party, which is exactly what
  // 20260813001900 revoked can_view_profile for.
  'follow(uuid,uuid)': ['authenticated'],
  'unfollow(uuid,uuid)': ['authenticated'],
  'respond_follow_request(uuid,uuid,boolean)': ['authenticated'],
  'remove_follower(uuid,uuid)': ['authenticated'],
  'block(uuid,uuid)': ['authenticated'],
  'unblock(uuid,uuid)': ['authenticated'],

  // security invoker, so it can only report what follows_read and blocks_read already
  // admit — the caller's own edges. It cannot be pointed at a pair the caller is not
  // part of, which is why a function that takes a list of user ids is safe here.
  'follow_state_with(uuid[])': ['authenticated'],

  // Added 2026-08-17 with user discovery (20260817000300). Definer, and takes no
  // viewer: the perspective is always auth.uid()'s own. Not anon — there is no
  // signed-out surface that lists people, and a grant should follow a surface rather
  // than precede it, which is the rule public_notes set.
  'search_users(text,integer)': ['authenticated'],
  // 20260819000100. Identity-only, behind the discovery predicate. It cannot reach a
  // private account's content: `can_view_profile` is untouched and still gates every
  // content read in the schema.
  //
  // `can_discover_profile` is deliberately **absent** from this list. It was granted by
  // 20260819000100 and revoked by 20260819000200: a definer helper that takes a viewer
  // as an argument answers questions about other people, and given two ids known to be
  // active a `false` means a block between them. 20260813001900 is the same finding
  // about two other functions. Both callers are definer and need no grant.
  'profile_identity(text)': ['authenticated'],

  // Added 2026-08-17 with the social graph writers. Definer, and it must be: blocking
  // makes the profile unreadable to the blocker as well, so naming the account
  // requires reading past profiles_read. It takes no argument at all, which is the
  // strongest form of 20260813001900's rule — there is nothing to point elsewhere.
  'my_blocks()': ['authenticated'],

  // Added 2026-08-17 with Taste Match (20260817000400). A definer read taking a
  // subject rather than a viewer: one half of the pair is always auth.uid(). Every
  // ranking it folds in belongs to an account rankings_read already lets the caller
  // select individually, which is the same safety argument following_score records.
  'taste_match(uuid)': ['authenticated'],

  // Added 2026-08-17 with Settings (20260817000600). Every one of these is about the
  // caller's own account and none takes a target, which is 20260813001900's rule in
  // its strongest form: there is nothing to point at anybody else.
  //
  // `save_profile` and `set_profile_visibility` write columns `profiles` has no
  // update policy for by design (20260813000200: writes go through definer functions),
  // so definer is the mechanism rather than an escalation.
  //
  // `save_profile` replaced `update_profile` and `change_username` on 2026-08-17. One
  // transaction, because a screen with two saves can leave the name written and the
  // handle refused; the two it replaced are **dropped** rather than overloaded, since
  // PostgREST resolves by argument name and nesting argument sets resolve ambiguously.
  // It carries the 90-day redirect machinery's only entry point with it, and the
  // cooldown fires only when the handle actually changes — a rename is a scarcity
  // limit, not a rate limit, because every one retires a handle permanently.
  //
  // `my_notifications` is definer for the reason `my_blocks` is, and the reason is
  // sharper here — a private account requesting to follow another private account
  // fails can_view_profile, so an invoker query could not name the one person whose
  // request the caller has to answer. The filter is `recipient_id = auth.uid()` and it
  // is not a parameter.
  //
  // `delete_account` takes only a confirmation string. It deletes `auth.uid()` and
  // there is no signature by which it could delete anybody else.
  'save_profile(uuid,text,text,text)': ['authenticated'],
  'set_profile_visibility(uuid,profile_visibility)': ['authenticated'],
  'my_notifications(integer)': ['authenticated'],
  'mark_notifications_read()': ['authenticated'],
  'delete_account(text)': ['authenticated'],

  // Added 2026-08-17 with friend recommendations (20260817001300).
  //
  // `recommend_title` names a recipient, which is the reason to look hard at it — and
  // the reason it is safe is that it decides nothing from what the caller sends. The
  // recipient must be a mutual follow, which is a fact about the caller's own edges,
  // and every disqualifying case raises through `_assert_reachable` with one message.
  //
  // `recommendations_to_me` and `mark_recommendation_opened` take no recipient at all:
  // both filter on `recipient_id = auth.uid()`, and the filter is not a parameter.
  // `recommendations_to_me` is additionally `security invoker`, so it can return only
  // rows `title_recommendations_read` already admits.
  //
  // `create_invite_link` returns the caller's own reusable personal link (PRD §17) and
  // records that it was created. It exposes no count and no other account.
  //
  // `_is_mutual_follow` is deliberately absent, for the reason `_can_tag` is: it
  // answers a question about somebody else's follow graph, which is what
  // 20260813001900 exists to prevent.
  'recommend_title(uuid,uuid,uuid)': ['authenticated'],
  'recommendations_to_me(integer)': ['authenticated'],
  'mark_recommendation_opened(uuid)': ['authenticated'],
  'create_invite_link(uuid,uuid)': ['authenticated'],

  // Added 2026-08-17 with Bingd Reviews (20260817000800). Definer, and it reuses
  // `public_notes`' own visibility predicate rather than a second copy of it — getting
  // that wrong is how a private account's writing leaks, and there is exactly one
  // correct expression of it in this schema. Not anon, following the rule public_notes
  // set: a grant follows a surface, and there is no signed-out title page.
  'title_reviews(uuid,text,integer)': ['authenticated'],

  // Added 2026-08-17. The first writer and the first reader for a table that has
  // existed since 20260813000900 with nothing consulting it. Both are about the
  // caller's own settings and neither takes a target.
  //
  // `_notifies` and `_apply_notification_preference` are deliberately absent. The first
  // answers whether a *named third party* has muted you, which is exactly what
  // 20260813001900 revoked can_view_profile for; the second is a trigger function and a
  // client holding it could suppress anybody's inbox row.
  // `set_notification_preferences` (plural) was added 2026-08-19 with the taxonomy.
  // It is what a section master switch calls: one transaction over several
  // categories, because five sequential single-category writes can end up half
  // applied and leave a master switch disagreeing with its own children.
  //
  // `_notification_categories` and `_notification_default` join the internal side.
  // Both are pure and disclose nothing about anybody, but the allow-list is the
  // artefact that gets reviewed and an entry here should follow a surface -- no
  // client calls either, so no client may.
  'set_notification_preference(text,boolean)': ['authenticated'],
  'set_notification_preferences(text[],boolean)': ['authenticated'],
  'my_notification_preferences()': ['authenticated'],

  // Added 2026-08-16 with watch tagging (PRD §14). `set_watch_tags` replaces the
  // whole companion list for one of the caller's own watches; `hide_watch_tag` is
  // the tagged person's side of it.
  //
  // Their helpers are deliberately absent. `_can_tag` answers "may I tag this
  // person", which folds an approved follow in either direction together with a
  // block — granting it would answer questions about somebody else's follow graph,
  // which is what 20260813001900 exists to prevent. `_assert_operation_rate` would
  // report how much another account has been doing today.
  'set_watch_tags(uuid,uuid,uuid[])': ['authenticated'],
  'hide_watch_tag(uuid,uuid)': ['authenticated'],

  // Added 2026-08-15 with avatar upload. Writes only the caller's own
  // profiles.avatar_path, and only to a path under the caller's own uuid
  // folder, so the grant buys no reach over anybody else's row. Not anon: it
  // needs an auth.uid() to validate the path against.
  //
  // storage_public_url is deliberately absent — the URL is composed on the
  // client from the project it is already talking to, so no such function
  // exists to grant.
  'set_avatar(text)': ['authenticated'],

  // Added 2026-08-16 with yearly watch goals. The only writer for a table that has
  // a select policy and no write policies, for the usual reason: the clear path is
  // a delete and the set path is an upsert, and expressing "and only your own, and
  // only within the sane range" as three policies is three places to get it wrong.
  // Not anon — a goal needs an auth.uid() to belong to.
  'set_watch_goal(integer,ranking_category,integer)': ['authenticated'],
};

async function functionPrivileges(t) {
  const { rows } = await t.sql(`
    select p.oid::regprocedure::text as signature,
           has_function_privilege('anon', p.oid, 'execute')          as anon_exec,
           has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       and not exists (
         select 1 from pg_depend d
          where d.objid = p.oid
            and d.classid = 'pg_proc'::regclass
            and d.deptype = 'e'
       )
     order by signature
  `);
  // regprocedure renders as public.name(args) with spaces after commas.
  return rows.map((r) => ({
    signature: r.signature.replace(/^public\./, '').replace(/,\s+/g, ','),
    anon: r.anon_exec,
    authenticated: r.auth_exec,
  }));
}

test('no function outside the allow-list is executable by a client role', async () => {
  const t = await createTestDb();
  try {
    const unexpected = [];
    for (const fn of await functionPrivileges(t)) {
      const allowed = ALLOWED[fn.signature] ?? [];
      if (fn.anon && !allowed.includes('anon')) unexpected.push(`anon can execute ${fn.signature}`);
      if (fn.authenticated && !allowed.includes('authenticated')) {
        unexpected.push(`authenticated can execute ${fn.signature}`);
      }
    }

    assert.deepEqual(
      unexpected,
      [],
      `Functions reachable by a client role but not in the allow-list.\n` +
        `If the new grant is intended, add it to ALLOWED in this file and say why.\n` +
        `Remember that "grant execute ... to authenticated" does not remove the\n` +
        `default PUBLIC grant — see 20260813001800.\n\n  ${unexpected.join('\n  ')}\n`,
    );
  } finally {
    await t.close();
  }
});

test('every function in the allow-list actually exists with that signature', async () => {
  const t = await createTestDb();
  try {
    // Catches the allow-list drifting out of date: a renamed or re-signatured
    // function would otherwise sit here forever, silently permitting nothing and
    // hiding the fact that the real function is unguarded under its new name.
    const present = new Set((await functionPrivileges(t)).map((f) => f.signature));
    const missing = Object.keys(ALLOWED).filter((sig) => !present.has(sig));
    assert.deepEqual(missing, [], `Allow-list names functions that do not exist: ${missing}`);
  } finally {
    await t.close();
  }
});

test('the helpers RLS policies depend on are executable, or every read breaks', async () => {
  const t = await createTestDb();
  try {
    // The failure this prevents is disproportionate: can_view_profile is named by
    // policies across eight migrations, and a policy that calls a function the
    // caller cannot execute fails the entire query rather than filtering it. The
    // symptom would be "permission denied for function" on an ordinary profile
    // read, which points nowhere near a grant.
    const alice = await t.createUser({ username: 'alice' });

    const visible = await t.asAnon(async () => {
      const { rows } = await t.sql(`select id from profiles where id = $1`, [alice]);
      return rows;
    });

    assert.equal(visible.length, 1, 'a signed-out reader should see a public profile');
  } finally {
    await t.close();
  }
});

test('capability reads are scoped to the caller, with no target argument exposed', async () => {
  const t = await createTestDb();
  try {
    const alice = await t.createUser({ username: 'alice' });
    const bob = await t.createUser({ username: 'bob' });

    // resolve_capabilities takes a target, which is exactly why it must not be
    // reachable: it would let anyone read anyone's entitlements.
    await t.asUser(alice, async () => {
      const err = await t.errorFrom(`select resolve_capabilities($1)`, [bob]);
      assert.ok(err, 'resolve_capabilities should not be callable by a client');
      assert.match(err.message, /permission denied/i);
    });

    // The sanctioned route answers only for whoever is asking.
    await t.asUser(alice, async () => {
      const { rows } = await t.sql(`select my_capabilities() as caps`);
      assert.ok(rows[0].caps.includes('base_free'));
    });
  } finally {
    await t.close();
  }
});

test('a signed-out caller gets no answer from my_capabilities', async () => {
  const t = await createTestDb();
  try {
    // The one finding that was not merely defence in depth: before 001800 this
    // returned ["base_free"] to strangers on the deployed database.
    await t.asAnon(async () => {
      const err = await t.errorFrom(`select my_capabilities()`);
      assert.ok(err, 'my_capabilities should be refused for an anonymous caller');
      assert.match(err.message, /permission denied/i);
    });
  } finally {
    await t.close();
  }
});

test('write RPCs are refused on privilege, not merely on the suspension guard', async () => {
  const t = await createTestDb();
  try {
    // Before 001800 these were reachable by anon and stopped only by
    // assert_can_write raising 'unauthenticated'. That is containment inside the
    // function rather than at the door, and it does not survive someone adding a
    // function without the guard. Both layers are asserted, in the right order.
    await t.asAnon(async () => {
      for (const call of [
        `select rank_start('00000000-0000-0000-0000-000000000000', 'loved')`,
        `select rank_reorder('00000000-0000-0000-0000-000000000000', 1)`,
        `select report('profile', '00000000-0000-0000-0000-000000000000', 'spam', null)`,
      ]) {
        const err = await t.errorFrom(call);
        assert.ok(err, `${call} should be refused`);
        assert.match(err.message, /permission denied/i, `${call} should fail on privilege`);
      }
    });
  } finally {
    await t.close();
  }
});

test('assert_can_write is internal, and still runs inside the definer functions', async () => {
  const t = await createTestDb();
  try {
    // Revoking it is safe precisely because a security definer function executes
    // as its owner. This asserts both halves: a client cannot call the guard, and
    // the guard nonetheless fires for a suspended account going through the RPC.
    const alice = await t.createUser({ username: 'alice' });
    const movie = await t.createMovie('Heat', 949);

    await t.asUser(alice, async () => {
      const err = await t.errorFrom(`select assert_can_write($1)`, [alice]);
      assert.ok(err, 'assert_can_write should not be client-callable');
      assert.match(err.message, /permission denied/i);
    });

    await t.sql(`update profiles set status = 'suspended' where id = $1`, [alice]);

    await t.asUser(alice, async () => {
      const err = await t.errorFrom(`select rank_start($1, 'loved')`, [movie]);
      assert.ok(err, 'a suspended account should not be able to rank');
      assert.match(err.message, /suspend/i, 'and should be told why, not given a privilege error');
    });
  } finally {
    await t.close();
  }
});
