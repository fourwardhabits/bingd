import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb, one } from './harness.mjs';

/**
 * The ranking engine is the core mechanic and the part most likely to produce
 * subtle, hard-to-notice corruption, so these tests assert the invariants from
 * docs/architecture/ranking.md after every mutation rather than only at the end.
 *
 *   I1  positions are exactly 1..n, no gaps, no duplicates
 *   I2  loved precedes fine precedes not_for_me
 *   I3  every ranked title is also logged, with the same bucket
 *   I4  no two titles share a position
 */

let t;
let user;
let seq = 0;

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

beforeEach(async () => {
  seq += 1;
  user = await t.createUser({ username: `ranker_${seq}` });
  await t.actAs(user);
});

/** Answers comparisons by consulting a secret true ordering. Lower is better. */
const decideBy = (scores) => async (pivotId, newId) =>
  scores.get(newId) < scores.get(pivotId) ? newId : pivotId;

describe('the first title in a band', () => {
  it('is placed without asking a comparison', async () => {
    const m = await t.createMovie('Solo', 1001);
    const r = await one(t.db, `select rank_start($1, 'loved') as r`, [m]);

    assert.equal(r.done, true, 'an empty band has nothing to compare against');
    assert.equal(r.position, 1);
    await t.assertValid(user);
  });

  it('leaves the title Logged even if the session is abandoned', async () => {
    // PRD §11: bucketing and ranking are separate acts, and abandoning the
    // second must not undo the first.
    const a = await t.createMovie('Anchor', 1002);
    const b = await t.createMovie('Abandoned', 1003);

    await one(t.db, `select rank_start($1, 'loved') as r`, [a]);
    const started = await one(t.db, `select rank_start($1, 'loved') as r`, [b]);
    assert.equal(started.done, false, 'a second title in the band needs a comparison');

    const { rows } = await t.sql(
      `select bucket from user_media where user_id = $1 and media_item_id = $2`,
      [user, b],
    );
    assert.equal(rows[0].bucket, 'loved', 'the bucket survives an abandoned session');

    const ranked = await t.sql(
      `select count(*)::int as n from rankings where user_id = $1 and media_item_id = $2`,
      [user, b],
    );
    assert.equal(ranked.rows[0].n, 0, 'but no position was awarded');
  });
});

describe('a series cannot be ranked', () => {
  it('is refused, directing the user to its seasons', async () => {
    const series = await t.createSeries('Whole Show', 1010);
    await assert.rejects(
      () => t.sql(`select rank_start($1, 'loved')`, [series]),
      /series cannot be ranked/i,
      'PRD §10 makes the season the unit, not the series',
    );
  });

  it('accepts a season of that series', async () => {
    const series = await t.createSeries('Whole Show 2', 1011);
    const season = await t.createSeason(series, 1, 'Season 1');

    const r = await one(t.db, `select rank_start($1, 'loved') as r`, [season]);
    assert.equal(r.done, true);
    assert.equal(r.category, 'tv_seasons', 'seasons rank in their own category');
    await t.assertValid(user, 'tv_seasons');
  });
});

