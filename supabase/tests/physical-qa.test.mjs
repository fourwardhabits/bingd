import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb, createTestDbBefore } from './harness.mjs';

/**
 * The founder's final physical-QA tranche — `20260901000100`.
 *
 * Four unrelated server corrections that share one migration because they share one
 * deploy, and one file because each is a handful of assertions rather than a suite:
 *
 *   1. **Comments and reviews are different awards.** Comment Gremlin counted both and
 *      said so on the row. It counts comments now; a published review moves nothing.
 *      The historical treatment is the expensive half: a tier already on the ledger
 *      that the comments-only count no longer supports is revoked, along with the
 *      announcements that hang off it, so no surface goes on claiming an award the
 *      Awards sheet no longer shows.
 *   2. **A causal group reads in the order it happened**, and it took two keys because
 *      the two derived events fail differently. An award is written in the ranking's
 *      own transaction, so its `created_at` ties to the microsecond and `causal_step`
 *      is what breaks it. A goal completion is not: it is caused by a watch date,
 *      `log_watched` posts no activity, and the celebration commits seconds after the
 *      ranking — a real later timestamp that no tiebreak can reach, so it carries a
 *      `causal_at` naming the activity it belongs under.
 *
 *      **The direction was corrected on 2026-08-30** (20260902000100). `causal_step`
 *      ascended, which put a ranking above the award it earned; this feed is reverse
 *      chronological and the award is the later event, so the canonical clause is
 *      `causal_at desc, causal_step DESC, id asc` and every reader in this file states
 *      it. The mechanism, the column and its writers are untouched — only the direction
 *      the group is read in.
 *   3. **The invitee's welcome stays in the app.** The inbox row is untouched; the
 *      lock-screen copy of it is gone.
 *   4. **The inbox knows what kind of activity a row is about**, so it can say "your
 *      Marty Supreme watch" without asserting a watch that never happened.
 *
 * The no-repeat ranking invariant from the same migration lives in
 * `ranking-sessions.test.mjs`, beside the skip tests it corrects.
 */

const MIGRATION = '20260901000100_a_comparison_you_are_not_asked_twice.sql';

let t;
let seq = 991000;

const movie = (title) => t.createMovie(title, seq++);

const metric = async (db, user, award, threshold = 20) =>
  Number(
    (await db.sql(`select _award_metric($1, $2, $3) as m`, [user, award, threshold])).rows[0].m,
  );

/** An activity to hang comments on. Written directly: the awards read `comments`. */
const eventOf = async (db, actor, mediaItemId) =>
  (
    await db.sql(
      `insert into feed_events (actor_id, type, media_item_id, payload)
       values ($1, 'title_ranked', $2, '{"position":1,"bucket":"loved","category":"movies","score":10}')
       returning id`,
      [actor, mediaItemId],
    )
  ).rows[0].id;

/** `n` comments by `who`, written straight in — `award_on_comment` fires on inserts. */
const writeComments = async (db, who, event, n, tag) => {
  for (let i = 0; i < n; i += 1) {
    await db.sql(`insert into comments (feed_event_id, author_id, body) values ($1, $2, $3)`, [
      event,
      who,
      `${tag} ${i}`,
    ]);
  }
};

/** `n` published reviews by `who` — a public note on a logged movie. */
const writeReviews = async (db, who, n, tag) => {
  for (let i = 0; i < n; i += 1) {
    const id = await db.createMovie(`${tag}_${seq}`, seq++);
    await db.sql(
      `insert into user_media (user_id, media_item_id, bucket, note, note_visibility)
       values ($1, $2, 'loved', $3, 'public')`,
      [who, id, `${tag} review ${i}`],
    );
  }
};

before(async () => {
  t = await createTestDb();
});

after(async () => t?.close());

// ---------------------------------------------------------------------------
// 1. Comment Gremlin counts comments
// ---------------------------------------------------------------------------

describe('comments and reviews are different awards', () => {
  it('a published review does not advance the comment track', async () => {
    const writer = await t.createUser({ username: 'cg_reviewer' });
    await writeReviews(t, writer, 5, 'cg_review');

    assert.equal(
      await metric(t, writer, 'comment-gremlin'),
      0,
      'five published reviews moved a track that is about comments',
    );
  });

  it('a comment does', async () => {
    const writer = await t.createUser({ username: 'cg_commenter' });
    const film = await movie('cg_subject');
    const event = await eventOf(t, writer, film);

    await writeComments(t, writer, event, 3, 'cg');

    assert.equal(await metric(t, writer, 'comment-gremlin'), 3);
  });

  it('and the two do not add together', async () => {
    const writer = await t.createUser({ username: 'cg_both' });
    const film = await movie('cg_both_subject');
    const event = await eventOf(t, writer, film);

    await writeComments(t, writer, event, 4, 'cg_both');
    await writeReviews(t, writer, 6, 'cg_both_review');

    assert.equal(
      await metric(t, writer, 'comment-gremlin'),
      4,
      'the metric is comments alone; ten was the old combined count',
    );
  });

  it('publishing a review announces nothing — the note trigger is gone', async () => {
    const writer = await t.createUser({ username: 'cg_no_trigger' });
    const film = await movie('cg_trigger_subject');
    const event = await eventOf(t, writer, film);

    // One short of Whisper on comments alone.
    await writeComments(t, writer, event, 19, 'cg_edge');
    // Then publish a review, which under the old rule was the twentieth contribution
    // and would have crossed the tier.
    await writeReviews(t, writer, 1, 'cg_edge_review');

    const { rows } = await t.sql(
      `select 1 from award_unlocks where user_id = $1 and award_key = 'comment-gremlin'`,
      [writer],
    );
    assert.equal(rows.length, 0, 'a review unlocked a comment tier');
  });

  it('the twentieth comment still crosses Whisper, once', async () => {
    const writer = await t.createUser({ username: 'cg_whisper' });
    const film = await movie('cg_whisper_subject');
    const event = await eventOf(t, writer, film);

    await writeComments(t, writer, event, 20, 'cg_whisper');

    const unlocks = (
      await t.sql(
        `select tier_key, announced from award_unlocks
          where user_id = $1 and award_key = 'comment-gremlin'`,
        [writer],
      )
    ).rows;
    assert.deepEqual(unlocks, [{ tier_key: 'whisper', announced: true }]);

    const posts = await t.sql(
      `select 1 from feed_events
        where actor_id = $1 and type = 'award_earned' and payload ->> 'award' = 'comment-gremlin'`,
      [writer],
    );
    assert.equal(posts.rows.length, 1, 'exactly one post');
  });
});

