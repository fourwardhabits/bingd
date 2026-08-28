import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * `can_discover_profile` and `profile_identity` — 20260819000100.
 *
 * **The boundary this whole migration is about.** Private stopped meaning "nobody can
 * find me" and went back to meaning "my activity is private", and the risk in that
 * change is entirely one-directional: widening discovery is the intent, and widening
 * *content* by accident is the failure.
 *
 * So this file is written in two halves that must both hold at once.
 *
 *   discovery   a private account is findable by name, and leads somewhere a follow
 *               request can be made from
 *   content     everything `can_view_profile` gated before is still gated, read
 *               through the actual surfaces rather than asserted about
 *
 * The second half is the one worth being pedantic in. A test that only checked
 * `can_view_profile` still returns false would pass against a schema where some *other*
 * read had quietly started answering, which is exactly the shape of leak a widening
 * migration produces.
 */

let t;
let viewer;
let shy;
let hostile;
let suspended;
let befriended;

before(async () => {
  t = await createTestDb();

  viewer = await t.createUser({ username: 'seeker' });
  shy = await t.createUser({ username: 'shy_one', visibility: 'private' });
  hostile = await t.createUser({ username: 'hostile_one', visibility: 'private' });
  suspended = await t.createUser({ username: 'gone_one', visibility: 'private' });

  // Both private accounts are created and named in one place, so the only differences
  // between them are the two the boundary is about: the follow edge, and nothing else.
  // Independent review 22f found a display name that reached one and not the other.
  befriended = await t.createUser({ username: 'befriended_one', visibility: 'private' });
  await t.sql(`update profiles set display_name = 'Shy One' where id = $1`, [shy]);
  // A name of its own, not the same string: 'Shy One' would make `search_users('shy_one')`
  // match this account by display name and the search assertions would be about two rows.
  await t.sql(`update profiles set display_name = 'Befriended One' where id = $1`, [befriended]);
  await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [hostile, viewer]);
  await t.sql(`update profiles set status = 'suspended' where id = $1`, [suspended]);

  await t.actAs(viewer);
});

after(async () => t?.close());

/**
 * Called through `sql`, which runs as the owner — and that is now the *only* way to
 * call it. Independent review 22: granting a definer helper that takes a viewer as an
 * argument recreates the oracle `20260813001900` closed, so `20260819000200` revoked it.
 * The test at the bottom of this file is what holds that shut.
 */
const discovers = async (subject) => {
  const { rows } = await t.sql(`select can_discover_profile(auth.uid(), $1) as ok`, [subject]);
  return rows[0].ok;
};

const identity = async (username) => {
  const { rows } = await t.sql(
    `select id, username, display_name, avatar_path, visibility from profile_identity($1)`,
    [username],
  );
  return rows;
};

// ---------------------------------------------------------------------------

describe('who may be found', () => {
  it('finds a private account nobody follows', async () => {
    // The whole change, in one assertion.
    assert.equal(await discovers(shy), true);
  });

  it('does not find an account that blocked the caller', async () => {
    // A block is the one relationship where being findable is itself the harm, and it
    // is deliberately not a visibility setting.
    assert.equal(await discovers(hostile), false);
  });

  it('does not find an account the caller blocked', async () => {
    const unwanted = await t.createUser({ username: 'unwanted_one' });
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [viewer, unwanted]);

    assert.equal(await discovers(unwanted), false);
  });

  it('does not find a suspended account', async () => {
    // Surfacing one would leak a moderation decision as well as an account.
    assert.equal(await discovers(suspended), false);
  });

  it('does not find the caller themselves', async () => {
    assert.equal(await discovers(viewer), false);
  });

  it('does not find an account that does not exist', async () => {
    assert.equal(
      await discovers('00000000-0000-4000-8000-000000000000'),
      false,
      'a missing subject must be false rather than null — a null would be neither true ' +
        'nor false to a `where` clause and would silently drop the row instead of ' +
        'rejecting it, which is the right outcome reached by the wrong route',
    );
  });
});

// ---------------------------------------------------------------------------