describe('binary insertion', () => {
  it('produces the correct order and holds every invariant along the way', async () => {
    // Secret true ordering. The comparison answers are derived from it, so a
    // correct implementation must reproduce it exactly.
    const titles = ['Heat', 'Sicario', 'Arrival', 'Dune', 'Alien', 'Whiplash', 'Prisoners'];
    const scores = new Map();
    const ids = [];

    for (const [i, title] of titles.entries()) {
      const id = await t.createMovie(title, 2000 + i);
      ids.push(id);
      scores.set(id, i); // Heat is best, Prisoners is worst
    }

    // Insert in an order unrelated to the true ordering.
    const insertionOrder = [3, 0, 6, 1, 5, 2, 4];

    for (const idx of insertionOrder) {
      await t.rankToCompletion(ids[idx], 'loved', decideBy(scores));
      await t.assertValid(user);
    }

    const ranking = await t.ranking(user);
    assert.deepEqual(
      ranking.map((r) => r.title),
      titles,
      'the final order must match the true ordering the answers described',
    );
    assert.deepEqual(
      ranking.map((r) => r.position),
      [1, 2, 3, 4, 5, 6, 7],
      'I1: positions are exactly 1..n',
    );
  });

  it('stays within the logarithmic comparison bound', async () => {
    // ranking.md §4: a band of k members resolves in at most ceil(log2(k + 1)).
    const scores = new Map();
    const ids = [];
    for (let i = 0; i < 31; i += 1) {
      const id = await t.createMovie(`Film ${i}`, 3000 + i);
      ids.push(id);
      scores.set(id, Math.random());
    }

    let worst = 0;
    for (const [i, id] of ids.entries()) {
      const { comparisons } = await t.rankToCompletion(id, 'loved', decideBy(scores));
      const bound = Math.ceil(Math.log2(i + 1));
      assert.ok(
        comparisons <= bound,
        `insertion ${i} took ${comparisons} comparisons, bound was ${bound}`,
      );
      worst = Math.max(worst, comparisons);
    }

    assert.ok(worst >= 4, 'the test is meaningless if it never exercised a deep search');
    await t.assertValid(user);
  });
});

describe('bucket bands partition the ranking', () => {
  it('keeps loved above fine above not_for_me regardless of insertion order', async () => {
    // The founder decision confirmed as INF-3, and the reason Beli only compares
    // within a partition: it removes the mismatch between a bucket and a position.
    const plan = [
      ['Mid A', 'fine'],
      ['Bad A', 'not_for_me'],
      ['Great A', 'loved'],
      ['Bad B', 'not_for_me'],
      ['Great B', 'loved'],
      ['Mid B', 'fine'],
      ['Great C', 'loved'],
    ];

    for (const [i, [title, bucket]] of plan.entries()) {
      const id = await t.createMovie(title, 4000 + i);
      // Answer arbitrarily; band placement must hold regardless.
      await t.rankToCompletion(id, bucket, async (pivotId) => pivotId);
      await t.assertValid(user);
    }

    const ranking = await t.ranking(user);
    const buckets = ranking.map((r) => r.bucket);

    assert.deepEqual(buckets, [
      'loved',
      'loved',
      'loved',
      'fine',
      'fine',
      'not_for_me',
      'not_for_me',
    ]);

    // I2 restated independently of assert_ranking_valid, so a bug in the
    // assertion function cannot hide a bug in the engine.
    const order = { loved: 0, fine: 1, not_for_me: 2 };
    for (let i = 1; i < buckets.length; i += 1) {
      assert.ok(
        order[buckets[i]] >= order[buckets[i - 1]],
        `band order broke between positions ${i} and ${i + 1}`,
      );
    }
  });

  it('places a loved title above an existing not_for_me title', async () => {
    const bad = await t.createMovie('Bad First', 4100);
    const good = await t.createMovie('Good Second', 4101);

    await t.rankToCompletion(bad, 'not_for_me', async (p) => p);
    const r = await t.rankToCompletion(good, 'loved', async (p) => p);

    assert.equal(r.position, 1, 'the loved band starts at position 1');
    const ranking = await t.ranking(user);
    assert.deepEqual(
      ranking.map((x) => x.title),
      ['Good Second', 'Bad First'],
    );
  });
});