// ---------------------------------------------------------------------------
// 2. The reconciliation of tiers earned under the combined rule
// ---------------------------------------------------------------------------

describe('the historical award reconciliation', () => {
  let t2;

  after(async () => t2?.close());

  it('revokes a tier the comments-only count no longer supports, and leaves one it does', async () => {
    t2 = await createTestDbBefore(MIGRATION);

    // Whisper is 20. One account reaches it on 15 comments and 5 reviews — a tier the
    // new rule does not support. The other reaches it on 20 comments, which it does.
    const mixed = await t2.createUser({ username: 'recon_mixed' });
    const pure = await t2.createUser({ username: 'recon_pure' });

    const film = await t2.createMovie('recon_subject', seq++);
    const mixedEvent = await eventOf(t2, mixed, film);
    const pureEvent = await eventOf(t2, pure, film);

    await writeComments(t2, mixed, mixedEvent, 15, 'recon_mixed');
    await writeReviews(t2, mixed, 5, 'recon_mixed_review');
    await writeComments(t2, pure, pureEvent, 20, 'recon_pure');

    // Both should hold Whisper under the OLD rule, and both should have announced it.
    const before = async (who) =>
      (
        await t2.sql(
          `select tier_key from award_unlocks where user_id = $1 and award_key = 'comment-gremlin'`,
          [who],
        )
      ).rows;
    assert.deepEqual(await before(mixed), [{ tier_key: 'whisper' }], 'fixture: mixed earned it');
    assert.deepEqual(await before(pure), [{ tier_key: 'whisper' }], 'fixture: pure earned it');

    const postsBefore = await t2.sql(
      `select actor_id from feed_events where type = 'award_earned'
        and payload ->> 'award' = 'comment-gremlin'`,
    );
    assert.equal(postsBefore.rows.length, 2, 'fixture: both announced');

    await t2.applyMigration(MIGRATION);

    assert.deepEqual(
      await before(mixed),
      [],
      'a tier the comments-only count cannot support must not survive',
    );
    assert.deepEqual(
      await before(pure),
      [{ tier_key: 'whisper' }],
      'a tier earned on comments alone must be left exactly alone',
    );

    // The announcements go with the tier they announced, and only those.
    const posts = (
      await t2.sql(
        `select actor_id from feed_events where type = 'award_earned'
          and payload ->> 'award' = 'comment-gremlin'`,
      )
    ).rows.map((r) => r.actor_id);
    assert.deepEqual(posts, [pure], 'the revoked tier kept a feed post claiming it');

    const inbox = (
      await t2.sql(
        `select recipient_id from notifications where type = 'award_earned'
          and payload ->> 'award' = 'comment-gremlin'`,
      )
    ).rows.map((r) => r.recipient_id);
    assert.deepEqual(inbox, [pure], 'the revoked tier kept a congratulations claiming it');

    // Nothing else on the ledger was touched: the reconciliation is scoped to one
    // track by its own predicate, and this is the assertion that says so.
    const others = await t2.sql(
      `select 1 from award_unlocks where award_key <> 'comment-gremlin'`,
    );
    assert.equal(others.rows.length, 0, 'fixture has no other awards, so this proves scope');
  });

  it('and a revoked tier can be earned again, announcing once', async () => {
    // Five more comments carry `mixed` from 15 to 20 on the new rule.
    const mixed = (
      await t2.sql(`select id from profiles where username = 'recon_mixed'`)
    ).rows[0].id;
    const film = (await t2.sql(`select id from media_items limit 1`)).rows[0].id;
    const event = await eventOf(t2, mixed, film);

    await writeComments(t2, mixed, event, 5, 'recon_again');

    const unlocks = (
      await t2.sql(
        `select tier_key, announced from award_unlocks
          where user_id = $1 and award_key = 'comment-gremlin'`,
        [mixed],
      )
    ).rows;
    assert.deepEqual(unlocks, [{ tier_key: 'whisper', announced: true }]);

    const posts = await t2.sql(
      `select 1 from feed_events where actor_id = $1 and type = 'award_earned'
        and payload ->> 'award' = 'comment-gremlin'`,
      [mixed],
    );
    assert.equal(posts.rows.length, 1, 'one post, not a second one beside a deleted first');
  });
});

// ---------------------------------------------------------------------------
// 3. The feed's causal order
// ---------------------------------------------------------------------------

