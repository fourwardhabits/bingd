import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * **A sitting is one post** (`20261020000100`, founder 2026-09-24).
 *
 * Working through an imported library used to be silent, because forty `title_ranked`
 * rows in four minutes is a feed nobody can read. The correction is one grouped row per
 * sitting that grows as titles finish, and what this file has to prove is the pair of
 * claims that makes it safe:
 *
 *   1. **It groups.** The first finished title creates the post; every later one in the
 *      same sitting updates that same row rather than adding another. A different sitting
 *      is a different post.
 *   2. **It is ranking activity and nothing else.** No `watch_events` row, no movement of
 *      `watched_on`, and therefore no effect on Recently watched or on the monthly
 *      leaderboard — which is the whole reason the feature was allowed to exist at all.
 *      The Oasis case is asserted directly: an imported Sep 10 watch, ranked later, keeps
 *      Sep 10 while the post carries the ranking's own time.
 */

let t;
let user;
let seq = 0;
let tmdb = 960_000;

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

beforeEach(async () => {
  seq += 1;
  user = await t.createUser({ username: `batch_${seq}` });
  await t.actAs(user);
});

const op = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
const sitting = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
const movie = (title) => t.createMovie(title, (tmdb += 1));

const note = async (s, id) =>
  (
    await t.sql(`select rank_batch_note($1, $2, $3) as r`, [await op(), s, id])
  ).rows[0].r;

const events = async () =>
  (
    await t.sql(
      `select id, type, media_item_id, payload from feed_events
        where actor_id = $1 and type = 'ranking_batch' order by created_at`,
      [user],
    )
  ).rows;

/** A ranked title, so `rank_batch_note` has something it is willing to announce. */
async function ranked(name, { watchedOn = null } = {}) {
  const id = await movie(`${name} ${seq}`);
  await t.sql(`insert into user_media (user_id, media_item_id) values ($1, $2)`, [user, id]);
  if (watchedOn) {
    await t.sql(
      `insert into watch_events (user_id, media_item_id, watched_on, basis)
       values ($1, $2, $3::date, 'diary')`,
      [user, id, watchedOn],
    );
  }
  await t.rankToCompletion(id, 'loved', (pivot, subject) => subject);
  return id;
}

describe('one post per sitting', () => {
  it('the first finished title creates it', async () => {
    const s = await sitting();
    const heat = await ranked('Heat');

    const result = await note(s, heat);

    assert.equal(result.status, 'ok');
    assert.equal(result.count, 1);
    const rows = await events();
    assert.equal(rows.length, 1);
    // The row names the first title, which is the one the feed sentence says aloud.
    assert.equal(rows[0].media_item_id, heat);
    assert.equal(rows[0].payload.count, 1);
  });

  it('later titles update the same row rather than adding another', async () => {
    const s = await sitting();
    const heat = await ranked('Heat');
    const ronin = await ranked('Ronin');
    const collateral = await ranked('Collateral');

    await note(s, heat);
    await note(s, ronin);
    const third = await note(s, collateral);

    assert.equal(third.count, 3);
    const rows = await events();
    assert.equal(rows.length, 1, 'three placements must be one post');
    assert.equal(rows[0].payload.count, 3);
    // Still named by the first: the sentence does not change under the reader.
    assert.equal(rows[0].media_item_id, heat);
  });

  it('a later sitting is a second post', async () => {
    const heat = await ranked('Heat');
    const ronin = await ranked('Ronin');

    await note(await sitting(), heat);
    await note(await sitting(), ronin);

    assert.equal((await events()).length, 2);
  });

  it('the same title twice in one sitting counts once', async () => {
    const s = await sitting();
    const heat = await ranked('Heat');

    await note(s, heat);
    const again = await note(s, heat);

    assert.equal(again.count, 1);
    assert.equal((await events())[0].payload.count, 1);
  });

  it('refuses a title the caller has not ranked', async () => {
    // A skipped title never reaches this call in the client, and a title that was never
    // placed must not be announceable even if it did.
    const s = await sitting();
    const unranked = await movie(`Unplaced ${seq}`);
    await t.sql(`insert into user_media (user_id, media_item_id) values ($1, $2)`, [
      user,
      unranked,
    ]);

    const result = await note(s, unranked);

    assert.equal(result.status, 'not_ranked');
    assert.equal((await events()).length, 0);
  });

  it('keeps its place in the feed as it grows', async () => {
    // The Feed is paged by a keyset over causal_at, so a post that bumped it on every
    // placement would jump the page and could be served twice or skipped.
    const s = await sitting();
    const heat = await ranked('Heat');
    const ronin = await ranked('Ronin');

    await note(s, heat);
    const [before_] = await events();
    await note(s, ronin);
    const [after_] = await events();

    const at = async (id) =>
      (await t.sql(`select causal_at from feed_events where id = $1`, [id])).rows[0].causal_at;
    assert.deepEqual(await at(before_.id), await at(after_.id));
  });
});