describe('skip', () => {
  it('re-anchors without narrowing the range', async () => {
    const scores = new Map();
    const ids = [];
    for (let i = 0; i < 7; i += 1) {
      const id = await t.createMovie(`Skip ${i}`, 5000 + i);
      ids.push(id);
      scores.set(id, i);
      if (i < 6) await t.rankToCompletion(id, 'loved', decideBy(scores));
    }

    const started = await one(t.db, `select rank_start($1, 'loved') as r`, [ids[6]]);
    const firstPivot = started.pivot;

    const skipped = await one(t.db, `select rank_skip($1) as r`, [started.session_id]);
    assert.equal(skipped.done, false);
    assert.equal(skipped.skipped, true);
    assert.notEqual(skipped.pivot, firstPivot, 'a skip must offer a different title');
  });

  it('places the title at the midpoint after the configured skip limit and says so', async () => {
    const scores = new Map();
    const ids = [];
    for (let i = 0; i < 8; i += 1) {
      const id = await t.createMovie(`Limit ${i}`, 5100 + i);
      ids.push(id);
      scores.set(id, i);
      if (i < 7) await t.rankToCompletion(id, 'loved', decideBy(scores));
    }

    const started = await one(t.db, `select rank_start($1, 'loved') as r`, [ids[7]]);

    // ranking.md §5 finalizes on the third skip, not the second: the counter is
    // incremented and then tested against ranking.max_skips.
    const first = await one(t.db, `select rank_skip($1) as r`, [started.session_id]);
    assert.equal(first.done, false, 'the first skip re-anchors');

    const second = await one(t.db, `select rank_skip($1) as r`, [started.session_id]);
    assert.equal(second.done, false, 'the second skip re-anchors');

    const third = await one(t.db, `select rank_skip($1) as r`, [started.session_id]);

    assert.equal(third.done, true, 'the third skip resolves the insertion');
    assert.equal(
      third.adjustable,
      true,
      'the flag comes from the server so the message cannot appear in the wrong circumstances',
    );
    await t.assertValid(user);

    const { rows } = await t.sql(`select count(*)::int as n from ranking_sessions where user_id = $1`, [
      user,
    ]);
    assert.equal(rows[0].n, 0, 'the session is cleared on finalize');
  });
});

describe('back', () => {
  it('restores the previous comparison', async () => {
    const scores = new Map();
    const ids = [];
    for (let i = 0; i < 8; i += 1) {
      const id = await t.createMovie(`Back ${i}`, 5200 + i);
      ids.push(id);
      scores.set(id, i);
      if (i < 7) await t.rankToCompletion(id, 'loved', decideBy(scores));
    }

    const started = await one(t.db, `select rank_start($1, 'loved') as r`, [ids[7]]);
    const firstPivot = started.pivot;

    const answered = await one(t.db, `select rank_answer($1, $2) as r`, [
      started.session_id,
      ids[7],
    ]);
    assert.equal(answered.done, false);
    assert.notEqual(answered.pivot, firstPivot);

    const back = await one(t.db, `select rank_back($1) as r`, [started.session_id]);
    assert.equal(back.pivot, firstPivot, 'back returns to the comparison just answered');
  });

  it('cancels the session at the first comparison, leaving the title Logged', async () => {
    const a = await t.createMovie('Kept', 5300);
    const b = await t.createMovie('Backed Out', 5301);

    await t.rankToCompletion(a, 'loved', async (p) => p);
    const started = await one(t.db, `select rank_start($1, 'loved') as r`, [b]);

    const back = await one(t.db, `select rank_back($1) as r`, [started.session_id]);
    assert.equal(back.cancelled, true);

    const { rows } = await t.sql(
      `select bucket from user_media where user_id = $1 and media_item_id = $2`,
      [user, b],
    );
    assert.equal(rows[0].bucket, 'loved', 'the title stays Logged');
  });
});

