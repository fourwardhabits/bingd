import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * `following_score` — 20260816001100.
 *
 * The number on a title page that answers "what did the people I follow make of this",
 * as opposed to `community_score`'s "what does everybody". Four properties carry it, and
 * every one of them is a way of getting the population wrong:
 *
 *   1. It counts the caller's **approved** followees and nobody else — not followers,
 *      not pending requests, not the caller.
 *   2. It applies AD-5 from the caller's own perspective, so a block in either
 *      direction, a suspension, or a private account that revoked approval drops out —
 *      none of which delete the `follows` row.
 *   3. It aggregates **exactly one** media item. A season is not a series.
 *   4. It is viewer-relative: two people see different numbers for the same title, and
 *      an unauthenticated caller sees none.
 */

let t;
let alice;
let seq = 90000;

const movie = (title) => t.createMovie(title, seq++);

/** A fresh account that has ranked `mediaItemId` into `bucket`, and follows nobody. */
let raterSeq = 0;
const rater = async (mediaItemId, bucket = 'loved', options = {}) => {
  raterSeq += 1;
  const user = await t.createUser({
    username: `fs_rater_${raterSeq}`,
    visibility: options.visibility ?? 'public',
  });
  if (mediaItemId) {
    await t.actAs(user);
    await t.rankToCompletion(mediaItemId, bucket, async (pivot) => pivot);
  }
  await t.actAs(alice);
  return user;
};

const follow = async (follower, followee, state = 'approved') => {
  await t.sql(
    `insert into follows (follower_id, followee_id, state, approved_at)
     values ($1, $2, $3::follow_state, case when $3 = 'approved' then now() end)
     on conflict (follower_id, followee_id) do update
       set state = excluded.state, approved_at = excluded.approved_at`,
    [follower, followee, state],
  );
};

/** As alice, unless a user is named. */
const scoreOf = async (mediaItemId, asUser) => {
  if (asUser) await t.actAs(asUser);
  const { rows } = await t.sql(`select * from following_score($1)`, [mediaItemId]);
  if (asUser) await t.actAs(alice);
  return rows[0];
};

before(async () => {
  t = await createTestDb();
  alice = await t.createUser({ username: 'alice' });
  await t.actAs(alice);
});

after(async () => t.close());

describe('who is counted', () => {
  it('answers with nothing when the caller follows nobody who has seen it', async () => {
    const id = await movie('fs_nobody');
    await rater(id);

    const row = await scoreOf(id);
    assert.equal(row.rating_count, 0);
    assert.equal(row.score, null);
  });

  it('counts one followee, because one person you chose is a complete answer', async () => {
    // The founder's minimum is 1, unlike community_score's 3. A mean of one stranger
    // looks like data and is not; one account you deliberately follow is not an
    // estimate of a population, it is that person's opinion.
    const id = await movie('fs_one');
    const bob = await rater(id, 'loved');
    await follow(alice, bob);

    const row = await scoreOf(id);
    assert.equal(row.rating_count, 1);
    assert.equal(Number(row.score), 10);
  });

  it('averages several followees', async () => {
    const id = await movie('fs_many');
    for (const bucket of ['loved', 'fine', 'not_for_me']) {
      const user = await rater(id, bucket);
      await follow(alice, user);
    }

    const row = await scoreOf(id);
    assert.equal(row.rating_count, 3);
    // Each has ranked exactly one title, so each sits alone at the top of its band:
    // 10.0, 6.9 and 3.4. The point of the assertion is the population, not the mean.
    assert.ok(Number(row.score) > 3.4 && Number(row.score) < 10);
  });

  it('ignores a pending follow request', async () => {
    // Otherwise a stranger could learn a private account's rating by requesting a
    // follow and reading a title page, without ever being approved.
    const id = await movie('fs_pending');
    const bob = await rater(id);
    await follow(alice, bob, 'pending');

    assert.equal((await scoreOf(id)).rating_count, 0);
  });

  it('ignores somebody who follows the caller but is not followed back', async () => {
    // The direction is what makes this a Following score rather than a friend score.
    const id = await movie('fs_reverse');
    const bob = await rater(id);
    await follow(bob, alice);

    assert.equal((await scoreOf(id)).rating_count, 0);
  });

  it('does not count the caller’s own ranking', async () => {
    const id = await movie('fs_self');
    await t.rankToCompletion(id, 'loved', async (pivot) => pivot);

    // `no_self_follow` makes this structural rather than a filter that could be
    // forgotten, but the number is on a page next to the reader's own score and the
    // two must not be the same thing.
    assert.equal((await scoreOf(id)).rating_count, 0);
  });
});