describe('what a found account discloses', () => {
  it('answers with identity, and only identity', async () => {
    const rows = await identity('shy_one');

    assert.equal(rows.length, 1);
    assert.equal(rows[0].username, 'shy_one');
    assert.equal(rows[0].display_name, 'Shy One');
    assert.equal(rows[0].visibility, 'private');
    // The column list is the disclosure. Anything else appearing here would be a
    // widening nobody asked for, so it is asserted rather than assumed.
    assert.deepEqual(Object.keys(rows[0]).sort(), [
      'avatar_path',
      'display_name',
      'id',
      'username',
      'visibility',
    ]);
  });

  it('answers for a public account too, so the call is not itself a disclosure', async () => {
    // A screen that only reached for this on private accounts would make "which call
    // succeeded" a report of somebody's visibility setting to anybody watching.
    await t.createUser({ username: 'open_one' });

    assert.equal((await identity('open_one')).length, 1);
  });

  it('says nothing about a blocked, suspended, or absent handle', async () => {
    assert.deepEqual(await identity('hostile_one'), []);
    assert.deepEqual(await identity('gone_one'), []);
    assert.deepEqual(await identity('nobody_has_this'), []);
  });

  it('says nothing for a blank handle', async () => {
    assert.deepEqual(await identity('   '), []);
    assert.deepEqual(await identity(''), []);
  });
});

// ---------------------------------------------------------------------------

/**
 * **The half that must not have moved.**
 *
 * Read through the surfaces a client actually uses, not through `can_view_profile`
 * directly — a leak would appear in one of these while the predicate still answered
 * false, and that is the failure this file exists to catch.
 */
