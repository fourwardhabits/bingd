import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb, createTestDbBefore } from './harness.mjs';

/**
 * Notes as social content, and the community score.
 *
 * 20260816000000. Three properties carry the whole change and each is tested from
 * the outside, as a client would reach it:
 *
 *   1. A note written before this migration stays private. This is the promise the
 *      product already made and the one thing a schema change cannot take back.
 *   2. `public_notes` projects note text and nothing else, and applies AD-5 from the
 *      caller's own perspective -- so a private account's note, a blocked user's
 *      note and a suspended account's note are all absent.
 *   3. `community_score` aggregates the exact media item over public active
 *      accounts, and withholds the number below the configured sample size.
 */

const MIGRATION = '20260816000000_social_notes.sql';

let t;
let alice;
let bob;
let seq = 70000;

const movie = (title) => t.createMovie(title, seq++);

/** Logs a watch with a note, as the acting user, through the real RPC. */
const logNote = async (mediaItemId, note, extra = {}) => {
  const { rows } = await t.sql(
    `select log_watched(gen_random_uuid(), $1, null, $2, $3::note_visibility, $4) as r`,
    [mediaItemId, note, extra.visibility ?? null, extra.spoilers ?? null],
  );
  return rows[0].r;
};

const notesFor = async (userIds, mediaIds) => {
  const { rows } = await t.sql(`select * from public_notes($1::uuid[], $2::uuid[], 50)`, [
    userIds,
    mediaIds,
  ]);
  return rows;
};

before(async () => {
  t = await createTestDb();
  alice = await t.createUser({ username: 'alice_notes' });
  bob = await t.createUser({ username: 'bob_notes' });
  await t.actAs(alice);
});

after(async () => {
  await t?.close();
});

describe('historical notes stay private', () => {
  it('leaves every note that existed before the migration private', async () => {
    // The snapshot database has already run the backfill against an empty table,
    // so the only way to test what it does to real rows is to stop before it.
    const before = await createTestDbBefore(MIGRATION);
    try {
      const user = await before.createUser({ username: 'legacy' });
      const id = await before.createMovie('legacy_note', -99001);
      await before.actAs(user);
      await before.sql(`select log_watched(gen_random_uuid(), $1, null, $2)`, [
        id,
        'written when notes were private',
      ]);

      await before.applyMigration(MIGRATION);

      const { rows } = await before.sql(
        `select note_visibility, note_has_spoilers from user_media
          where user_id = $1 and media_item_id = $2`,
        [user, id],
      );
      assert.equal(rows[0].note_visibility, 'private');
      assert.equal(rows[0].note_has_spoilers, false);
    } finally {
      await before.close();
    }
  });

  it('keeps a legacy note private when its author edits the text', async () => {
    const before = await createTestDbBefore(MIGRATION);
    try {
      const user = await before.createUser({ username: 'legacy_editor' });
      const id = await before.createMovie('legacy_edited', -99002);
      await before.actAs(user);
      await before.sql(`select log_watched(gen_random_uuid(), $1, null, $2)`, [id, 'first draft']);
      await before.applyMigration(MIGRATION);

      await before.sql(`select save_note(gen_random_uuid(), $1, $2, null)`, [id, 'second draft']);

      const { rows } = await before.sql(
        `select note, note_visibility from user_media where user_id = $1 and media_item_id = $2`,
        [user, id],
      );
      assert.equal(rows[0].note, 'second draft');
      assert.equal(
        rows[0].note_visibility,
        'private',
        'editing a note written under the private-only promise must not publish it',
      );
    } finally {
      await before.close();
    }
  });
});