describe('ranking activity is not a watch', () => {
  it('writes no watch event and moves no watch date', async () => {
    // The Oasis case: imported with a Sep 10 diary date, ranked later. The post records
    // the ranking; the watch chronology is untouched.
    const s = await sitting();
    const oasis = await ranked('Oasis', { watchedOn: '2026-09-10' });

    const countWatches = async () =>
      (
        await t.sql(
          `select count(*)::int as n from watch_events where user_id = $1 and media_item_id = $2`,
          [user, oasis],
        )
      ).rows[0].n;
    const before_ = await t.sql(
      `select watched_on from user_media where user_id = $1 and media_item_id = $2`,
      [user, oasis],
    );
    const watchesBefore = await countWatches();
    await note(s, oasis);
    const after_ = await t.sql(
      `select watched_on from user_media where user_id = $1 and media_item_id = $2`,
      [user, oasis],
    );

    assert.equal(String(after_.rows[0].watched_on), String(before_.rows[0].watched_on));
    // Unchanged, whatever the fixture's own ranking did before it: the post adds none.
    assert.equal(await countWatches(), watchesBefore, 'the post must not add a watch');
    const diary = await t.sql(
      `select watched_on::text as watched from watch_events
        where user_id = $1 and media_item_id = $2 and basis = 'diary'`,
      [user, oasis],
    );
    assert.equal(diary.rows[0].watched, '2026-09-10');
  });

  it('leaves the row that Recently added and Recently watched sort on', async () => {
    const s = await sitting();
    const heat = await ranked('Heat', { watchedOn: '2018-05-25' });
    const before_ = (
      await t.sql(
        `select created_at, watched_on from user_media where user_id = $1 and media_item_id = $2`,
        [user, heat],
      )
    ).rows[0];

    await note(s, heat);

    const after_ = (
      await t.sql(
        `select created_at, watched_on from user_media where user_id = $1 and media_item_id = $2`,
        [user, heat],
      )
    ).rows[0];
    assert.deepEqual(after_.created_at, before_.created_at);
    assert.deepEqual(after_.watched_on, before_.watched_on);
  });
});

describe('the expanded list', () => {
  it('returns every title in the order it was placed, with its current score', async () => {
    const s = await sitting();
    const heat = await ranked('Heat');
    const ronin = await ranked('Ronin');
    await note(s, heat);
    await note(s, ronin);
    const [event] = await events();

    const { rows } = await t.sql(`select * from ranking_batch_titles($1)`, [event.id]);

    assert.equal(rows.length, 2);
    assert.equal(rows[0].media_item_id, heat, 'placement order, not alphabetical');
    for (const row of rows) {
      assert.ok(row.position > 0, 'a canonical position');
      assert.ok(Number(row.score) > 0, 'and the score it holds now');
    }
  });

  it('shows nothing to somebody who may not see the actor', async () => {
    const s = await sitting();
    const heat = await ranked('Heat');
    await note(s, heat);
    const [event] = await events();

    const stranger = await t.createUser({ username: `stranger_${seq}` });
    await t.sql(`update profiles set visibility = 'private' where id = $1`, [user]);
    await t.actAs(stranger);

    const { rows } = await t.sql(`select * from ranking_batch_titles($1)`, [event.id]);
    assert.equal(rows.length, 0);
  });
});