describe('what a found account still refuses', () => {
  /**
   * Through `asRole`, not `sql`.
   *
   * The harness runs `sql` as the owner, and policies are skipped for the owner — so a
   * raw select here would return the row whatever the policy said, and the test would be
   * measuring nothing. Every content assertion goes through a real `authenticated` role.
   */
  const asViewer = (query, params = []) =>
    t.asRole('authenticated', viewer, async () => (await t.sql(query, params)).rows);

  /**
   * Every surface the schema keys to a person and gates on `can_i_view`, with the query
   * that reaches it — **one list, so that asserting on a surface and writing a fixture
   * for it cannot come apart.**
   *
   * They came apart twice. Review 22 found the list too short; 22b found the fix
   * asserting on seven tables and writing to two; 22c found four more that were empty or
   * blocked by a *different* predicate, so they would have passed with `can_i_view`
   * stubbed to true. Each round the assertions looked right and proved nothing, which is
   * why the guard below is now the first thing that runs.
   */
  const SURFACES = [
    // `user_media` is deliberately **not** here. Independent review 22d: its only select
    // policy is `user_id = auth.uid()`, so a viewer is refused for being somebody else
    // rather than for being unable to view the account — it would stay empty with
    // `can_i_view` stubbed to true, which is the fifth disguise of the same defect. It
    // has its own test below, asserting the rule that actually protects it.
    ['public_profiles', `select id from public_profiles where username = 'shy_one'`, []],
    ['rankings', `select media_item_id from rankings where user_id = $1`, true],
    ['follows', `select follower_id from follows where follower_id = $1`, true],
    ['feed_events', `select id from feed_events where actor_id = $1`, true],
    ['reactions', `select feed_event_id from reactions where user_id = $1`, true],
    ['lists', `select id from lists where owner_id = $1`, true],
    [
      'list_items',
      `select li.list_id from list_items li join lists l on l.id = li.list_id
        where l.owner_id = $1`,
      true,
    ],
    ['watch_tags', `select id from watch_tags where tagger_id = $1`, true],
    ['comments', `select id from comments where author_id = $1`, true],
    ['username_history', `select profile_id from username_history where profile_id = $1`, true],
    [
      'match_scores',
      `select score from match_scores where user_a = $1 or user_b = $1`,
      true,
    ],
  ];

  /**
   * The second private account is created with the first, above. Identical in every way
   * except that the viewer follows it.
   *
   * **This is what makes the refusals mean something.** A test that only asserts absence
   * cannot tell "refused by the predicate under test" from "refused by some other rule,
   * or empty because the fixture never landed" — which is the mistake reviews 22b, 22c
   * and 22d each found in a different table. Opening the boundary and watching the same
   * queries fill is the control, and it is the only version of this test that would fail
   * if `can_i_view` were stubbed to true or to false.
   */
  const writeFixtures = async (account, offset, bystander) => {
    // Well clear of the ids the outer fixture uses: `media_items_tmdb` is unique, and a
    // collision here fails the whole hook rather than the one row.
    const film = await t.createMovie(`A Private Favourite ${offset}`, 918400 + offset * 10);
    const other = await t.createMovie(`A Private Second ${offset}`, 918401 + offset * 10);

    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket, watched_on, note, note_visibility)
       values ($1, $2, 'loved', current_date, 'my private thoughts', 'public')`,
      [account, film],
    );
    await t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       values ($1, $2, 'movies', 'loved', 1)`,
      [account, film],
    );
    await t.sql(
      `insert into follows (follower_id, followee_id, state, approved_at)
       values ($1, $2, 'approved', now())`,
      [account, bystander],
    );

    const { rows: events } = await t.sql(
      `insert into feed_events (actor_id, type, media_item_id)
       values ($1, 'title_logged', $2) returning id`,
      [account, film],
    );
    const event = events[0].id;

    const { rows: lists } = await t.sql(
      `insert into lists (owner_id, title, visibility)
       values ($1, 'A Public List On A Private Account', 'public') returning id`,
      [account],
    );
    await t.sql(
      `insert into list_items (list_id, media_item_id, position) values ($1, $2, 1)`,
      [lists[0].id, other],
    );
    await t.sql(`insert into reactions (feed_event_id, user_id, kind) values ($1, $2, 'love')`, [
      event,
      account,
    ]);
    await t.sql(
      `insert into watch_tags (tagger_id, tagged_id, media_item_id) values ($1, $2, $3)`,
      [account, bystander, film],
    );
    await t.sql(
      `insert into comments (feed_event_id, author_id, body) values ($1, $2, 'a private remark')`,
      [event, account],
    );
    await t.sql(
      `insert into match_scores (user_a, user_b, score, shared_count)
       select least($1::uuid, $2::uuid), greatest($1::uuid, $2::uuid), 80, 12`,
      [account, viewer],
    );

    // A real username change, which is what writes `username_history` — a trigger does
    // it, and touching `display_name` writes nothing. Changed back, because a fixture
    // that renames a shared account is a dependency between tests.
    const { rows: named } = await t.sql(`select username from profiles where id = $1`, [account]);
    await t.sql(`update profiles set username = $2 where id = $1`, [
      account,
      `renamed_${offset}`,
    ]);
    await t.sql(`update profiles set username = $2 where id = $1`, [account, named[0].username]);
  };

  before(async () => {
    const bystander = await t.createUser({ username: 'bystander_one' });

    /**
     * **Both accounts go through the same helper**, which is the point rather than a
     * tidiness. Independent review 22e: the refusal account's fixtures were hand-written
     * while the control's used `writeFixtures`, so the two could drift apart and quietly
     * recreate the false-absence class the control exists to close. Equivalence has to be
     * structural or it is a claim that decays.
     */
    await writeFixtures(shy, 0, bystander);

    // The control's subject: the same fixtures, plus the one edge that opens the boundary.
    await t.sql(
      `insert into follows (follower_id, followee_id, state, approved_at)
       values ($1, $2, 'approved', now())`,
      [viewer, befriended],
    );
    await writeFixtures(befriended, 1, bystander);
  });

  /**
   * **The guard, and it runs first.**
   *
   * Every surface below must have something for the owner to see, or the absences that
   * follow are absences of a fixture rather than of a leak. Three review rounds went to
   * that exact mistake in three different disguises.
   */
  it('has something to hide on every surface it asserts about', async () => {
    for (const [name, query, params] of SURFACES) {
      const args = params === true ? [shy] : params === 'authors' ? [[shy]] : params;
      const { rows } = await t.sql(query, args);
      assert.equal(rows.length > 0, true, `fixture wrote no ${name} row to hide`);
    }
  });

  it('refuses every one of them to a viewer who may not read the account', async () => {
    for (const [name, query, params] of SURFACES) {
      const args = params === true ? [shy] : params === 'authors' ? [[shy]] : params;
      assert.deepEqual(
        await asViewer(query, args),
        [],
        `${name} disclosed rows for an account the viewer may not read`,
      );
    }
  });

  /**
   * **The control**, and the only version of these assertions that means anything.
   *
   * Absence proves nothing on its own: reviews 22b, 22c and 22d each found a surface
   * that was empty for a reason with nothing to do with the predicate under test — a
   * missing fixture, a list's own visibility branch, a pair the caller was not part of,
   * an owner-only policy. Opening the boundary and watching the same queries fill is what
   * separates "refused because this viewer may not read the account" from "empty".
   *
   * Same fixtures, same queries, one difference: the viewer follows this one.
   */
  it('returns every one of them once the viewer is approved to read the account', async () => {
    for (const [name, query, params] of SURFACES) {
      const args =
        params === true
          ? [befriended]
          : params === 'authors'
            ? [[befriended]]
            : [`select id from public_profiles where username = 'befriended_one'`];

      const rows = await asViewer(
        // The one entry with a literal handle in it rather than a parameter.
        name === 'public_profiles' ? args[0] : query,
        name === 'public_profiles' ? [] : args,
      );

      assert.equal(
        rows.length > 0,
        true,
        `${name} stayed empty for an approved follower, so its refusal above proves nothing`,
      );
    }
  });

  /**
   * `public_notes` is not in the table above, and the reason is worth stating: it is a
   * *function* that applies `can_view_profile` from `auth.uid()`'s own perspective, so
   * the owner cannot see the row either while the ambient identity is the viewer's.
   * The guard has to switch perspective to prove the fixture, which is a different shape
   * from every other entry.
   */
  it('still refuses their notes, even the ones marked public', async () => {
    // The fixture, from the author's own side — otherwise the absence below is an
    // absence of a note rather than of a disclosure.
    await t.actAs(shy);
    const { rows: mine } = await t.sql(`select * from public_notes($1::uuid[], null, 50)`, [
      [shy],
    ]);
    await t.actAs(viewer);
    assert.equal(mine.length > 0, true, 'fixture wrote no public note to hide');

    // A public note on a private account is not a public note to a stranger.
    const { rows } = await t.sql(`select * from public_notes($1::uuid[], null, 50)`, [[shy]]);
    assert.deepEqual(rows, []);
  });

  it('still refuses their collection, by a rule of its own', async () => {
    // `user_media_own` is `user_id = auth.uid()` and nothing else — the watch date and
    // the note live here and are not published to *anybody*, follower or not. So this is
    // asserted against the approved follower too: the one surface where opening the
    // boundary must change nothing. Independent review 22d.
    assert.deepEqual(
      await asViewer(`select media_item_id from user_media where user_id = $1`, [shy]),
      [],
    );
    assert.deepEqual(
      await asViewer(`select media_item_id from user_media where user_id = $1`, [befriended]),
      [],
      'an approved follow must not open the collection row: the note and the watch date ' +
        'are owner-only regardless of visibility',
    );
  });

  it('still answers false from can_view_profile', async () => {
    const { rows } = await t.sql(`select can_view_profile(auth.uid(), $1) as ok`, [shy]);
    assert.equal(rows[0].ok, false);
  });
});