/**
 * NR-1, decided by the founder on 2026-08-24 and implemented in `20260825000200`.
 *
 * These two tests asserted the opposite until that date, and the inversion is the
 * point of the change rather than a correction to the tests. Both writers used to
 * read a *null* `p_note_visibility` on a note that had never existed as `public`,
 * while `user_media.note_visibility` is `not null default 'private'`, PRD §22 says a
 * note is private until its author publishes it, and every screen in the app has sent
 * an explicit value since 2026-08-23. So the safe-looking call — omit the argument —
 * was the publishing call, and the disagreement was a trap for the next importer,
 * backfill or second client rather than a live exposure.
 *
 * The product hierarchy is unchanged and is not what this pins: the app still offers
 * *Write a review* first and *Add a private note* second. What the server now
 * guarantees is only that silence is not consent.
 */
describe('a new note nobody has published is private', () => {
  it('keeps a note written on a fresh row private', async () => {
    const id = await movie('fresh_note');
    await logNote(id, 'the first act is the whole film');

    const { rows } = await t.sql(
      `select note_visibility from user_media where user_id = $1 and media_item_id = $2`,
      [alice, id],
    );
    assert.equal(rows[0].note_visibility, 'private');
    assert.equal((await notesFor(null, [id])).length, 0, 'and it is not readable by anyone else');
  });

  it('keeps the first note on a row that existed without one private', async () => {
    // A bucket-only row carries the column default, and its first note is new content
    // rather than an edit — so it takes the forward default rather than inheriting.
    // Both answers are 'private' now, which is exactly why the *next* test matters:
    // it is the one that proves this branch is still distinguishing new from existing.
    const id = await movie('bucket_first');
    await t.sql(`select set_bucket(gen_random_uuid(), $1, 'loved'::taste_bucket)`, [id]);
    await t.sql(`select save_note(gen_random_uuid(), $1, $2, null)`, [id, 'added later']);

    const { rows } = await t.sql(
      `select note_visibility from user_media where user_id = $1 and media_item_id = $2`,
      [alice, id],
    );
    assert.equal(rows[0].note_visibility, 'private');
  });

  it('honours an explicit review, and an edit that omits the field does not unpublish it', async () => {
    // The half of NR-1 that is easy to break while fixing the other half. A published
    // Review must survive an ordinary text edit that names no visibility — otherwise
    // the fix is the same defect pointed the other way, and it would take somebody's
    // review off the Reviews tab without them touching the control.
    const id = await movie('review_survives_edit');
    await logNote(id, 'a real review', { visibility: 'public' });
    assert.equal((await notesFor(null, [id])).length, 1);

    await t.sql(`select save_note(gen_random_uuid(), $1, $2, null)`, [id, 'a real review, edited']);

    const { rows } = await t.sql(
      `select note, note_visibility from user_media where user_id = $1 and media_item_id = $2`,
      [alice, id],
    );
    assert.equal(rows[0].note, 'a real review, edited');
    assert.equal(rows[0].note_visibility, 'public');
    assert.equal((await notesFor(null, [id])).length, 1);
  });

  it('leaves an existing private note private through an edit that omits the field', async () => {
    const id = await movie('private_survives_edit');
    await logNote(id, 'just for me, first draft', { visibility: 'private' });
    await t.sql(`select save_note(gen_random_uuid(), $1, $2, null)`, [id, 'just for me, second']);

    const { rows } = await t.sql(
      `select note_visibility from user_media where user_id = $1 and media_item_id = $2`,
      [alice, id],
    );
    assert.equal(rows[0].note_visibility, 'private');
    assert.equal((await notesFor(null, [id])).length, 0);
  });

  it('publishes when the caller explicitly says so', async () => {
    const id = await movie('explicit_review');
    await logNote(id, 'deliberately social', { visibility: 'public' });
    assert.equal((await notesFor(null, [id])).length, 1);
  });

  it('honours an explicit private choice', async () => {
    const id = await movie('explicitly_private');
    await logNote(id, 'just for me', { visibility: 'private' });

    assert.equal((await notesFor(null, [id])).length, 0);
  });

  it('lets the author move a note between public and private', async () => {
    const id = await movie('toggled');
    await logNote(id, 'public at first', { visibility: 'public' });
    assert.equal((await notesFor(null, [id])).length, 1);

    await t.sql(`select save_note(gen_random_uuid(), $1, $2, null, 'private'::note_visibility)`, [
      id,
      'public at first',
    ]);
    assert.equal((await notesFor(null, [id])).length, 0);

    await t.sql(`select save_note(gen_random_uuid(), $1, $2, null, 'public'::note_visibility)`, [
      id,
      'public at first',
    ]);
    assert.equal((await notesFor(null, [id])).length, 1);
  });

  it('records and clears the author spoiler claim', async () => {
    const id = await movie('spoiler_claim');
    await logNote(id, 'he was dead the whole time', { visibility: 'public', spoilers: true });
    assert.equal((await notesFor(null, [id]))[0].has_spoilers, true);

    // Clearing the note clears the claim, so a later note written through
    // log_watched's coalescing path cannot inherit a tag nobody chose.
    await t.sql(`select save_note(gen_random_uuid(), $1, '', null)`, [id]);
    const { rows } = await t.sql(
      `select note, note_has_spoilers from user_media where user_id = $1 and media_item_id = $2`,
      [alice, id],
    );
    assert.equal(rows[0].note, null);
    assert.equal(rows[0].note_has_spoilers, false);
  });

  it('still refuses an over-long note', async () => {
    const id = await movie('too_long');
    const error = await t.errorFrom(
      `select log_watched(gen_random_uuid(), $1, null, $2)`,
      [id, 'x'.repeat(2001)],
    );
    assert.equal(error?.code, '22023');
  });

  it('still refuses a second application of the same operation id', async () => {
    const id = await movie('idempotent_note');
    const { rows } = await t.sql(`select gen_random_uuid() as op`);
    const op = rows[0].op;

    await t.sql(`select log_watched($1, $2, null, $3)`, [op, id, 'first']);
    const second = await t.sql(`select log_watched($1, $2, null, $3) as r`, [op, id, 'second']);

    assert.equal(second.rows[0].r.status, 'already_applied');
    const { rows: stored } = await t.sql(
      `select note from user_media where user_id = $1 and media_item_id = $2`,
      [alice, id],
    );
    assert.equal(stored[0].note, 'first');
  });
});

