import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb, one } from './harness.mjs';

/**
 * The score behind a feed card is the one its owner holds now — `public_scores`
 * (`20261002000100`).
 *
 * The founder's report of 2026-09-19 was "rank a movie, look at the Feed, rerank it, look
 * again, and the Feed still shows the first score". The snapshot in
 * `feed_events.payload` (`20260815010000`) is why, and this file pins both halves of the
 * reason, because only one of them is in the report:
 *
 *   1. **A correction posts no activity.** `20260826000500` made a re-placement that is
 *      not an explicit rewatch write no `title_ranked` row, and `20261001000100`
 *      confirmed that as the rule. So the payload is never rewritten and a refetch
 *      returns the same stale number. This is the report.
 *
 *   2. **A score is band-relative.** `score_for(bucket, band_rank, band_size)`
 *      interpolates across the band's range, so ranking *anything* into a band re-scores
 *      every other title in it. Every card older than the reader's last ranking is
 *      therefore stale too, without anybody touching the film it names.
 *
 * The drift is asserted here rather than merely described: several tests below check that
 * the payload has *not* moved at the same moment they check that `public_scores` has. A
 * test that only read the new function could go green against a build that had quietly
 * started rewriting payloads, which is a much more expensive fix for the same symptom.
 *
 * The arithmetic is checked against `_rank_finalize`'s own answer and against
 * `title_reviews_v2`, which has read live rankings since `20260825000100`, so this cannot
 * become a fourth definition of the score that agrees with nothing.
 *
 * The client half — which rows are hydrated, and what a failed read falls back to — is
 * `src/features/feed/use-feed.test.ts`.
 */

let t;
let owner;
let viewer;
let seq = 0;

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

beforeEach(async () => {
  seq += 1;
  owner = await t.createUser({ username: `scorer_${seq}` });
  viewer = await t.createUser({ username: `reader_${seq}` });
  await t.actAs(owner);
});

const movie = (title) => t.createMovie(title, (seq += 1) + 71000);
const op = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

/** Ranks a film to completion, always preferring it, and returns the placement. */
const rank = (item, bucket = 'loved') =>
  t.rankToCompletion(item, bucket, async (pivot) => pivot);

/** Answers an already-open session to completion, always preferring the subject. */
const finish = async (step, subject) => {
  let current = step;
  let guard = 0;
  while (!current.done) {
    current = await one(t.db, `select rank_answer($1, $2, $3) as r`, [
      current.session_id,
      subject,
      await op(),
    ]);
    guard += 1;
    if (guard > 32) throw new Error('did not converge');
  }
  return current;
};

/** *Update your rating*, same band — the act in the founder's report. */
const correct = async (item, bucket = 'loved') =>
  finish(await one(t.db, `select rank_again($1, $2, $3, false) as r`, [item, bucket, await op()]), item);

/** *Update your rating* into another band. */
const correctBand = async (item, bucket) =>
  finish(await one(t.db, `select rank_rebucket($1, $2, $3) as r`, [item, bucket, await op()]), item);

/** What the card would draw from the snapshot: the payload of the latest ranking event. */
const snapshot = async (item, actor = owner) => {
  const { rows } = await t.sql(
    `select payload from feed_events
      where actor_id = $1 and media_item_id = $2 and type = 'title_ranked'
      order by causal_at desc, causal_step desc limit 1`,
    [actor, item],
  );
  return rows[0]?.payload ?? null;
};

/** What the card draws now: `public_scores`, asked the way the feed asks it. */
const live = async (item, { actor = owner, as = null } = {}) => {
  const read = async () => {
    const { rows } = await t.sql(
      `select * from public_scores($1::uuid[], $2::uuid[])`,
      [[actor], [item]],
    );
    return rows[0] ?? null;
  };
  return as ? t.asUser(as, read) : read();
};

const num = (value) => (value === null || value === undefined ? null : Number(value));

/** Fills a band so it is never one title wide, which is the only size with no interior. */
const anchors = async (n, bucket = 'loved') => {
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const film = await movie(`Anchor ${bucket} ${i}`);
    await rank(film, bucket);
    ids.push(film);
  }
  return ids;
};

// ---------------------------------------------------------------------------