describe('authorisation', () => {
  it('drops a followee who has blocked the caller', async () => {
    const id = await movie('fs_blocked_by');
    const bob = await rater(id);
    await follow(alice, bob);
    assert.equal((await scoreOf(id)).rating_count, 1);

    // Written as the owner: `blocks` has no client insert policy, and the point here is
    // the read side of an existing block rather than how one is created.
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [bob, alice]);

    // `rankings_read` already hides bob's row from alice. An aggregate that kept
    // counting it would make his score recoverable — which is exactly the hole
    // 20260816000100 had to close in community_score.
    assert.equal((await scoreOf(id)).rating_count, 0);
  });

  it('drops a followee the caller has blocked', async () => {
    const id = await movie('fs_blocked');
    const bob = await rater(id);
    await follow(alice, bob);

    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [alice, bob]);
    assert.equal((await scoreOf(id)).rating_count, 0);
  });

  it('drops a suspended followee', async () => {
    const id = await movie('fs_suspended');
    const bob = await rater(id);
    await follow(alice, bob);
    assert.equal((await scoreOf(id)).rating_count, 1);

    await t.sql(`update profiles set status = 'suspended' where id = $1`, [bob]);
    assert.equal((await scoreOf(id)).rating_count, 0);
  });

  it('drops a private followee whose approval was revoked', async () => {
    // The follows row survives a downgrade to pending, so `state` alone is not the
    // whole test — and a private account that revokes approval must stop contributing.
    const id = await movie('fs_revoked');
    const bob = await rater(id, 'loved', { visibility: 'private' });
    await follow(alice, bob);
    assert.equal((await scoreOf(id)).rating_count, 1);

    await follow(alice, bob, 'pending');
    assert.equal((await scoreOf(id)).rating_count, 0);
  });

  it('keeps a private followee the caller is approved to see', async () => {
    const id = await movie('fs_private_ok');
    const bob = await rater(id, 'loved', { visibility: 'private' });
    await follow(alice, bob);

    assert.equal((await scoreOf(id)).rating_count, 1);
  });

  it('is not reachable by an unauthenticated caller at all', async () => {
    const id = await movie('fs_anon');
    const bob = await rater(id);
    await follow(alice, bob);

    await t.asAnon(async () => {
      // Refused rather than answered emptily. `auth.uid()` is the whole population
      // filter, so anon could only ever receive the empty answer — and a function that
      // is useless by construction should not be reachable, so that the allow-list in
      // function-grants.test.mjs stays a list of things that are there for a reason.
      const error = await t.errorFrom(`select * from following_score($1)`, [id]);
      assert.equal(error?.code, '42501', 'anon must not hold EXECUTE on following_score');
    });
  });

  it('is viewer-relative: two people get different numbers', async () => {
    const id = await movie('fs_relative');
    const bob = await rater(id);
    const carol = await t.createUser({ username: 'fs_carol' });

    await follow(alice, bob);

    assert.equal((await scoreOf(id)).rating_count, 1);
    assert.equal((await scoreOf(id, carol)).rating_count, 0);
  });
});

describe('what is compared', () => {
  it('never folds a season into its series, or the reverse', async () => {
    const seriesId = await t.createSeries('fs_series', seq++);
    const seasonId = await t.createSeason(seriesId, 1, 'Season 1');

    const bob = await rater(null);
    await t.actAs(bob);
    await t.rankToCompletion(seasonId, 'loved', async (pivot) => pivot);
    await t.actAs(alice);
    await follow(alice, bob);

    // A series is not rankable at all (AD-1), so a number on its page would be an
    // aggregate nobody expressed. The season carries it and the series carries none.
    assert.equal((await scoreOf(seasonId)).rating_count, 1);
    assert.equal((await scoreOf(seriesId)).rating_count, 0);
  });

  it('reflects a re-rank rather than the score at the time of the event', async () => {
    // Deliberately not read from `feed_events`, which snapshots a score: those go stale
    // the moment the rater ranks anything else in the same band, and the number here
    // would then disagree with the same followee's own profile.
    const first = await movie('fs_live_a');
    const second = await movie('fs_live_b');

    const bob = await rater(first, 'loved');
    await follow(alice, bob);
    assert.equal(Number((await scoreOf(first)).score), 10);

    // Bob loves a second film more, pushing the first down its band.
    await t.actAs(bob);
    await t.rankToCompletion(second, 'loved', async (_pivot, subject) => subject);
    await t.actAs(alice);

    const after = Number((await scoreOf(first)).score);
    assert.ok(after < 10, `expected the first film to fall below 10, got ${after}`);
  });
});