describe('resumability', () => {
  it('resumes an existing session rather than restarting it', async () => {
    // PRD §12 requires the post-import anchor session to be resumable, and the
    // unique constraint on (user_id, media_item_id) is what satisfies it.
    const scores = new Map();
    const ids = [];
    for (let i = 0; i < 5; i += 1) {
      const id = await t.createMovie(`Resume ${i}`, 5400 + i);
      ids.push(id);
      scores.set(id, i);
      if (i < 4) await t.rankToCompletion(id, 'loved', decideBy(scores));
    }

    const first = await one(t.db, `select rank_start($1, 'loved') as r`, [ids[4]]);
    await one(t.db, `select rank_answer($1, $2) as r`, [first.session_id, ids[4]]);

    const again = await one(t.db, `select rank_start($1, 'loved') as r`, [ids[4]]);
    assert.equal(again.resumed, true);
    assert.equal(again.session_id, first.session_id, 'the same session continues');
  });

  it('refuses to start a session for a title that is already ranked', async () => {
    const m = await t.createMovie('Already', 5500);
    await t.rankToCompletion(m, 'loved', async (p) => p);

    await assert.rejects(
      () => t.sql(`select rank_start($1, 'loved')`, [m]),
      /already ranked/i,
    );
  });
});

describe('manual reordering', () => {
  it('moves a title within its band, in both directions', async () => {
    const scores = new Map();
    const ids = [];
    for (let i = 0; i < 5; i += 1) {
      const id = await t.createMovie(`Order ${i}`, 5600 + i);
      ids.push(id);
      scores.set(id, i);
      await t.rankToCompletion(id, 'loved', decideBy(scores));
    }

    await t.sql(`select rank_reorder($1, 1)`, [ids[4]]);
    await t.assertValid(user);
    let ranking = await t.ranking(user);
    assert.equal(ranking[0].title, 'Order 4', 'moved up to the top');

    await t.sql(`select rank_reorder($1, 5)`, [ids[4]]);
    await t.assertValid(user);
    ranking = await t.ranking(user);
    assert.equal(ranking[4].title, 'Order 4', 'and back down to the bottom');
  });

  it('refuses a drag that would cross a band boundary', async () => {
    // Crossing means the bucket changed, and that path re-runs comparisons
    // rather than guessing a position.
    const loved = await t.createMovie('Loved One', 5700);
    const fine = await t.createMovie('Fine One', 5701);

    await t.rankToCompletion(loved, 'loved', async (p) => p);
    await t.rankToCompletion(fine, 'fine', async (p) => p);

    await assert.rejects(
      () => t.sql(`select rank_reorder($1, 1)`, [fine]),
      /outside the fine band/i,
    );
    await t.assertValid(user);
  });
});

describe('changing a bucket', () => {
  it('re-runs comparisons in the new band and lands in the right partition', async () => {
    const scores = new Map();
    const ids = [];
    for (let i = 0; i < 4; i += 1) {
      const id = await t.createMovie(`Rebucket ${i}`, 5800 + i);
      ids.push(id);
      scores.set(id, i);
      await t.rankToCompletion(id, 'loved', decideBy(scores));
    }
    const demoted = await t.createMovie('Demoted', 5810);
    await t.rankToCompletion(demoted, 'loved', decideBy(new Map([[demoted, 99]])));
    await t.assertValid(user);

    const started = await one(t.db, `select rank_rebucket($1, 'not_for_me') as r`, [demoted]);

    // The only not_for_me title, so the band was empty and no comparison is due.
    assert.equal(started.done, true);
    await t.assertValid(user);

    const ranking = await t.ranking(user);
    assert.equal(ranking.at(-1).title, 'Demoted');
    assert.equal(ranking.at(-1).bucket, 'not_for_me');
    assert.deepEqual(
      ranking.map((r) => r.position),
      [1, 2, 3, 4, 5],
      'no gap was left behind by the move',
    );
  });

  it('refuses a change to the bucket the title is already in', async () => {
    const m = await t.createMovie('Same Bucket', 5900);
    await t.rankToCompletion(m, 'fine', async (p) => p);
    await assert.rejects(
      () => t.sql(`select rank_rebucket($1, 'fine')`, [m]),
      /already in that bucket/i,
    );
  });
});