describe('public_notes', () => {
  it('refuses an unfiltered call', async () => {
    const error = await t.errorFrom(`select * from public_notes(null, null, 50)`);
    assert.equal(error?.code, '22023');
  });

  it('returns note text and nothing else about the row', async () => {
    const id = await movie('projection');
    await t.sql(`select log_watched(gen_random_uuid(), $1, '2026-01-02'::date, $2)`, [
      id,
      'a note with a watch date beside it',
    ]);

    const { fields } = await t.sql(`select * from public_notes(null, $1::uuid[], 50)`, [[id]]);
    const names = fields.map((f) => f.name).sort();
    assert.deepEqual(names, [
      'has_spoilers',
      // The row's surrogate name, added by 20260825000100 so a reader can report the
      // review. A key rather than a fact about the watch — it discloses nothing the
      // caller could not already see, and reporting needs a subject id.
      'id',
      'media_item_id',
      'note',
      'updated_at',
      'user_id',
    ]);

    // The point of the assertion above, stated so it cannot be widened by accident.
    // `watched_on` is private at every visibility level (PRD §22) and `bucket` is the
    // rating; neither belongs in a note read. A future column added to `user_media`
    // fails the deepEqual, and this says what the failure would mean.
    for (const forbidden of ['watched_on', 'bucket', 'progress', 'note_visibility', 'source']) {
      assert.ok(!names.includes(forbidden), `public_notes must not project ${forbidden}`);
    }
  });

  it('caps the limit', async () => {
    const { rows } = await t.sql(`select * from public_notes($1::uuid[], null, 100000)`, [[alice]]);
    assert.ok(rows.length <= 100);
  });

  it('refuses a filter with more ids than any screen would ask for', async () => {
    const { rows } = await t.sql(
      `select array_agg(gen_random_uuid()) as ids from generate_series(1, 51)`,
    );
    const error = await t.errorFrom(`select * from public_notes($1::uuid[], null, 50)`, [rows[0].ids]);
    assert.equal(error?.code, '22023');
  });

  it('hides a private account from a stranger and shows it to an approved follower', async () => {
    const carol = await t.createUser({ username: 'carol_private', visibility: 'private' });
    const id = await movie('private_account_note');
    await t.actAs(carol);
    await logNote(id, 'behind a private account', { visibility: 'public' });
    await t.actAs(alice);

    assert.equal((await notesFor([carol], null)).length, 0);

    await t.sql(
      `insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`,
      [alice, carol],
    );
    assert.equal((await notesFor([carol], null)).length, 1);
  });

  it('hides a note from someone who blocked the reader', async () => {
    const dave = await t.createUser({ username: 'dave_blocks' });
    const id = await movie('blocked_note');
    await t.actAs(dave);
    await logNote(id, 'not for alice', { visibility: 'public' });
    await t.actAs(alice);
    assert.equal((await notesFor([dave], null)).length, 1);

    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [dave, alice]);
    assert.equal((await notesFor([dave], null)).length, 0);
  });

  it('hides a suspended account', async () => {
    const erin = await t.createUser({ username: 'erin_suspended' });
    const id = await movie('suspended_note');
    await t.actAs(erin);
    await logNote(id, 'written before suspension', { visibility: 'public' });
    await t.actAs(alice);
    assert.equal((await notesFor([erin], null)).length, 1);

    await t.sql(`update profiles set status = 'suspended' where id = $1`, [erin]);
    assert.equal((await notesFor([erin], null)).length, 0);
  });

  it('is reachable by a signed-in client and not by anon', async () => {
    const id = await movie('grant_check');
    await logNote(id, 'readable by signed-in users', { visibility: 'public' });

    await t.asUser(bob, async () => {
      const { rows } = await t.sql(`select * from public_notes(null, $1::uuid[], 50)`, [[id]]);
      assert.equal(rows.length, 1);
    });

    const error = await t.asAnon(() =>
      t.errorFrom(`select * from public_notes(null, $1::uuid[], 50)`, [[id]]),
    );
    assert.equal(error?.code, '42501', 'anon must not hold execute on public_notes');
    // asRole leaves the claims it set behind; only the role is reset.
    await t.actAs(alice);
  });

  it('does not let a policy-bypassing definer expose a private note', async () => {
    const id = await movie('still_private');
    await logNote(id, 'kept back', { visibility: 'private' });

    await t.asUser(bob, async () => {
      const { rows } = await t.sql(`select * from public_notes(null, $1::uuid[], 50)`, [[id]]);
      assert.equal(rows.length, 0);
    });
  });

  it('still refuses a direct read of another user_media row', async () => {
    const id = await movie('rls_unchanged');
    await logNote(id, 'public note on a private row');

    await t.asUser(bob, async () => {
      const { rows } = await t.sql(
        `select note, watched_on from user_media where user_id = $1 and media_item_id = $2`,
        [alice, id],
      );
      assert.equal(rows.length, 0, 'user_media must stay owner-only');
    });
  });
});

