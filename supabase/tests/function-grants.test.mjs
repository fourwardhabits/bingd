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

  // Added 2026-08-15 with avatar upload. Writes only the caller's own
  // profiles.avatar_path, and only to a path under the caller's own uuid
  // folder, so the grant buys no reach over anybody else's row. Not anon: it
  // needs an auth.uid() to validate the path against.
  //
  // storage_public_url is deliberately absent — the URL is composed on the
  // client from the project it is already talking to, so no such function
  // exists to grant.
  'set_avatar(text)': ['authenticated'],
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