describe('a causal group reads in the order it happened', () => {
  it('puts a goal completed by a later write above the ranking that earned it', async () => {
    // The founder's flow exactly: rank the film, then give it a watch date from the
    // post-rank sheet. `log_watched` posts no activity, so the completion commits
    // SECONDS AFTER the ranking and is genuinely the newer row — which is why a
    // tiebreak could not have fixed this and `causal_at` had to.
    const user = await t.createUser({ username: 'causal_goal' });
    await t.actAs(user);

    const year = new Date().getUTCFullYear();
    await t.sql(
      `insert into watch_goals (user_id, year, category, target) values ($1, $2, 'movies', 1)`,
      [user, year],
    );

    const film = await movie('causal_goal_film');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);

    // A separate statement, and therefore a separate instant — the point of the test.
    await t.sql(
      `update user_media set watched_on = make_date($3, 6, 1)
        where user_id = $1 and media_item_id = $2`,
      [user, film, year],
    );

    const rows = (
      await t.sql(
        `select type, causal_step, causal_at, created_at from feed_events
          where actor_id = $1 order by causal_at desc, causal_step desc, id asc`,
        [user],
      )
    ).rows;

    const ranked = rows.find((r) => r.type === 'title_ranked');
    const goal = rows.find((r) => r.type === 'goal_completed');
    assert.ok(ranked, 'the ranking posted');
    assert.ok(goal, 'the goal completed');
    assert.equal(ranked.causal_step, 0, 'the act itself is step 0');
    assert.equal(goal.causal_step, 1, 'its goal is step 1');

    // The two timestamps genuinely differ. If this ever stops being true the test has
    // stopped exercising the thing it was written for.
    assert.ok(
      new Date(goal.created_at).getTime() >= new Date(ranked.created_at).getTime(),
      'fixture: the completion must be the later write',
    );
    assert.equal(
      new Date(goal.causal_at).getTime(),
      new Date(ranked.created_at).getTime(),
      'the completion must sort at the ranking it belongs under',
    );

    assert.deepEqual(
      rows.map((r) => r.type),
      ['goal_completed', 'title_ranked'],
      'the celebration is the later event and belongs above its cause',
    );
  });

  it('leaves a goal completed by an unrelated date correction at its own moment', async () => {
    // The guard on the inheritance. Correcting the date of a film ranked long ago can
    // also complete a goal; borrowing that film's timestamp would bury the celebration
    // wherever that ranking sits. The test for it is a fact — "is this the reader's
    // newest activity" — and not an interval.
    const user = await t.createUser({ username: 'causal_stale' });
    const year = new Date().getUTCFullYear();
    await t.sql(
      `insert into watch_goals (user_id, year, category, target) values ($1, $2, 'movies', 1)`,
      [user, year],
    );

    const old = await movie('causal_stale_old');
    const recent = await movie('causal_stale_recent');
    await t.actAs(user);
    await t.rankToCompletion(old, 'loved', async (pivot) => pivot);
    await t.rankToCompletion(recent, 'loved', async (pivot) => pivot);

    // The date lands on the OLDER film, so the reader's newest activity is about the
    // other one and nothing may be inherited.
    await t.sql(
      `update user_media set watched_on = make_date($3, 6, 1)
        where user_id = $1 and media_item_id = $2`,
      [user, old, year],
    );

    const goal = (
      await t.sql(
        `select causal_at, created_at from feed_events
          where actor_id = $1 and type = 'goal_completed'`,
        [user],
      )
    ).rows[0];
    assert.ok(goal, 'the goal still completed');
    assert.equal(
      new Date(goal.causal_at).getTime(),
      new Date(goal.created_at).getTime(),
      'an unrelated correction must not move the celebration down the feed',
    );
  });

  it('awards are step 2 and up, in the order the detector was given them', async () => {
    const earner = await t.createUser({ username: 'causal_awards' });

    // Two tracks over their bronze, crossed by the triggers as they were built.
    for (let i = 0; i < 5; i += 1) {
      const p = await t.createUser({ username: `causal_p${i}` });
      await t.sql(
        `insert into follows (follower_id, followee_id, state, approved_at)
         values ($1, $2, 'approved', now()), ($2, $1, 'approved', now())`,
        [earner, p],
      );
    }
    for (let i = 0; i < 3; i += 1) {
      const invitee = await t.createUser({ username: `causal_i${i}` });
      await t.sql(
        `insert into invite_attributions (invitee_id, inviter_id, accepted_at, activated_at)
         values ($1, $2, now(), now())`,
        [invitee, earner],
      );
    }

    // Wipe what the triggers announced one at a time and re-run the detector with both
    // tracks in one call, which is the shape a single action produces.
    await t.sql(`delete from award_unlocks where user_id = $1`, [earner]);
    await t.sql(`delete from feed_events where actor_id = $1 and type = 'award_earned'`, [earner]);
    await t.sql(`delete from notifications where recipient_id = $1 and type = 'award_earned'`, [
      earner,
    ]);

    await t.sql(`select _maybe_award_unlocks($1, array['mutual-mania','invite-instigator'])`, [
      earner,
    ]);

    const rows = (
      await t.sql(
        `select payload ->> 'award' as award, causal_step from feed_events
          where actor_id = $1 and type = 'award_earned'
          order by causal_at desc, causal_step desc, id asc`,
        [earner],
      )
    ).rows;

    // The steps are assigned in the order `_maybe_award_unlocks` walks `p_awards`, and
    // the feed reads them back newest-first — so the last track announced is the first
    // one seen. That is the same "later above" rule applied inside the group rather than
    // a second convention: an action that earns two awards announced them in sequence,
    // and a reverse-chronological list shows the sequence in reverse.
    assert.deepEqual(rows, [
      { award: 'invite-instigator', causal_step: 3 },
      { award: 'mutual-mania', causal_step: 2 },
    ]);

    // Deterministic is the property, not the direction: read twice, same answer. This is
    // what pagination and refetch depend on, and it is why the steps exist at all —
    // without them these two rows share a timestamp and the plan decides.
    const again = (
      await t.sql(
        `select payload ->> 'award' as award, causal_step from feed_events
          where actor_id = $1 and type = 'award_earned'
          order by causal_at desc, causal_step desc, id asc`,
        [earner],
      )
    ).rows;
    assert.deepEqual(again, rows);
  });

  it('orders a tied group the same way however the rows were written', async () => {
    // The pagination and refetch property, stated directly: the canonical order is a
    // total one, so a group whose rows were inserted backwards still reads forwards.
    const user = await t.createUser({ username: 'causal_stable' });
    const film = await movie('causal_stable_film');

    await t.sql(
      `insert into feed_events (actor_id, type, media_item_id, causal_step, payload, created_at, causal_at)
       values
         ($1, 'award_earned', null, 3, '{"award":"b","tier":"bronze"}', '2026-08-29T12:00:00Z', '2026-08-29T12:00:00Z'),
         ($1, 'award_earned', null, 2, '{"award":"a","tier":"bronze"}', '2026-08-29T12:00:00Z', '2026-08-29T12:00:00Z'),
         ($1, 'goal_completed', null, 1, '{"year":2026,"category":"movies","target":1}', '2026-08-29T12:00:00Z', '2026-08-29T12:00:00Z'),
         ($1, 'title_ranked', $2, 0, '{"position":1}', '2026-08-29T12:00:00Z', '2026-08-29T12:00:00Z')`,
      [user, film],
    );

    const rows = (
      await t.sql(
        `select type, causal_step from feed_events
          where actor_id = $1 order by causal_at desc, causal_step desc, id asc`,
        [user],
      )
    ).rows;

    // Newest downwards: the awards the action earned, then the goal it completed, then
    // the act itself at the foot of its own group.
    assert.deepEqual(
      rows.map((r) => r.type),
      ['award_earned', 'award_earned', 'goal_completed', 'title_ranked'],
    );
    assert.deepEqual(
      rows.map((r) => r.causal_step),
      [3, 2, 1, 0],
    );
  });

  /**
   * **The whole shape, from the act that produces it.**
   *
   * The three assertions above each pin one mechanism. This one runs the founder's
   * acceptance case end to end -- rank a film, have it finish a goal and earn an award,
   * read the feed the way the client reads it -- because the ordering is a property of
   * the three together and each of them is correct in isolation today.
   */
  it('reads award, then goal, then the ranking that caused both', async () => {
    const user = await t.createUser({ username: 'causal_whole' });
    const year = new Date().getUTCFullYear();
    await t.sql(
      `insert into watch_goals (user_id, year, category, target) values ($1, $2, 'movies', 1)`,
      [user, year],
    );
    await t.actAs(user);

    const film = await movie('causal_whole_film');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);

    // Movie Muncher's first tier, earned by the same collection row the ranking wrote.
    // Announced inside the ranking's transaction, so it shares `causal_at` with it.
    await t.sql(
      `insert into feed_events (actor_id, type, causal_step, payload, created_at, causal_at)
       select $1, 'award_earned', 2, '{"award":"movie-muncher","tier":"bronze"}',
              fe.created_at, fe.causal_at
         from feed_events fe
        where fe.actor_id = $1 and fe.type = 'title_ranked'`,
      [user],
    );

    // The watch date, in its own statement and therefore its own instant. This is the
    // goal's cause and it posts no activity of its own.
    await t.sql(
      `update user_media set watched_on = make_date($3, 6, 1)
        where user_id = $1 and media_item_id = $2`,
      [user, film, year],
    );

    const rows = (
      await t.sql(
        `select type, causal_step from feed_events
          where actor_id = $1 order by causal_at desc, causal_step desc, id asc`,
        [user],
      )
    ).rows;

    assert.deepEqual(
      rows.map((r) => r.type),
      ['award_earned', 'goal_completed', 'title_ranked'],
      'the founder acceptance order: consequences above the act, newest first',
    );
  });

  /**
   * **Nothing is congratulated before the act that earns it has finished.**
   *
   * The founder's requirement, and the schema meets it structurally rather than by
   * timing: every announcement is written by an AFTER-ROW trigger inside the writer's
   * own transaction, so it commits when the writer commits or not at all. These two
   * assert the two halves that could be got wrong.
   */
  it('announces nothing for a ranking session that is opened and abandoned', async () => {
    const user = await t.createUser({ username: 'causal_abandoned' });
    await t.actAs(user);
    const film = await movie('causal_abandoned_film');

    // A session, and no finalise. `rank_start` writes a `ranking_sessions` row and
    // nothing else -- no `rankings`, no `user_media`, so no trigger fires.
    await t.sql(`select rank_start($1, 'loved', gen_random_uuid())`, [film]);

    const posts = await t.sql(
      `select 1 from feed_events where actor_id = $1 and type in ('award_earned','goal_completed')`,
      [user],
    );
    const inbox = await t.sql(
      `select 1 from notifications where recipient_id = $1 and type in ('award_earned','goal_completed')`,
      [user],
    );
    assert.equal(posts.rows.length, 0, 'an abandoned session must congratulate nobody');
    assert.equal(inbox.rows.length, 0, 'and must put nothing in the inbox either');
  });

  /**
   * **The Log sheet's own flow, which is the one the founder actually taps.**
   *
   * Independent review 76 found the first two assertions in this block were about the
   * wrong flow. Ranking a title straight from search writes the collection row inside
   * `_rank_finalize`, so the award and the activity share a transaction and
   * `causal_step` orders them. **The Log sheet does not**: its first tap is
   * `set_bucket` -- "bucketing implies logging" -- the collection award triggers fire
   * there, and `title_ranked` is posted a minute later when the comparisons finish. Two
   * different `causal_at`, so `causal_step` is never consulted, and the feed showed
   *
   *     Suraj ranked Whiplash            <- the later row, on top
   *     Suraj earned Movie Muncher       <- the award it looks like it earned
   *
   * which is founder acceptance A failing through the commonest path in the app.
   * `_rank_finalize` now adopts it (20260902000100 §2b).
   */
  const crossMovieMuncher = async (username) => {
    const user = await t.createUser({ username });
    // Forty-nine written straight in, so no award is announced getting there; the
    // fiftieth is the crossing and the only announcement in the fixture.
    for (let i = 0; i < 49; i += 1) {
      await t.sql(
        `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`,
        [user, await movie(`${username} filler ${i}`)],
      );
    }
    return user;
  };

  const feedOf = async (user) =>
    (
      await t.sql(
        `select type, payload ->> 'award' as award from feed_events
          where actor_id = $1 order by causal_at desc, causal_step desc, id asc`,
        [user],
      )
    ).rows;

  it('puts an award earned by the bucket tap above the ranking that followed it', async () => {
    const user = await crossMovieMuncher('causal_logfirst');
    await t.actAs(user);
    const film = await movie('causal_logfirst_film');

    // The Log sheet, in its two steps and in its own order.
    await t.sql(`select set_bucket(gen_random_uuid(), $1, 'loved')`, [film]);
    const announced = await feedOf(user);
    assert.deepEqual(
      announced.map((r) => r.type),
      ['award_earned'],
      'fixture: the bucket tap is what announces the award, before any ranking exists',
    );

    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);

    assert.deepEqual(
      (await feedOf(user)).map((r) => r.type),
      ['award_earned', 'title_ranked'],
      'the award belongs above the ranking, even though it was written a minute earlier',
    );
  });

  it('does the same for a goal the log sheet completed with its date stamp', async () => {
    // **The Log sheet fires twice**, which is why the adoption is a range and not an
    // equality. The bucket tap creates the collection row and the award announces
    // there; the sheet then stamps the watch date in its own call, and a goal crossing
    // announces at *that* instant instead -- a different timestamp again, still before
    // the ranking, still unclaimed by any activity.
    const user = await t.createUser({ username: 'causal_goal_logfirst' });
    const year = new Date().getUTCFullYear();
    await t.sql(
      `insert into watch_goals (user_id, year, category, target) values ($1, $2, 'movies', 1)`,
      [user, year],
    );
    await t.actAs(user);

    const film = await movie('causal_goal_logfirst_film');

    // Step one: the bucket. No date yet, so no goal.
    await t.sql(`select set_bucket(gen_random_uuid(), $1, 'loved')`, [film]);
    // Step two: the sheet's own date stamp, in its own statement and its own instant.
    await t.sql(`select log_watched(gen_random_uuid(), $1, make_date($2, 6, 1))`, [film, year]);

    const beforeRanking = (
      await t.sql(
        `select type from feed_events where actor_id = $1 order by causal_at desc`,
        [user],
      )
    ).rows;
    assert.deepEqual(
      beforeRanking.map((r) => r.type),
      ['goal_completed'],
      'fixture: the goal is announced by the date stamp, before any ranking exists',
    );

    // Step three: the comparisons.
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);

    assert.deepEqual(
      (await feedOf(user)).map((r) => r.type),
      ['goal_completed', 'title_ranked'],
      'the celebration belongs above the ranking, whichever of the log sheet calls announced it',
    );
  });

  it('never adopts an award another title earned in the same sitting', async () => {
    /**
     * **Independent review 76b, and it is why the link is a column rather than a clock.**
     *
     * The first version of the adoption bounded itself by timestamps: at or after this
     * title's `user_media.created_at`, before this activity, with nothing of the
     * reader's in between. Every one of those is satisfied by a *different* title's
     * award, because two logs seconds apart in one sitting produce no activity at all:
     *
     *   1. log A -- no crossing;
     *   2. log B -- B crosses a tier and an award is announced;
     *   3. rank A.
     *
     * B's award was adopted into A's group and shown to A's followers as the consequence
     * of ranking A. `feed_event_causes` is the fix: the writer says which title
     * announced it, so nothing about *when* has to be inferred.
     */
    const user = await t.createUser({ username: 'causal_crosstitle' });
    // Forty-eight, so the FIFTIETH crosses Movie Muncher -- and the fiftieth is B.
    for (let i = 0; i < 48; i += 1) {
      await t.sql(
        `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`,
        [user, await movie(`causal_crosstitle filler ${i}`)],
      );
    }
    await t.actAs(user);

    const a = await movie('causal_crosstitle_a');
    const b = await movie('causal_crosstitle_b');

    // A is the forty-ninth and crosses nothing.
    await t.sql(`select set_bucket(gen_random_uuid(), $1, 'loved')`, [a]);
    // B is the fiftieth and is what earns the award.
    await t.sql(`select set_bucket(gen_random_uuid(), $1, 'loved')`, [b]);

    const award = (
      await t.sql(
        `select fe.id, fe.causal_at, fc.media_item_id as cause
           from feed_events fe
           left join feed_event_causes fc on fc.feed_event_id = fe.id
          where fe.actor_id = $1 and fe.type = 'award_earned'`,
        [user],
      )
    ).rows;
    assert.equal(award.length, 1, 'fixture: exactly one award, and B is what earned it');
    assert.equal(award[0].cause, b, 'and the writer said so');

    // Now A is ranked. Nothing of the reader's has happened in between, and the award
    // is newer than A's own collection row -- every timestamp bound the first version
    // had is satisfied here.
    await t.rankToCompletion(a, 'loved', async (pivot) => pivot);

    const after = (
      await t.sql(`select causal_at from feed_events where id = $1`, [award[0].id])
    ).rows[0];
    assert.equal(
      new Date(after.causal_at).getTime(),
      new Date(award[0].causal_at).getTime(),
      "B's award must not be presented as the consequence of ranking A",
    );

    // And the feed says the same thing the other way round: the award is below A's
    // ranking, because it genuinely happened before it and belongs to neither.
    assert.deepEqual(
      (await feedOf(user)).map((r) => r.type),
      ['title_ranked', 'award_earned'],
    );
  });

  it('adopts B\'s own award when B is the title being ranked', async () => {
    // The control, and it is what stops the assertion above from passing for the wrong
    // reason -- an adoption that had simply stopped working would satisfy it too.
    const user = await t.createUser({ username: 'causal_crosstitle_ctl' });
    for (let i = 0; i < 49; i += 1) {
      await t.sql(
        `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`,
        [user, await movie(`causal_ctl filler ${i}`)],
      );
    }
    await t.actAs(user);

    const b = await movie('causal_ctl_b');
    await t.sql(`select set_bucket(gen_random_uuid(), $1, 'loved')`, [b]);
    await t.rankToCompletion(b, 'loved', async (pivot) => pivot);

    assert.deepEqual(
      (await feedOf(user)).map((r) => r.type),
      ['award_earned', 'title_ranked'],
      'the title that earned it does adopt it',
    );
  });

  it('names no title on an award that no collection write announced', async () => {
    // Eight of the nine call sites have no title to name -- a comment, a reaction, a
    // follow, an invite. Null there is not an oversight: it is what stops a ranking
    // adopting an award that had nothing to do with a title at all.
    const author = await t.createUser({ username: 'causal_no_title' });
    const other = await t.createUser({ username: 'causal_no_title_host' });
    const film = await movie('causal_no_title_film');
    const event = await eventOf(t, other, film);
    await writeComments(t, author, event, 20, 'no_title');

    const rows = (
      await t.sql(
        `select fe.id, fc.media_item_id as cause
           from feed_events fe
           left join feed_event_causes fc on fc.feed_event_id = fe.id
          where fe.actor_id = $1 and fe.type = 'award_earned'`,
        [author],
      )
    ).rows;
    assert.ok(rows.length > 0, 'fixture: the comment track announced');
    for (const row of rows) assert.equal(row.cause, null);
  });

  it('lets no client read which title an award came from', async () => {
    /**
     * **Independent review 76c**, and it is why the link is a side table rather than a
     * column on `feed_events`.
     *
     * `feed_events_read` authorises **whole rows** on `can_i_view(actor_id)` — there is
     * no column-level projection anywhere in this schema — so a column would have been
     * readable by any client allowed to see the award. That is a disclosure the award row
     * exists to refuse: `media_item_id` is left null on `award_earned` precisely so the
     * row does not name a title.
     *
     * The sharpest case is 76c's own: earn an award on a title and then remove it from
     * the collection. The award event survives — `remove_from_collection` deliberately
     * does not touch it — so the link would have named a title the collection itself no
     * longer shows.
     */
    const earner = await crossMovieMuncher('causal_cause_private');
    await t.actAs(earner);
    const film = await movie('causal_cause_private_film');
    await t.sql(`select set_bucket(gen_random_uuid(), $1, 'loved')`, [film]);

    // The cause was recorded, so the assertion below is about reachability rather than
    // about an empty table.
    const rows = (await t.sql(`select * from feed_event_causes`)).rows;
    assert.ok(
      rows.some((r) => r.media_item_id === film),
      'fixture: the bucket tap recorded which title announced the award',
    );

    // And no client role can reach it. Two independent refusals, which is the shape
    // `push_outbox` uses: the grant is revoked, and RLS is on with no policy behind it.
    const viewer = await t.createUser({ username: 'causal_cause_reader' });
    const denied = await t.asRole('authenticated', viewer, () =>
      t.errorFrom(`select * from feed_event_causes`),
    );
    assert.ok(denied, 'an authenticated client must not be able to select from it');

    const anon = await t.asAnon(() => t.errorFrom(`select * from feed_event_causes`));
    assert.ok(anon, 'nor anon');

    // The award itself is still readable, and still says nothing about a title — which
    // is the property the side table was written to preserve.
    const event = (
      await t.sql(
        `select media_item_id, payload from feed_events
          where actor_id = $1 and type = 'award_earned'`,
        [earner],
      )
    ).rows[0];
    assert.equal(event.media_item_id, null, 'an award row names no title, as before');
    assert.deepEqual(
      Object.keys(event.payload).sort(),
      ['award', 'award_name', 'tier', 'tier_label'],
      'and its payload is the four keys it has always been',
    );
  });

  it('drops the cause when the title leaves the collection, so a later log cannot reuse it', async () => {
    /**
     * **Independent review 76d**, and the reason the cause is keyed to the collection row
     * rather than to the title.
     *
     * A cause is about one **tenure** of a title in one collection. 76d's sequence: log A
     * and earn an award, unlog A -- which `unlog` implements as a delete of the
     * `user_media` row, and `remove_from_collection` likewise -- then months later log
     * A again and rank it. The award event survives both, deliberately. Keyed to the
     * title, the cause survived too, and with no activity in between the months-old award
     * was adopted into the new ranking's group and presented as its consequence: the row
     * had become a reusable adoption token across collection lifetimes.
     */
    const user = await crossMovieMuncher('causal_tenure');
    await t.actAs(user);
    const film = await movie('causal_tenure_film');

    // Tenure one: the bucket tap crosses the tier and announces.
    await t.sql(`select set_bucket(gen_random_uuid(), $1, 'loved')`, [film]);
    const award = (
      await t.sql(
        `select id, causal_at from feed_events where actor_id = $1 and type = 'award_earned'`,
        [user],
      )
    ).rows[0];
    assert.ok(award, 'fixture: the bucket tap announced');
    assert.equal(
      (await t.sql(`select count(*)::int as n from feed_event_causes where feed_event_id = $1`, [
        award.id,
      ])).rows[0].n,
      1,
      'fixture: and recorded which title announced it',
    );

    // The tenure ends. The announcement survives -- it is a past-tense fact about an act.
    await t.sql(`select unlog(gen_random_uuid(), $1)`, [film]);
    assert.equal(
      (await t.sql(`select count(*)::int as n from feed_events where id = $1`, [award.id]))
        .rows[0].n,
      1,
      'the award itself is never taken back by an unlog',
    );
    assert.equal(
      (await t.sql(`select count(*)::int as n from feed_event_causes where feed_event_id = $1`, [
        award.id,
      ])).rows[0].n,
      0,
      'but the cause went with the collection row',
    );

    // Tenure two, much later, with nothing of the reader's in between.
    await t.sql(`select set_bucket(gen_random_uuid(), $1, 'loved')`, [film]);
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);

    const after = (
      await t.sql(`select causal_at from feed_events where id = $1`, [award.id])
    ).rows[0];
    assert.equal(
      new Date(after.causal_at).getTime(),
      new Date(award.causal_at).getTime(),
      'a months-old award must not become the consequence of a later ranking',
    );
  });

  it('leaves a goal alone when the ranking it already sits under is ranked again', async () => {
    /**
     * The narrower second route, found by probing the guard rather than reported.
     *
     * A goal completed by a date taken **after** a ranking inherits that ranking's own
     * `causal_at` (`_maybe_goal_completion`) -- so it sits at the same instant as the
     * activity that already claimed it. A strict `>` in the intervening test did not see
     * that activity as intervening at all, so Rank again on the same title, months later
     * with nothing else between, moved the old celebration up to the new ranking. An
     * activity **at** the announcement's instant has claimed it just as surely as one
     * after it, which is what `>=` says.
     */
    const user = await t.createUser({ username: 'causal_again' });
    const year = new Date().getUTCFullYear();
    await t.sql(
      `insert into watch_goals (user_id, year, category, target) values ($1, $2, 'movies', 1)`,
      [user, year],
    );
    await t.actAs(user);
    const film = await movie('causal_again_film');

    // Rank first, then the date -- which is the flow the backwards inheritance is for.
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    await t.sql(
      `update user_media set watched_on = make_date($3, 6, 1)
        where user_id = $1 and media_item_id = $2`,
      [user, film, year],
    );

    const goal = (
      await t.sql(
        `select id, causal_at from feed_events where actor_id = $1 and type = 'goal_completed'`,
        [user],
      )
    ).rows[0];
    assert.ok(goal, 'fixture: the goal completed and inherited the ranking it sits under');

    // Rank again, as a new watch. Nothing else of the reader's has happened.
    let step = (
      await t.sql(`select rank_again($1, 'loved', gen_random_uuid(), true) as r`, [film])
    ).rows[0].r;
    let guard = 0;
    while (!step.done && guard++ < 64) {
      step = (await t.sql(`select rank_answer($1, $2) as r`, [step.session_id, step.pivot]))
        .rows[0].r;
    }

    const after = (
      await t.sql(`select causal_at from feed_events where id = $1`, [goal.id])
    ).rows[0];
    assert.equal(
      new Date(after.causal_at).getTime(),
      new Date(goal.causal_at).getTime(),
      'a celebration an activity has already claimed stays where it is',
    );
  });

  it('leaves an old award where it is when unrelated activity happened in between', async () => {
    // The guard, and the reason it is a fact rather than an interval. A film logged in
    // March and ranked today must not haul a five-month-old award to the top of the
    // feed -- which is the defect `_maybe_goal_completion` avoids from the other side.
    const user = await crossMovieMuncher('causal_stale_award');
    await t.actAs(user);

    const logged = await movie('causal_stale_award_logged');
    await t.sql(`select set_bucket(gen_random_uuid(), $1, 'loved')`, [logged]);

    // Something else entirely, ranked in between.
    const other = await movie('causal_stale_award_other');
    await t.rankToCompletion(other, 'loved', async (pivot) => pivot);

    const before = (
      await t.sql(
        `select causal_at from feed_events where actor_id = $1 and type = 'award_earned'`,
        [user],
      )
    ).rows[0].causal_at;

    // And only now the first film is ranked.
    await t.rankToCompletion(logged, 'loved', async (pivot) => pivot);

    const after = (
      await t.sql(
        `select causal_at from feed_events where actor_id = $1 and type = 'award_earned'`,
        [user],
      )
    ).rows[0].causal_at;

    assert.equal(
      new Date(after).getTime(),
      new Date(before).getTime(),
      'an award with activity between it and this ranking keeps its own moment',
    );
  });

  it('adopts nothing when the ranking wrote the collection row itself', async () => {
    // The straight-from-search flow. One transaction, one `causal_at`, and
    // `causal_step` is what orders it -- the adoption's strict inequality is what keeps
    // it from touching a row it shares an instant with.
    const user = await crossMovieMuncher('causal_ranked_first');
    await t.actAs(user);
    const film = await movie('causal_ranked_first_film');

    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);

    const rows = (
      await t.sql(
        `select type, causal_at, created_at from feed_events
          where actor_id = $1 order by causal_at desc, causal_step desc, id asc`,
        [user],
      )
    ).rows;

    assert.deepEqual(rows.map((r) => r.type), ['award_earned', 'title_ranked']);
    assert.equal(
      new Date(rows[0].causal_at).getTime(),
      new Date(rows[1].causal_at).getTime(),
      'one transaction, one instant',
    );
    for (const row of rows) {
      assert.equal(
        new Date(row.causal_at).getTime(),
        new Date(row.created_at).getTime(),
        'nothing was adopted, so nothing moved',
      );
    }
  });

  it('leaves created_at alone when it adopts, so the row still says how long ago', async () => {
    // Only the sort key moves. `relativeTime` draws `created_at`, and an award that
    // suddenly claimed to have been earned a minute later than it was would be a
    // different kind of lie from the one being fixed.
    const user = await crossMovieMuncher('causal_created_at');
    await t.actAs(user);
    const film = await movie('causal_created_at_film');

    await t.sql(`select set_bucket(gen_random_uuid(), $1, 'loved')`, [film]);
    const before = (
      await t.sql(
        `select created_at from feed_events where actor_id = $1 and type = 'award_earned'`,
        [user],
      )
    ).rows[0].created_at;

    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);

    const row = (
      await t.sql(
        `select causal_at, created_at from feed_events
          where actor_id = $1 and type = 'award_earned'`,
        [user],
      )
    ).rows[0];

    assert.equal(new Date(row.created_at).getTime(), new Date(before).getTime());
    assert.ok(
      new Date(row.causal_at).getTime() > new Date(row.created_at).getTime(),
      'the sort key moved and the timestamp did not',
    );
  });

  it('creates the inbox row and its push in the same transaction as the act', async () => {
    // "After the causal completion" is the founder's phrasing and one transaction is how
    // it is met: there is no moment at which the congratulations exists and the act does
    // not. Asserted through the outbox, because push is the surface where an early
    // announcement would be irreversible -- a lock-screen banner cannot be recalled.
    const user = await t.createUser({ username: 'causal_push' });
    await t.actAs(user);
    const film = await movie('causal_push_film');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);

    const rows = (
      await t.sql(
        `select n.created_at as told, fe.created_at as acted
           from notifications n
           join feed_events fe
             on fe.actor_id = n.recipient_id and fe.type = 'title_ranked'
          where n.recipient_id = $1 and n.type = 'award_earned'`,
        [user],
      )
    ).rows;

    for (const row of rows) {
      assert.equal(
        new Date(row.told).getTime(),
        new Date(row.acted).getTime(),
        'the congratulations and its cause share a transaction timestamp',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The inbox knows which activity
// ---------------------------------------------------------------------------

describe('my_notifications names the kind of activity', () => {
  it('returns the subject event type, so a comment row can say "watch"', async () => {
    const owner = await t.createUser({ username: 'saytype_owner' });
    const talker = await t.createUser({ username: 'saytype_talker' });
    const film = await movie('saytype_film');
    const event = await eventOf(t, owner, film);

    await t.actAs(talker);
    await t.sql(`select add_comment(gen_random_uuid(), $1, $2, false, null, '{}'::uuid[]) as r`, [
      event,
      'Loved this',
    ]);

    await t.actAs(owner);
    const { rows } = await t.sql(
      `select kind, subject_activity_type from my_notifications(50) where kind = 'comment'`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subject_activity_type, 'title_ranked');
  });

  it('is null where there is no event to name, rather than guessing at one', async () => {
    const reader = await t.createUser({ username: 'saytype_reader' });
    const follower = await t.createUser({ username: 'saytype_follower' });

    await t.sql(
      `insert into notifications (recipient_id, type, actor_id) values ($1, 'follow', $2)`,
      [reader, follower],
    );

    await t.actAs(reader);
    const { rows } = await t.sql(
      `select subject_activity_type from my_notifications(50) where kind = 'follow'`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subject_activity_type, null);
  });
});

// ---------------------------------------------------------------------------
// 5. The welcome is an inbox row and not a push
// ---------------------------------------------------------------------------

describe("the invitee's welcome does not reach a lock screen", () => {
  it('is written, is exempt from the preference gate, and is not queued', async () => {
    const invitee = await t.createUser({ username: 'welcome_quiet' });
    const inviter = await t.createUser({ username: 'welcome_inviter' });

    const { rows } = await t.sql(
      `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
       values ($1, 'invite_welcome', $2, 'profile', $2) returning id`,
      [invitee, inviter],
    );
    const id = rows[0].id;
    assert.ok(id, 'the inbox row must still be written — that half is untouched');

    const queued = await t.sql(`select 1 from push_outbox where notification_id = $1`, [id]);
    assert.equal(queued.rows.length, 0, 'a welcome was queued for the lock screen');

    assert.equal(
      (await t.sql(`select _push_eligible('invite_welcome') as e`)).rows[0].e,
      false,
    );
    // The control: the type beside it on the same code path still is eligible, so this
    // is a decision about one type rather than a broken predicate.
    assert.equal((await t.sql(`select _push_eligible('invite_joined') as e`)).rows[0].e, true);
  });
});