describe('community_score', () => {
  /**
   * **The shipped threshold is one and this block raises it to three.**
   *
   * These tests are about the *population* -- the exact entity, the blocked rater, the
   * live ranking rather than the feed snapshot -- and every one of them needs a
   * withheld number to distinguish "dropped from the mean" from "counted in it". At the
   * shipped threshold of one there is no withheld case to observe: two raters minus a
   * blocked one still publishes a number, and an assertion on `score` would pass
   * whether the block worked or not.
   *
   * Three, rather than the ten it used to be, for the reason the old comment gave in
   * the other direction: ten fresh accounts each ranking to completion is about thirty
   * seconds of test for one boolean, and none of what is under test varies with the
   * number. The number itself is asserted once, on the shipped default, in
   * `config-defaults.test.mjs` -- and the block below this one exercises the shipped
   * value without touching it.
   */
  before(async () => {
    await t.sql(`update app_config set value = '3'::jsonb
                  where key = 'score.community_min_ratings'`);
  });

  after(async () => {
    await t.sql(`update app_config set value = '1'::jsonb
                  where key = 'score.community_min_ratings'`);
  });

  /** Ranks the same title for `count` fresh public users, incumbent always winning. */
  let raterSeq = 0;
  const rankedBy = async (mediaItemId, count, bucket = 'loved') => {
    const ids = [];
    for (let i = 0; i < count; i += 1) {
      raterSeq += 1;
      const user = await t.createUser({ username: `cs_rater_${raterSeq}` });
      ids.push(user);
      await t.actAs(user);
      await t.rankToCompletion(mediaItemId, bucket, async (pivot) => pivot);
    }
    await t.actAs(alice);
    return ids;
  };

  const scoreOf = async (mediaItemId) =>
    (await t.sql(`select * from community_score($1)`, [mediaItemId])).rows[0];

  it('withholds the number below the threshold but still reports the count', async () => {
    const id = await movie('thin_sample');
    await rankedBy(id, 2);

    const row = await scoreOf(id);
    assert.equal(row.score, null);
    assert.equal(row.rating_count, 2);
    assert.equal(row.min_ratings, 3);
  });

  it('reports zero ratings for a title nobody has ranked', async () => {
    const id = await movie('unrated');
    const row = await scoreOf(id);
    assert.equal(row.score, null);
    assert.equal(row.rating_count, 0);
  });

  it('averages the canonical score once the sample is large enough', async () => {
    const id = await movie('enough_sample');
    await rankedBy(id, 3);

    const row = await scoreOf(id);
    // Each rater has exactly one loved title, so each scores it 10.0.
    assert.equal(Number(row.score), 10);
    assert.equal(row.rating_count, 3);
  });

  it('aggregates the exact entity and never blends a season into its series', async () => {
    const series = await t.createSeries('community_series', seq++);
    const one = await t.createSeason(series, 1, 'Season 1');
    const two = await t.createSeason(series, 2, 'Season 2');

    await rankedBy(one, 3, 'loved');
    await rankedBy(two, 3, 'not_for_me');

    assert.equal(Number((await scoreOf(one)).score), 10);
    assert.equal(Number((await scoreOf(two)).score), 3.4);
    // A series is not rankable at all, so its own aggregate is empty rather than
    // the mean of its seasons.
    assert.equal((await scoreOf(series)).rating_count, 0);
  });

  /**
   * The subtraction attack the population filter exists to stop, run as an attack
   * rather than asserted as a property.
   *
   * Independent review, 2026-08-16: the first version of this suite tested that
   * private and suspended accounts were excluded, and would have passed with block
   * isolation entirely absent — which is what the implementation then was. A rater
   * who has blocked the viewer is not readable through `rankings_read`, so if the
   * mean still counted them, the viewer could read the raters they *can* see,
   * multiply the mean by the count and recover the blocked rating exactly.
   */
  it('leaves a blocked rater out, so their score cannot be recovered by subtraction', async () => {
    const id = await movie('subtraction');
    await rankedBy(id, 2, 'loved');
    const blocker = await t.createUser({ username: 'cs_blocker' });

    // The blocker's score for this title differs from the other two, so a mean
    // that included it would be visibly different from a mean that did not.
    await t.actAs(blocker);
    const decoy = await movie('subtraction_decoy');
    await t.rankToCompletion(decoy, 'loved', async (pivot) => pivot);
    await t.rankToCompletion(id, 'loved', async (pivot) => pivot);
    await t.actAs(alice);

    const open = await scoreOf(id);
    assert.equal(open.rating_count, 3);
    assert.equal(Number(open.score), 9, 'three raters at 10, 10 and 7');

    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [blocker, alice]);

    const blocked = await scoreOf(id);
    assert.equal(blocked.rating_count, 2, 'the blocked rater is out of the population');
    assert.equal(
      blocked.score,
      null,
      'and with them gone the sample no longer meets the threshold',
    );

    // The individual read is refused too, which is the fact that makes their
    // presence in the aggregate a leak rather than a duplicate of public data.
    await t.asUser(alice, async () => {
      const { rows } = await t.sql(`select 1 from rankings where user_id = $1`, [blocker]);
      assert.equal(rows.length, 0);
    });
    await t.actAs(alice);
  });

  it('is symmetric: blocking a rater removes them as surely as being blocked by one', async () => {
    const id = await movie('symmetric_block');
    await rankedBy(id, 2, 'loved');
    const blocked = await t.createUser({ username: 'cs_blocked' });
    await t.actAs(blocked);
    await t.rankToCompletion(id, 'loved', async (pivot) => pivot);
    await t.actAs(alice);

    assert.equal((await scoreOf(id)).rating_count, 3);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [alice, blocked]);
    assert.equal((await scoreOf(id)).rating_count, 2);
  });

  it('excludes private and suspended accounts from the population', async () => {
    const id = await movie('population');
    const raters = await rankedBy(id, 3);
    assert.equal((await scoreOf(id)).rating_count, 3);

    await t.sql(`update profiles set visibility = 'private' where id = $1`, [raters[0]]);
    assert.equal((await scoreOf(id)).rating_count, 2, 'a private account is not community data');

    await t.sql(`update profiles set status = 'suspended' where id = $1`, [raters[1]]);
    assert.equal((await scoreOf(id)).rating_count, 1);
  });

  it('follows the live ranking rather than the feed snapshot', async () => {
    const first = await movie('live_first');
    const second = await movie('live_second');
    const raters = await rankedBy(first, 3);

    assert.equal(Number((await scoreOf(first)).score), 10);

    // Each rater now ranks a second loved title above the first, which pushes the
    // first title to the bottom of a two-title band: 7.0. The feed event still
    // records the 10.0 that was true at the time.
    for (const rater of raters) {
      await t.actAs(rater);
      await t.rankToCompletion(second, 'loved', async (pivot, incoming) => incoming);
    }
    await t.actAs(alice);

    assert.equal(Number((await scoreOf(first)).score), 7);
    const { rows } = await t.sql(
      `select (payload->>'score')::numeric as score from feed_events
        where actor_id = $1 and media_item_id = $2 and type = 'title_ranked'`,
      [raters[0], first],
    );
    assert.equal(Number(rows[0].score), 10, 'the historical snapshot is untouched');
  });

  it('is reachable by a signed-in client and not by anon', async () => {
    const id = await movie('cs_grant');
    await t.asUser(bob, async () => {
      const { rows } = await t.sql(`select * from community_score($1)`, [id]);
      assert.equal(rows[0].rating_count, 0);
    });

    const error = await t.asAnon(() => t.errorFrom(`select * from community_score($1)`, [id]));
    assert.equal(error?.code, '42501');
    await t.actAs(alice);
  });
});

