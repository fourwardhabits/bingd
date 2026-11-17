import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * **A group shown as its posters** (Feed Poster Rails, PR 1, 20261127000100).
 *
 * `feed_group_previews` returns a bounded, ordered preview of the members of each grouped
 * watchlist and ranking post on a Feed page, in one call, with the author's own score on
 * its own ladder, and nothing at all for a post the caller may not see.
 */
let t;
let follower;
let stranger;
let tmdb = 990_000;
let n = 0;

before(async () => {
  t = await createTestDb();
  follower = await t.createUser({ username: 'gp_follower' });
  stranger = await t.createUser({ username: 'gp_stranger' });
});

after(async () => t?.close());

const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
const film = async (title) => t.createMovie(`${title} ${(tmdb += 1)}`, tmdb);

const actor = async (options = {}) => {
  n += 1;
  const id = await t.createUser({ username: `gp_actor_${n}`, ...options });
  await t.actAs(id);
  return id;
};

const save = async (mediaItemId) =>
  t.sql(`select set_watchlist($1, $2, true)`, [await uuid(), mediaItemId]);

const watchlistPost = async (actorId) =>
  (
    await t.sql(
      `select id, payload from feed_events where actor_id = $1 and type = 'watchlist_added'
        order by causal_at desc limit 1`,
      [actorId],
    )
  ).rows[0];

const rankedMovie = async (user, name) => {
  const id = await film(name);
  await t.sql(`insert into user_media (user_id, media_item_id) values ($1, $2)`, [user, id]);
  await t.rankToCompletion(id, 'loved', (pivot, subject) => subject);
  return id;
};

const rankedSeason = async (user, name) => {
  const show = await t.createSeries(`${name} ${(tmdb += 1)}`, tmdb);
  const id = await t.createSeason(show, 2, `${name} S2`);
  await t.sql(`insert into user_media (user_id, media_item_id) values ($1, $2)`, [user, id]);
  await t.rankToCompletion(id, 'loved', (pivot, subject) => subject);
  return id;
};

/** One finished Unranked sitting of the given titles, as its author. */
const sitting = async (titles) => {
  const s = await uuid();
  for (const id of titles)
    await t.sql(`select rank_batch_note($1, $2, $3)`, [await uuid(), s, id]);
  const { rows } = await t.sql(`select rank_batch_finalize($1, $2) as r`, [await uuid(), s]);
  return rows[0].r.event_id;
};

const previews = (viewer, ids, limit) =>
  t.asUser(viewer, async () => {
    const { rows } = await t.sql(
      limit === undefined
        ? `select * from feed_group_previews($1::uuid[])`
        : `select * from feed_group_previews($1::uuid[], $2)`,
      limit === undefined ? [ids] : [ids, limit],
    );
    return rows;
  });

describe('watchlist groups', () => {
  it('previews the members in save order, with their artwork fields', async () => {
    const me = await actor();
    const titles = [];
    for (const name of ['Dune', 'Arrival', 'Sicario']) {
      const id = await film(name);
      titles.push(id);
      await save(id);
    }
    const post = await watchlistPost(me);
    assert.equal(post.payload.count, 3);

    const rows = await previews(follower, [post.id]);
    assert.deepEqual(
      rows.map((row) => row.media_item_id),
      titles,
    );
    assert.deepEqual(
      rows.map((row) => row.ordinal),
      [1, 2, 3],
    );
    assert.ok(rows.every((row) => row.event_id === post.id && row.kind === 'movie'));
    assert.ok(rows.every((row) => row.score === null && row.ranked === false));
  });

  it('is capped per post, so a large group never loads every member', async () => {
    const me = await actor();
    for (let i = 0; i < 15; i += 1) await save(await film(`Big ${i}`));
    const post = await watchlistPost(me);
    assert.equal(post.payload.count, 15);
    assert.equal((await previews(follower, [post.id])).length, 12, 'the default preview');
    assert.equal((await previews(follower, [post.id], 3)).length, 3);
    assert.equal((await previews(follower, [post.id], 500)).length, 15, 'never above 20');
  });
});

