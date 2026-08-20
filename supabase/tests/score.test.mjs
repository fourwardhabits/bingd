import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The derived score, and the one place it gets written down.
 *
 * PRD §10, ranking.md §11. Two things are under test: that `score_for` agrees
 * with src/features/collection/score.ts, since the formula exists twice and
 * would otherwise drift; and that `_rank_finalize` snapshots the score into
 * `feed_events.payload`, which is the only way a client can show a friend's
 * number at all -- `rankings` is scoped to its owner, so the band sizes the
 * derivation needs are not readable across users.
 */

let t;
let user;

before(async () => {
  t = await createTestDb();
  user = await t.createUser({ username: 'scorer' });
  await t.actAs(user);
});

after(async () => {
  await t?.close();
});

let seq = 90000;
const movie = (title) => t.createMovie(title, seq++);

/** Ranks a title to completion, always letting the incumbent win. */
const rankBelow = (id, bucket) => t.rankToCompletion(id, bucket, async (pivot) => pivot);

const scoreOf = async (bucket, rank, size) =>
  Number((await t.sql(`select score_for($1, $2, $3) as r`, [bucket, rank, size])).rows[0].r);

const payloadFor = async (mediaItemId) =>
  (
    await t.sql(
      `select payload from feed_events
        where actor_id = $1 and media_item_id = $2 and type = 'title_ranked'`,
      [user, mediaItemId],
    )
  ).rows[0]?.payload;

describe('score_for', () => {
  it('gives a band of one its high rather than dividing by zero', async () => {
    assert.equal(await scoreOf('loved', 1, 1), 10);
    assert.equal(await scoreOf('fine', 1, 1), 6.9);
    assert.equal(await scoreOf('not_for_me', 1, 1), 3.4);
  });

  it('lands the last title in a band exactly on the band low', async () => {
    assert.equal(await scoreOf('loved', 5, 5), 7);
    assert.equal(await scoreOf('fine', 5, 5), 3.5);
    assert.equal(await scoreOf('not_for_me', 5, 5), 0);
  });

  it('spreads the middle across the range', async () => {
    // Matches the TypeScript unit test exactly: a five-title loved band steps
    // by 0.75 and rounds to one decimal.
    const scores = await Promise.all([1, 2, 3, 4, 5].map((rank) => scoreOf('loved', rank, 5)));
    assert.deepEqual(scores, [10, 9.3, 8.5, 7.8, 7]);
  });

  it('keeps the bands from overlapping, at every size', async () => {
    for (const [bucket, high, low] of [
      ['loved', 10, 7],
      ['fine', 6.9, 3.5],
      ['not_for_me', 3.4, 0],
    ]) {
      for (const size of [1, 2, 3, 7, 25]) {
        for (let rank = 1; rank <= size; rank += 1) {
          const score = await scoreOf(bucket, rank, size);
          assert.ok(
            score <= high && score >= low,
            `${bucket} rank ${rank}/${size} scored ${score}, outside ${low}-${high}`,
          );
        }
      }
    }
  });
});

describe('_rank_finalize snapshots the score', () => {
  it('writes the score alongside the position', async () => {
    const first = await movie('score_first');
    await rankBelow(first, 'loved');

    const payload = await payloadFor(first);
    assert.equal(payload.position, 1);
    assert.equal(payload.bucket, 'loved');
    // Alone in its band, so it is the best thing in the list.
    assert.equal(Number(payload.score), 10);
  });

  it('returns the same score it recorded', async () => {
    const id = await movie('score_returned');
    const result = await t.rankToCompletion(id, 'fine', async (pivot) => pivot);
    const payload = await payloadFor(id);

    assert.equal(Number(result.score), Number(payload.score));
  });

  it('counts the title being placed in its own band size', async () => {
    // The bug this guards: band_bounds is read before the insert, so its size
    // excludes the incoming title. Scoring against that stale size would give
    // the second title in a band the *high* -- as though it were alone.
    const second = await movie('score_second_loved');
    await rankBelow(second, 'loved');

    const payload = await payloadFor(second);
    assert.equal(payload.position, 2);
    assert.equal(Number(payload.score), 7, 'second of two loved titles is the band low');
  });

  it('scores a title by its rank within the band, not its absolute position', async () => {
    // Needs a collection whose contents are known exactly, so this runs as its
    // own user rather than inheriting whatever the tests above have ranked.
    const other = await t.createUser({ username: 'band_rank' });
    await t.actAs(other);

    try {
      for (let i = 0; i < 3; i += 1) {
        await rankBelow(await movie(`band_rank_loved_${i}`), 'loved');
      }

      const fine = await movie('band_rank_first_fine');
      await rankBelow(fine, 'fine');

      const { rows } = await t.sql(
        `select payload from feed_events
          where actor_id = $1 and media_item_id = $2 and type = 'title_ranked'`,
        [other, fine],
      );
      const payload = rows[0].payload;

      // Absolute position 4, because three loved titles outrank it. Rank within
      // its own band is 1. Scoring the absolute position would drop it to the
      // bottom of the fine range instead of the top.
      assert.equal(payload.position, 4);
      assert.equal(Number(payload.score), 6.9, 'first in the fine band takes the fine high');
    } finally {
      await t.actAs(user);
    }
  });

  it('keeps every recorded score inside its bucket range', async () => {
    for (let i = 0; i < 6; i += 1) {
      await rankBelow(await movie(`score_spread_${i}`), 'not_for_me');
    }

    const { rows } = await t.sql(
      `select payload->>'bucket' as bucket, (payload->>'score')::numeric as score
         from feed_events
        where actor_id = $1 and type = 'title_ranked'`,
      [user],
    );

    const range = {
      loved: [7, 10],
      fine: [3.5, 6.9],
      not_for_me: [0, 3.4],
    };

    assert.ok(rows.length > 0);
    for (const row of rows) {
      const [low, high] = range[row.bucket];
      const score = Number(row.score);
      assert.ok(
        score >= low && score <= high,
        `a ${row.bucket} event recorded ${score}, outside ${low}-${high}`,
      );
    }

    await t.assertValid(user);
  });
});