describe('unranking', () => {
  it('closes the gap and keeps the viewing history', async () => {
    // PRD §10: reranking and recalibration never delete viewing history.
    const scores = new Map();
    const ids = [];
    for (let i = 0; i < 4; i += 1) {
      const id = await t.createMovie(`Unrank ${i}`, 6000 + i);
      ids.push(id);
      scores.set(id, i);
      await t.rankToCompletion(id, 'loved', decideBy(scores));
    }

    await t.sql(`select rank_unrank($1)`, [ids[1]]);
    await t.assertValid(user);

    const ranking = await t.ranking(user);
    assert.deepEqual(
      ranking.map((r) => r.position),
      [1, 2, 3],
      'positions close up with no gap',
    );
    assert.deepEqual(
      ranking.map((r) => r.title),
      ['Unrank 0', 'Unrank 2', 'Unrank 3'],
    );

    const { rows } = await t.sql(
      `select bucket from user_media where user_id = $1 and media_item_id = $2`,
      [user, ids[1]],
    );
    assert.equal(rows[0].bucket, 'loved', 'the title reverts to Logged, keeping its bucket');
  });
});

describe('the unranked queue', () => {
  it('offers the highest bucket first and excludes ranked titles', async () => {
    const mid = await t.createMovie('Queue Fine', 6100);
    const bad = await t.createMovie('Queue Bad', 6101);
    const good = await t.createMovie('Queue Loved', 6102);
    const done = await t.createMovie('Queue Ranked', 6103);

    // Logged but not ranked.
    for (const [id, bucket] of [
      [mid, 'fine'],
      [bad, 'not_for_me'],
      [good, 'loved'],
    ]) {
      await t.sql(
        `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, $3::taste_bucket)`,
        [user, id, bucket],
      );
    }
    await t.rankToCompletion(done, 'loved', async (p) => p);

    const { rows } = await t.sql(`select * from unranked_queue(10)`);
    assert.deepEqual(
      rows.map((r) => r.bucket),
      ['loved', 'fine', 'not_for_me'],
      'highest bucket first (PRD §11)',
    );
    assert.equal(rows.length, 3, 'the already-ranked title is excluded');
  });
});

describe('property: invariants survive arbitrary interleaved activity', () => {
  it('holds through 60 randomised operations', async () => {
    const buckets = ['loved', 'fine', 'not_for_me'];
    const scores = new Map();
    const ranked = [];
    const pool = [];

    for (let i = 0; i < 40; i += 1) {
      const id = await t.createMovie(`Prop ${i}`, 7000 + i);
      pool.push(id);
      scores.set(id, Math.random());
    }

    // Deterministic pseudo-random so a failure is reproducible.
    let state = 42;
    const rand = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };

    for (let step = 0; step < 60; step += 1) {
      const roll = rand();

      if (roll < 0.65 && pool.length > 0) {
        const id = pool.pop();
        const bucket = buckets[Math.floor(rand() * 3)];
        await t.rankToCompletion(id, bucket, decideBy(scores));
        ranked.push(id);
      } else if (roll < 0.8 && ranked.length > 1) {
        const id = ranked.splice(Math.floor(rand() * ranked.length), 1)[0];
        await t.sql(`select rank_unrank($1)`, [id]);
        pool.push(id);
      } else if (ranked.length > 1) {
        const id = ranked[Math.floor(rand() * ranked.length)];
        const { rows } = await t.sql(
          `select r.bucket, b.lo, b.hi
             from rankings r,
                  lateral band_bounds($1, r.category, r.bucket) b
            where r.user_id = $1 and r.media_item_id = $2`,
          [user, id],
        );
        const { lo, hi } = rows[0];
        const target = lo + Math.floor(rand() * (hi - lo + 1));
        await t.sql(`select rank_reorder($1, $2)`, [id, target]);
      }

      // The point of the test: after every single operation, not just at the end.
      await t.assertValid(user);
    }

    const ranking = await t.ranking(user);
    assert.ok(ranking.length > 5, 'the run must actually have built a ranking');
    assert.deepEqual(
      ranking.map((r) => r.position),
      Array.from({ length: ranking.length }, (_, i) => i + 1),
    );
  });
});
