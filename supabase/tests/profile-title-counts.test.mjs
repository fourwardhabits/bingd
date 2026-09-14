import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The profile's Movies and TV — `20260917001600`.
 *
 * Locked product decision (2026-09-12): those two numbers are the watched collection,
 * imported history included, and not the ranked count. These tests say it as sentences about
 * an account: what counts, who may count it, and what is not watched yet.
 */

let t;
let seq = 173000;

const movie = (title) => t.createMovie(`${title} ${seq}`, seq++);

const counts = async (viewer, subject) =>
  t.asUser(viewer, async () => {
    const { rows } = await t.sql(`select * from profile_title_counts($1)`, [subject]);
    return rows[0];
  });

const importWatched = (user, item) =>
  t.sql(
    `insert into user_media (user_id, media_item_id, bucket, source) values ($1, $2, 'loved', 'imported')`,
    [user, item],
  );

const rank = async (user, item) => {
  await t.actAs(user);
  // An empty band places outright; later films are compared, and the new one always wins.
  await t.rankToCompletion(item, 'loved', (_pivot, subject) => subject);
  await t.actAs(null);
};

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t.close();
});

describe('what Movies counts', () => {
  let ana;

  before(async () => {
    ana = await t.createUser({ username: 'counts_ana' });
  });

  beforeEach(async () => {
    await t.sql(`delete from rankings where user_id = $1`, [ana]);
    await t.sql(`delete from user_media where user_id = $1`, [ana]);
  });

  it('counts ranked films, as it always did', async () => {
    await rank(ana, await movie('Ranked A'));
    await rank(ana, await movie('Ranked B'));
    assert.deepEqual(await counts(ana, ana), { movies: 2, tv: 0 });
  });

  it('counts imported watched films, which have no ranking', async () => {
    await rank(ana, await movie('Ranked Here'));
    for (let i = 0; i < 3; i += 1) await importWatched(ana, await movie(`Imported ${i}`));

    assert.deepEqual(await counts(ana, ana), { movies: 4, tv: 0 });
    // The ranked count, which Taste Match and every ranking surface read, did not move.
    const { rows } = await t.sql(`select count(*)::int as n from rankings where user_id = $1`, [
      ana,
    ]);
    assert.equal(rows[0].n, 1);
  });

  it('counts a film that is imported and then ranked here once', async () => {
    const both = await movie('Both');
    await importWatched(ana, both);
    await rank(ana, both);
    assert.deepEqual(await counts(ana, ana), { movies: 1, tv: 0 });
  });

  it('counts a film logged as watched here and not ranked', async () => {
    const logged = await movie('Logged');
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket, source) values ($1, $2, 'fine', 'in_app')`,
      [ana, logged],
    );
    assert.deepEqual(await counts(ana, ana), { movies: 1, tv: 0 });
  });

  it('counts seasons as TV and never as Movies', async () => {
    const series = await t.createSeries(`Counted Series ${seq}`, seq++);
    const s1 = await t.createSeason(series, 1, 'Season 1');
    const s2 = await t.createSeason(series, 2, 'Season 2');
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket, source) values ($1, $2, 'loved', 'in_app'), ($1, $3, 'loved', 'imported')`,
      [ana, s1, s2],
    );
    await importWatched(ana, await movie('Beside The Seasons'));
    assert.deepEqual(await counts(ana, ana), { movies: 1, tv: 2 });
  });
});

describe('who may count it', () => {
  let owner;
  let stranger;
  let follower;

  before(async () => {
    owner = await t.createUser({ username: 'counts_private', visibility: 'private' });
    stranger = await t.createUser({ username: 'counts_stranger' });
    follower = await t.createUser({ username: 'counts_follower' });
    await t.sql(
      `insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`,
      [follower, owner],
    );
    await importWatched(owner, await movie('Private Import'));
    await rank(owner, await movie('Private Ranked'));
  });

  it('gives an approved follower the same number the owner sees', async () => {
    assert.deepEqual(await counts(owner, owner), { movies: 2, tv: 0 });
    assert.deepEqual(await counts(follower, owner), { movies: 2, tv: 0 });
  });

  it('gives a stranger nothing about a private account, as the ranked count did', async () => {
    assert.deepEqual(await counts(stranger, owner), { movies: 0, tv: 0 });
  });

  it('is not callable signed out', async () => {
    const error = await t.asAnon(() =>
      t.errorFrom(`select * from profile_title_counts($1)`, [owner]),
    );
    assert.ok(error);
  });
});

/**
 * What still counts only rankings is covered where it runs: `import-pipeline.test.mjs`
 * ("counts for nothing on either leaderboard", "writes no rankings and no scores") drives
 * the real leaderboard and ranking functions over a real import. This suite is the count.
 */
describe('what is not watched yet', () => {
  it('leaves a season still being watched out of TV, and counts it once it is finished', async () => {
    const fay = await t.createUser({ username: 'counts_fay' });
    const series = await t.createSeries(`Half Watched ${seq}`, seq++);
    const season = await t.createSeason(series, 1, 'Season 1');
    await t.sql(
      `insert into user_media (user_id, media_item_id, source, progress)
       values ($1, $2, 'in_app', 'watching')`,
      [fay, season],
    );
    assert.deepEqual(await counts(fay, fay), { movies: 0, tv: 0 });

    await t.sql(`update user_media set progress = 'completed' where user_id = $1`, [fay]);
    assert.deepEqual(await counts(fay, fay), { movies: 0, tv: 1 });
  });
});