describe('ranking groups', () => {
  it('carries the author’s own score for each member, on its own ladder', async () => {
    const me = await actor();
    const heat = await rankedMovie(me, 'Heat');
    const ronin = await rankedMovie(me, 'Ronin');
    const season = await rankedSeason(me, 'Severance');
    const eventId = await sitting([heat, ronin, season]);

    const sheet = (
      await t.sql(`select media_item_id, score from ranking_batch_titles($1)`, [eventId])
    ).rows;
    const rows = await previews(follower, [eventId]);
    assert.deepEqual(
      rows.map((row) => row.media_item_id),
      sheet.map((row) => row.media_item_id),
      'the order the View all sheet reads',
    );
    for (const row of rows) {
      const expected = sheet.find((s) => s.media_item_id === row.media_item_id).score;
      assert.equal(Number(row.score), Number(expected), 'the score the sheet shows');
      assert.equal(row.ranked, true);
    }
    const seasonRow = rows.find((row) => row.media_item_id === season);
    assert.equal(seasonRow.kind, 'season');
    assert.equal(seasonRow.season_number, 2);
    assert.ok(seasonRow.parent_title, 'a season names its show');
    // A season alone on its ladder tops it, whatever two loved movies did on theirs.
    assert.equal(Number(seasonRow.score), 10);
  });

  it('keeps a title the author has since unranked, without a score', async () => {
    const me = await actor();
    const kept = await rankedMovie(me, 'Kept');
    const dropped = await rankedMovie(me, 'Dropped');
    const eventId = await sitting([kept, dropped]);
    await t.sql(`delete from rankings where user_id = $1 and media_item_id = $2`, [
      me,
      dropped,
    ]);

    const rows = await previews(follower, [eventId]);
    assert.equal(rows.length, 2, 'the poster stays');
    const gone = rows.find((row) => row.media_item_id === dropped);
    assert.equal(gone.score, null, 'no invented or stale number');
    assert.equal(gone.ranked, false);
    assert.notEqual(rows.find((row) => row.media_item_id === kept).score, null);
  });
});

describe('one call for a page', () => {
  it('answers several posts at once, each keeping its own members', async () => {
    const a = await actor();
    await save(await film('A1'));
    await save(await film('A2'));
    const first = await watchlistPost(a);
    const b = await actor();
    const x = await rankedMovie(b, 'B1');
    const y = await rankedMovie(b, 'B2');
    const second = await sitting([x, y]);

    const rows = await previews(follower, [first.id, second, await uuid()]);
    assert.equal(rows.filter((row) => row.event_id === first.id).length, 2);
    assert.equal(rows.filter((row) => row.event_id === second).length, 2);
  });

  it('ignores ids past the fiftieth', async () => {
    const me = await actor();
    await save(await film('Late 1'));
    await save(await film('Late 2'));
    const post = await watchlistPost(me);
    const padding = [];
    for (let i = 0; i < 50; i += 1) padding.push(await uuid());
    assert.equal((await previews(follower, [...padding, post.id])).length, 0);
    assert.equal((await previews(follower, [post.id, ...padding])).length, 2);
  });
});

describe('visibility', () => {
  it('returns nothing across a block, or on a private account the caller does not follow', async () => {
    const me = await actor();
    await save(await film('Blocked 1'));
    await save(await film('Blocked 2'));
    const post = await watchlistPost(me);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [me, stranger]);
    assert.equal((await previews(stranger, [post.id])).length, 0);

    const shy = await actor({ visibility: 'private' });
    await save(await film('Private 1'));
    await save(await film('Private 2'));
    const hidden = await watchlistPost(shy);
    assert.equal((await previews(follower, [hidden.id])).length, 0);
    assert.equal((await previews(shy, [hidden.id])).length, 2, 'the author reads their own');
  });

  it('gives an anonymous caller nothing, and is not executable by anon', async () => {
    const me = await actor();
    await save(await film('Anon 1'));
    await save(await film('Anon 2'));
    const post = await watchlistPost(me);
    const error = await t.asAnon(() =>
      t.errorFrom(`select * from feed_group_previews($1::uuid[])`, [[post.id]]),
    );
    assert.ok(error, 'revoked from anon');
  });

  it('never reads an unfinished sitting, or a post that is not a group type', async () => {
    const me = await actor();
    const draftTitle = await rankedMovie(me, 'Drafted');
    const s = await uuid();
    const { rows: noted } = await t.sql(`select rank_batch_note($1, $2, $3) as r`, [
      await uuid(),
      s,
      draftTitle,
    ]);
    const draftId = noted[0].r.event_id;
    const type = (await t.sql(`select type from feed_events where id = $1`, [draftId])).rows[0];
    assert.equal(type.type, 'ranking_batch_draft');
    assert.equal((await previews(me, [draftId])).length, 0, 'not even to its author');

    const single = await film('Single');
    const { rows } = await t.sql(
      `insert into feed_events (actor_id, type, media_item_id) values ($1, 'title_ranked', $2) returning id`,
      [me, single],
    );
    assert.equal((await previews(follower, [rows[0].id])).length, 0);
  });
});