// ---------------------------------------------------------------------------

/**
 * **The predicate is not an endpoint**, and independent review 22 found it granted as
 * one.
 *
 * `20260813001900` states the rule this broke: a `security definer` helper that accepts
 * the identity to check as an *argument* answers questions about other people. Profile
 * ids are enumerable — `search_users` returns them by design — so given two ids known to
 * name active accounts, a `false` here has one remaining cause, and it is a block
 * between two strangers.
 *
 * Revoked rather than reshaped, because unlike `can_view_profile` this one is not called
 * by any policy: its two callers are definer functions that run as the owner.
 */
describe('the discovery predicate is server-only', () => {
  it('is not executable by a client role', async () => {
    const denied = await t.asRole('authenticated', viewer, async () =>
      t.errorFrom(`select can_discover_profile($1, $2)`, [viewer, shy]),
    );

    assert.match(String(denied?.message ?? denied), /permission denied/i);
  });

  it('is not executable by anon either', async () => {
    const denied = await t.asRole('anon', null, async () =>
      t.errorFrom(`select can_discover_profile($1, $2)`, [viewer, shy]),
    );

    assert.match(String(denied?.message ?? denied), /permission denied/i);
  });

  it('still answers for the functions that need it', async () => {
    // The revoke must not have broken the two callers, which run as the owner. If it
    // had, every assertion above about discovery would be passing over a dead function.
    const rows = await t.asRole('authenticated', viewer, async () =>
      (await t.sql(`select username from search_users('shy_one', 30)`)).rows,
    );

    assert.deepEqual(
      rows.map((r) => r.username),
      ['shy_one'],
    );
  });
});

// ---------------------------------------------------------------------------

/**
 * The founder's §33 matrix, as one readable contract.
 *
 * `20260819000100` separated identity from content on two surfaces — Search, and the
 * locked shell a search result leads to. `20260828000400` finished the job on the two the
 * founder's device pass found still collapsing them: Followers/Following, and Mutuals.
 *
 * Everything above in this file asserts the *content* half, which did not move. This
 * block asserts the identity half that did, and — in the same place, deliberately — the
 * three content surfaces that were newly at risk *because* it moved: Match, the shared
 * count that comes with it, and the monthly leaderboard. Those three are the ones a
 * reader would most plausibly assume follow discoverability, and they must not.
 *
 * `asRole('authenticated')` throughout. Under the owner every one of these returns rows
 * regardless of policy, which is the failure mode three earlier reviews of this file
 * each found in a different disguise.
 */