describe('the founder’s report', () => {
  it('a correction moves the live score and leaves the snapshot where it was', async () => {
    await anchors(4);
    const film = await movie('Sinners');
    // Every comparison goes to the incumbent, so it lands at the bottom of the band.
    const placed = await rank(film, 'loved');
    const first = num((await snapshot(film)).score);
    assert.equal(num(placed.score), first, 'the event records what the placement returned');

    // Rerank it to the top of the same band. This is `rank_again` with p_new_watch false,
    // which posts nothing — so the only thing that can have changed is `rankings`.
    await correct(film);

    const after = await live(film);
    assert.notEqual(num(after.score), first, 'the reader moved it and the number moved');
    assert.equal(
      num((await snapshot(film)).score),
      first,
      'and the snapshot did not, which is the whole defect: no new event, no new payload',
    );
  });

  it('a correction into another band moves the band the badge is tinted with', async () => {
    await anchors(3, 'loved');
    await anchors(3, 'fine');
    const film = await movie('Reconsidered');
    await rank(film, 'loved');
    assert.equal((await snapshot(film)).bucket, 'loved');

    await correctBand(film, 'fine');

    const after = await live(film);
    assert.equal(after.bucket, 'fine');
    assert.ok(num(after.score) <= 6.9, 'inside the It was fine range');
    assert.equal((await snapshot(film)).bucket, 'loved', 'the snapshot still says loved');
  });

  it('re-scores a card nobody touched, when a later ranking grows its band', async () => {
    // The half of the defect the report does not mention. Nothing happens to this film at
    // all; the band around it grows and its number changes with it.
    await anchors(2);
    const film = await movie('Untouched');
    await rank(film, 'loved');
    const before = num((await live(film)).score);

    for (let i = 0; i < 6; i += 1) {
      const other = await movie(`Later ${i}`);
      // Preferring the incumbent puts each new title below it, so `film` keeps its
      // ordinal and only the band's size changes. The score is band-relative, so it moves.
      await t.rankToCompletion(other, 'loved', async (pivot) => pivot);
    }

    assert.notEqual(num((await live(film)).score), before, 'the band grew under it');
    assert.equal(num((await snapshot(film)).score), before, 'the card would still say the old one');
  });
});

describe('the arithmetic is the schema’s own', () => {
  it('agrees with the score `_rank_finalize` returned for a fresh placement', async () => {
    await anchors(5);
    const film = await movie('Fresh');
    const placed = await rank(film, 'loved');

    assert.equal(num((await live(film)).score), num(placed.score));
  });

  it('agrees with `title_reviews_v2`, which has read live rankings since 20260825000100', async () => {
    await anchors(4);
    const film = await movie('Reviewed');
    await rank(film, 'loved');
    await t.sql(
      `update user_media set note = $3, note_visibility = 'public'
        where user_id = $1 and media_item_id = $2`,
      [owner, film, 'A note, so the review read has a row to return.'],
    );
    await correct(film);

    const { rows } = await t.sql(`select * from title_reviews_v2($1, 'recent', 25)`, [film]);
    const review = rows.find((row) => row.user_id === owner);
    assert.ok(review, 'the review read found the note');
    assert.equal(num((await live(film)).score), num(review.score));
  });

  it('reports the position and band the ranking actually holds', async () => {
    const [first] = await anchors(3);
    const film = await movie('Second place');
    // Lose to the incumbent at the top, win everything else.
    await t.rankToCompletion(film, 'loved', async (pivot, subject) =>
      pivot === first ? pivot : subject,
    );

    const row = await live(film);
    const { rows } = await t.sql(
      `select position, bucket from rankings where user_id = $1 and media_item_id = $2`,
      [owner, film],
    );
    assert.equal(row.position, rows[0].position);
    assert.equal(row.bucket, rows[0].bucket);
  });

  it('scores the only title in a band at the top of it', async () => {
    const film = await movie('Alone');
    await rank(film, 'loved');
    assert.equal(num((await live(film)).score), 10);
  });

  it('answers for several pairs in one call, and matches them by pair', async () => {
    const other = await t.createUser({ username: `other_${seq}` });
    const mine = await movie('Mine');
    const theirs = await movie('Theirs');
    await rank(mine, 'loved');
    await t.actAs(other);
    await t.rankToCompletion(theirs, 'not_for_me', async (pivot) => pivot);
    await t.actAs(owner);

    const { rows } = await t.sql(`select * from public_scores($1::uuid[], $2::uuid[])`, [
      [owner, other],
      [mine, theirs],
    ]);
    assert.equal(rows.length, 2, 'the cross-product resolves to the two pairs that exist');
    const byUser = Object.fromEntries(rows.map((row) => [row.user_id, row]));
    assert.equal(byUser[owner].media_item_id, mine);
    assert.equal(byUser[other].media_item_id, theirs);
    assert.ok(num(byUser[other].score) <= 3.4, 'the other account’s band, not this one’s');
  });
});