/**
 * The shipped threshold, exercised at the value a real database has.
 *
 * The block above deliberately raises `score.community_min_ratings` to three, because
 * a withheld number is the only way to observe a rater being dropped from the
 * population. This one deliberately does **not** touch the config: it runs after that
 * block restores the shipped value, and every assertion here is about the boundary the
 * founder moved on 2026-09-05 (`20260910000100`). Reading `min_ratings` off the
 * function is what makes it read the real row rather than one this file set.
 *
 * Ten ratings was withholding not a weak number but every number there was. Before
 * launch almost every title in the catalogue has one rating or none, so a reader who
 * ranked a film and opened its page was told "Not enough ratings" about a population
 * that already counted them.
 */
describe('the bingd. score from the first rating', () => {
  let firstSeq = 0;

  /** Ranks one title for `count` fresh public accounts, incumbent always winning. */
  const rankedBy = async (mediaItemId, count) => {
    for (let i = 0; i < count; i += 1) {
      firstSeq += 1;
      const user = await t.createUser({ username: `first_rater_${firstSeq}` });
      await t.actAs(user);
      await t.rankToCompletion(mediaItemId, 'loved', async (pivot) => pivot);
    }
    await t.actAs(alice);
  };

  const scoreOf = async (mediaItemId) =>
    (await t.sql(`select * from community_score($1)`, [mediaItemId])).rows[0];

  it('reports the shipped threshold, which is one', async () => {
    // Read off the function rather than off app_config, so this fails if the value is
    // right and the function stops consulting it — the two ways this could break.
    assert.equal((await scoreOf(await movie('threshold_report'))).min_ratings, 1);
  });

  it('still says nothing at all when nobody has ranked it', async () => {
    // The existing empty state, unchanged. `n >= 1` withholds exactly this case, which
    // is why lowering the threshold did not need a new branch anywhere.
    const row = await scoreOf(await movie('first_none'));
    assert.equal(row.score, null);
    assert.equal(row.rating_count, 0);
  });

  it('publishes a single rating with its sample size beside it', async () => {
    const id = await movie('first_one');
    await rankedBy(id, 1);

    const row = await scoreOf(id);
    // One loved title in an empty band scores 10.0. What matters is that a number
    // comes back at all, and that the count says how much it is worth.
    assert.equal(Number(row.score), 10);
    assert.equal(row.rating_count, 1);
  });

  it('publishes two, and the count keeps up', async () => {
    const id = await movie('first_two');
    await rankedBy(id, 2);

    const row = await scoreOf(id);
    assert.equal(Number(row.score), 10);
    assert.equal(row.rating_count, 2);
  });

  it('keeps publishing above the threshold it used to wait for', async () => {
    // The old boundary. Nothing about a larger sample changed, and a change that
    // lowered the floor by breaking the ceiling would pass every test above this one.
    const id = await movie('first_old_boundary');
    await rankedBy(id, 3);

    const row = await scoreOf(id);
    assert.equal(Number(row.score), 10);
    assert.equal(row.rating_count, 3);
  });

  it('counts the reader among everyone else rather than excluding them', async () => {
    // The property the founder asked to have confirmed rather than changed: there is
    // one bingd. aggregate for a title, and the caller's own eligible rating is in it
    // on the same terms as anybody else's. A viewer-excluded variant would show alice
    // a different number here from the one bob sees, and the count would differ by
    // exactly one.
    const id = await movie('first_self');
    await t.rankToCompletion(id, 'loved', async (pivot) => pivot);

    const mine = await scoreOf(id);
    assert.equal(mine.rating_count, 1, 'the reader is inside their own community score');
    assert.equal(Number(mine.score), 10);

    await t.asUser(bob, async () => {
      const theirs = await t.sql(`select * from community_score($1)`, [id]);
      assert.equal(theirs.rows[0].rating_count, 1, 'and it is the same number for a stranger');
      assert.equal(Number(theirs.rows[0].score), 10);
    });
    await t.actAs(alice);
  });

  it('leaves Following exactly where it was', async () => {
    // Following has activated on one rating since `20260816001100` and this change did
    // not touch it. Asserted here because the two units sit side by side on the title
    // page, and a change to the threshold of one is the kind that quietly moves both.
    const id = await movie('first_following');
    const followee = await t.createUser({ username: 'first_followee' });
    await t.actAs(followee);
    await t.rankToCompletion(id, 'loved', async (pivot) => pivot);
    await t.actAs(alice);
    await t.sql(
      `insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')
       on conflict do nothing`,
      [alice, followee],
    );

    const { rows } = await t.sql(`select * from following_score($1)`, [id]);
    assert.equal(rows[0].rating_count, 1);
    assert.equal(Number(rows[0].score), 10);
  });
});