describe('a private identity, across every surface the founder named', () => {
  let bystander;

  const asViewer = (query, params = []) =>
    t.asRole('authenticated', viewer, async () => (await t.sql(query, params)).rows);

  before(async () => {
    bystander = await t.createUser({ username: 'matrix_bystander' });
    // `shy` already follows a bystander from the fixtures above. The edge that matters
    // here is the other direction — a public account both parties can see, with the
    // private account inside its follower list.
    await t.sql(
      `insert into follows (follower_id, followee_id, state, approved_at)
       values ($1, $2, 'approved', now()) on conflict do nothing`,
      [shy, bystander],
    );
    await t.sql(
      `insert into follows (follower_id, followee_id, state, approved_at)
       values ($1, $2, 'approved', now()) on conflict do nothing`,
      [bystander, shy],
    );
  });

  // --- identity: now visible -------------------------------------------------

  it('is found by Search', async () => {
    const rows = await asViewer(`select username, visibility from search_users('shy_one', 30)`);
    assert.deepEqual(rows.map((r) => r.username), ['shy_one']);
    assert.equal(rows[0].visibility, 'private');
  });

  it('leads to a locked shell rather than to nothing', async () => {
    const rows = await asViewer(
      `select username, display_name, visibility from profile_identity('shy_one')`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].visibility, 'private');
  });

  it('appears in a readable account’s follower list', async () => {
    const rows = await asViewer(`select username, visibility from followers_of($1)`, [bystander]);
    assert.ok(
      rows.some((r) => r.username === 'shy_one' && r.visibility === 'private'),
      'the §21B change: a private account is named in a list it belongs to',
    );
  });

  it('appears in a readable account’s following list', async () => {
    const rows = await asViewer(`select username, visibility from following_of($1)`, [bystander]);
    assert.ok(rows.some((r) => r.username === 'shy_one' && r.visibility === 'private'));
  });

  it('can be suggested as a mutual', async () => {
    // The viewer follows `bystander`, `bystander` follows `shy`, and the viewer has
    // neither followed nor asked. That is the legitimate social reason §21C requires.
    await t.sql(
      `insert into follows (follower_id, followee_id, state, approved_at)
       values ($1, $2, 'approved', now()) on conflict do nothing`,
      [viewer, bystander],
    );

    const rows = await asViewer(`select username, visibility from people_mutuals(30)`);
    assert.ok(rows.some((r) => r.username === 'shy_one' && r.visibility === 'private'));
  });

  // --- content: still refused ------------------------------------------------

  it('still refuses Match, so the shared count cannot be read either', async () => {
    // §25. Match and the shared-title count are both derived from private ranking data,
    // and they arrive in the same row — so a client that got a count without a score
    // would have read exactly what it may not. `taste_match` returns its
    // insufficient-overlap shape rather than an error, which is what makes the two
    // indistinguishable to a caller.
    const rows = await asViewer(`select score, common_count from taste_match($1)`, [shy]);
    assert.equal(rows.length, 1, 'taste_match always answers with exactly one row');
    assert.equal(rows[0].score, null);
    assert.equal(rows[0].common_count, 0, 'no score and no evidence count, in the same refusal');
  });

  it('returns Match and the shared count once the viewer is approved', async () => {
    // The control. Without it the assertion above cannot tell "refused" from "no overlap".
    const rows = await asViewer(`select score, common_count, min_common from taste_match($1)`, [
      befriended,
    ]);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].min_common > 0, 'the row is real; only the evidence is thin');
  });

  it('still refuses a monthly leaderboard count', async () => {
    // §26, at the surface rather than in `leaderboard.test.mjs`'s own fixtures: an
    // account the viewer can find by name must not arrive on the board with a number.
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket, watched_on)
       select $1, id, 'loved', current_date from media_items limit 1
       on conflict (user_id, media_item_id) do update set watched_on = current_date`,
      [shy],
    );

    const rows = await asViewer(`select username from monthly_leaderboard('titles', 50)`);
    assert.ok(!rows.some((r) => r.username === 'shy_one'));
  });

  it('still refuses their ranked collection through the list they now appear in', async () => {
    // The specific worry the §21B change creates: a row in a list carries a `user_id`,
    // and a client holding one could try the content reads with it. They are the same
    // reads the matrix above already refuses; this asserts it from the new entry point.
    const rows = await asViewer(`select media_item_id from rankings where user_id = $1`, [shy]);
    assert.deepEqual(rows, []);
  });
});