describe('a pair with no ranking', () => {
  it('returns no row once the title is unranked, though the activity survives', async () => {
    // `rank_unrank` takes the position and leaves the feed event standing — `20260818000100`
    // deliberately left that path alone. So the card still says "ranked" and there is no
    // rating behind it; the read says so rather than handing back the old number.
    await anchors(2);
    const film = await movie('Taken back');
    await rank(film, 'loved');
    assert.ok(await snapshot(film), 'the activity exists');

    await t.sql(`select rank_unrank($1)`, [film]);

    assert.equal(await live(film), null);
    assert.ok(await snapshot(film), 'and the activity still exists, which is the point');
  });

  it('returns no row for a title that was only logged', async () => {
    const film = await movie('Logged only');
    await t.sql(`select set_bucket($1, $2, 'fine')`, [await op(), film]);
    assert.equal(await live(film), null);
  });
});

describe('who may read a score', () => {
  it('answers a stranger about a public account', async () => {
    await anchors(2);
    const film = await movie('Public');
    await rank(film, 'loved');

    assert.ok(await live(film, { as: viewer }), 'can_i_view admits a public profile');
  });

  it('refuses a stranger looking at a private account', async () => {
    const closed = await t.createUser({ username: `closed_${seq}`, visibility: 'private' });
    await t.actAs(closed);
    const film = await movie('Private');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    await t.actAs(owner);

    assert.equal(await live(film, { actor: closed, as: viewer }), null);
  });

  it('admits an approved follower of a private account', async () => {
    const closed = await t.createUser({ username: `closed2_${seq}`, visibility: 'private' });
    await t.actAs(closed);
    const film = await movie('Private, followed');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    await t.actAs(owner);
    await t.sql(
      `insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`,
      [viewer, closed],
    );

    assert.ok(await live(film, { actor: closed, as: viewer }));
  });

  it('counts the band under the same policy, so a refused band is not a wrong score', async () => {
    // The subtle failure a definer function would have: the row hidden, the *count*
    // visible, and a score computed against a band the caller may not see. `band_bounds`
    // is invoker and stable, so the count and the row are admitted or refused together.
    const closed = await t.createUser({ username: `closed3_${seq}`, visibility: 'private' });
    await t.actAs(closed);
    const films = [];
    for (let i = 0; i < 3; i += 1) {
      const film = await movie(`Hidden ${i}`);
      await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
      films.push(film);
    }
    await t.actAs(owner);

    const rows = await t.asUser(viewer, async () =>
      (await t.sql(`select * from public_scores($1::uuid[], $2::uuid[])`, [[closed], films])).rows,
    );
    assert.equal(rows.length, 0);
  });
});

describe('the call itself', () => {
  it('refuses a call with no user filter', async () => {
    const error = await t.errorFrom(`select * from public_scores(null, $1::uuid[])`, [
      [await movie('Unfiltered')],
    ]);
    assert.ok(error, 'refused');
    assert.match(String(error.message), /requires a user filter/);
  });

  it('refuses a call with no title filter', async () => {
    const error = await t.errorFrom(`select * from public_scores($1::uuid[], null)`, [[owner]]);
    assert.ok(error, 'refused');
    assert.match(String(error.message), /requires a user filter/);
  });

  it('refuses more than fifty ids in a filter', async () => {
    const many = Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const error = await t.errorFrom(`select * from public_scores($1::uuid[], $2::uuid[])`, [
      [owner],
      many,
    ]);
    assert.ok(error, 'refused');
    assert.match(String(error.message), /at most 50/);
  });

  it('is empty rather than an error when nothing matches', async () => {
    const { rows } = await t.sql(`select * from public_scores($1::uuid[], $2::uuid[])`, [
      [owner],
      [await movie('Never ranked')],
    ]);
    assert.equal(rows.length, 0);
  });
});
