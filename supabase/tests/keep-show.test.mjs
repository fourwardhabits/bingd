import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb, one } from './harness.mjs';
import { tvRanking } from './tv-ranking-support.mjs';

/**
 * Keep Show (20261120000100, founder spec t168u §3D): after a season is ranked, the reader
 * may confirm that their whole-show ranking stands. Durable, idempotent per season
 * placement, mutually exclusive with a linked Update Show, and it changes nothing about
 * any ranking, placement, watch, collection row or Feed.
 */
const ctx = { t: null, user: null, seq: 0 };
const { op, movie, rank, correct, positions, posts, fixture } = tvRanking(ctx);

before(async () => {
  ctx.t = await createTestDb();
});

after(async () => {
  await ctx.t?.close();
});

beforeEach(async () => {
  ctx.seq += 1;
  ctx.user = await ctx.t.createUser({ username: `keep_${ctx.seq}` });
  await ctx.t.actAs(ctx.user);
});

const keep = (placementId) => one(ctx.t.db, `select keep_show($1) as r`, [placementId]);

const reaffirmations = async () =>
  (
    await ctx.t.sql(
      `select * from show_reaffirmations where user_id = $1 order by created_at, id`,
      [ctx.user],
    )
  ).rows;

/** Every row Keep Show must never touch, for one reader. */
const ledger = async () => {
  const q = (sql) => ctx.t.sql(sql, [ctx.user]).then((r) => r.rows);
  return {
    rankings: await q(
      `select media_item_id, category, bucket, position from rankings where user_id = $1
        order by category, position`,
    ),
    placements: await q(`select id from ranking_placements where user_id = $1 order by id`),
    watches: await q(`select id from watch_events where user_id = $1 order by id`),
    userMedia: await q(
      `select media_item_id, bucket, watched_on from user_media where user_id = $1
        order by media_item_id`,
    ),
    feed: await q(`select id from feed_events where actor_id = $1 order by id`),
  };
};

describe('Keep Show records the reaffirmation, once', () => {
  it('keeps the show for a freshly ranked season, with a snapshot of the show ranking', async () => {
    const { main, seasons } = await fixture();
    await rank(main, 'loved', 80);
    const s2 = await rank(seasons[1], 'loved', 50);

    const r = await keep(s2.placement_id);
    assert.equal(r.status, 'kept');
    assert.equal(r.created, true);
    assert.ok(r.kept_at);

    const [row] = await reaffirmations();
    assert.equal(row.show_id, main);
    assert.equal(row.season_placement_id, s2.placement_id);
    const show = (await positions('tv_shows')).find((p) => p.media_item_id === main);
    assert.equal(row.show_bucket, show.bucket);
    assert.equal(row.show_position, show.position);
    const showPlacement = await ctx.t.sql(
      `select id, score from ranking_placements where user_id = $1 and media_item_id = $2
        order by created_at desc limit 1`,
      [ctx.user, main],
    );
    assert.equal(row.show_placement_id, showPlacement.rows[0].id);
    assert.ok(Number(row.show_score) >= 7 && Number(row.show_score) <= 10);
  });

  it('is one row however often it is called, and says so', async () => {
    const { main, seasons } = await fixture();
    await rank(main, 'loved', 80);
    const s1 = await rank(seasons[0], 'loved', 50);

    const first = await keep(s1.placement_id);
    const second = await keep(s1.placement_id);
    const third = await keep(s1.placement_id);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(third.created, false);
    assert.equal(second.kept_at, first.kept_at);
    assert.equal((await reaffirmations()).length, 1);
  });

  it('changes no ranking, placement, watch, collection row or Feed post', async () => {
    const { main, seasons } = await fixture();
    await rank(main, 'loved', 80);
    const s3 = await rank(seasons[2], 'loved', 50);
    const before = await ledger();

    await keep(s3.placement_id);
    await keep(s3.placement_id);

    assert.deepEqual(await ledger(), before);
    assert.equal((await posts(main)).length, 1);
  });

  it('keeps each season placement separately', async () => {
    const { main, seasons } = await fixture();
    await rank(main, 'loved', 80);
    const s1 = await rank(seasons[0], 'loved', 50);
    const s2 = await rank(seasons[1], 'loved', 40);
    await keep(s1.placement_id);
    await keep(s2.placement_id);
    assert.equal((await reaffirmations()).length, 2);
  });
});

describe('Keep Show is refused where Update Show would be', () => {
  it('refuses another user’s placement, answering as if it did not exist', async () => {
    const { main, seasons } = await fixture();
    await rank(main, 'loved', 80);
    const s1 = await rank(seasons[0], 'loved', 50);

    const other = await ctx.t.createUser({ username: `keep_other_${ctx.seq}` });
    await ctx.t.actAs(other);
    const err = await ctx.t.errorFrom(`select keep_show($1)`, [s1.placement_id]);
    assert.equal(err?.code, 'P0002');
    await ctx.t.actAs(ctx.user);
    assert.equal((await reaffirmations()).length, 0);
  });

  it('refuses a movie placement', async () => {
    const film = await movie('Heat');
    const placed = await rank(film, 'loved', 80);
    const err = await ctx.t.errorFrom(`select keep_show($1)`, [placed.placement_id]);
    assert.equal(err?.code, 'P0002');
  });

  it('refuses a stale placement, and one a later placement of the season superseded', async () => {
    const { main, seasons } = await fixture();
    await rank(main, 'loved', 80);

    const old = await rank(seasons[0], 'loved', 50);
    await ctx.t.sql(
      `update ranking_placements set created_at = now() - interval '2 days' where id = $1`,
      [old.placement_id],
    );
    assert.equal((await ctx.t.errorFrom(`select keep_show($1)`, [old.placement_id]))?.code, 'P0002');

    const first = await rank(seasons[1], 'loved', 60);
    await correct(seasons[1], 'fine');
    assert.equal(
      (await ctx.t.errorFrom(`select keep_show($1)`, [first.placement_id]))?.code,
      'P0002',
    );
  });

  it('refuses a pure correction of the season, which is not a new watch', async () => {
    const { main, seasons } = await fixture();
    await rank(main, 'loved', 80);
    await rank(seasons[0], 'loved', 50);
    await rank(seasons[1], 'loved', 60);
    await correct(seasons[0], 'loved');
    const correction = (
      await ctx.t.sql(
        `select id from ranking_placements where user_id = $1 and media_item_id = $2
          order by created_at desc limit 1`,
        [ctx.user, seasons[0]],
      )
    ).rows[0].id;
    assert.equal((await ctx.t.errorFrom(`select keep_show($1)`, [correction]))?.code, 'P0002');
  });

  it('refuses when the show is not explicitly ranked: there is nothing to keep', async () => {
    const { seasons } = await fixture();
    const s1 = await rank(seasons[0], 'loved', 50);
    const err = await ctx.t.errorFrom(`select keep_show($1)`, [s1.placement_id]);
    assert.equal(err?.code, 'P0002');
    assert.equal((await reaffirmations()).length, 0);
  });

  it('refuses a null placement and a signed-out caller', async () => {
    assert.equal((await ctx.t.errorFrom(`select keep_show(null)`))?.code, '22023');
    const { main, seasons } = await fixture();
    await rank(main, 'loved', 80);
    const s1 = await rank(seasons[0], 'loved', 50);
    const anon = await ctx.t.asAnon(() =>
      ctx.t.errorFrom(`select keep_show($1)`, [s1.placement_id]),
    );
    // Not granted to anon at all.
    assert.ok(anon, 'anon cannot call keep_show');
    await ctx.t.actAs(null);
    assert.equal((await ctx.t.errorFrom(`select keep_show($1)`, [s1.placement_id]))?.code, '28000');
    await ctx.t.actAs(ctx.user);
  });
});

describe('Update Show and Keep Show resolve one season placement once', () => {
  it('refuses Keep once a linked Update Show finalised from the placement', async () => {
    const { main, seasons } = await fixture();
    await rank(main, 'loved', 80);
    const s4 = await rank(seasons[3], 'loved', 50);
    await correct(main, 'loved', { linked: s4.placement_id });

    const err = await ctx.t.errorFrom(`select keep_show($1)`, [s4.placement_id]);
    assert.equal(err?.code, '23505');
    assert.equal((await reaffirmations()).length, 0);
  });

  it('refuses Keep while a linked Update Show from the placement is still open', async () => {
    const { main, seasons } = await fixture();
    await rank(main, 'loved', 80);
    const s4 = await rank(seasons[3], 'loved', 50);
    const step = await one(
      ctx.t.db,
      `select rank_again($1, 'loved', $2, false, null, $3) as r`,
      [main, await op(), s4.placement_id],
    );
    assert.equal(step.done, false, 'a comparison is open');

    const err = await ctx.t.errorFrom(`select keep_show($1)`, [s4.placement_id]);
    assert.equal(err?.code, '23505');

    // Abandoned: the session goes, and Keep is the reader's to choose again.
    await ctx.t.sql(`select rank_cancel($1)`, [step.session_id]);
    const kept = await keep(s4.placement_id);
    assert.equal(kept.created, true);
  });

  it('refuses a linked Update Show once the show was kept for that season', async () => {
    const { main, seasons } = await fixture();
    await rank(main, 'loved', 80);
    const s4 = await rank(seasons[3], 'loved', 50);
    const before = await positions('tv_shows');
    await keep(s4.placement_id);

    for (const sql of [
      `select rank_again($1, 'loved', $2, false, null, $3)`,
      `select rank_rebucket($1, 'fine', $2, $3)`,
    ]) {
      const err = await ctx.t.errorFrom(sql, [main, await op(), s4.placement_id]);
      assert.equal(err?.code, '23505', sql);
    }
    assert.deepEqual(await positions('tv_shows'), before);
    assert.equal((await posts(main)).length, 1);
  });

  it('still lets the show be corrected on its own, unlinked, after a Keep', async () => {
    const { main, seasons } = await fixture();
    await rank(main, 'loved', 80);
    const s4 = await rank(seasons[3], 'loved', 50);
    await keep(s4.placement_id);
    const placed = await correct(main, 'fine');
    assert.equal(placed.done, true);
  });
});

describe('who can read a reaffirmation', () => {
  it('is the owner, through RLS, and nobody else; nobody writes one directly', async () => {
    const { main, seasons } = await fixture();
    await rank(main, 'loved', 80);
    const s1 = await rank(seasons[0], 'loved', 50);
    await keep(s1.placement_id);

    const mine = await ctx.t.asUser(ctx.user, () =>
      ctx.t.sql(`select count(*)::int as n from show_reaffirmations`),
    );
    assert.equal(mine.rows[0].n, 1);

    const stranger = await ctx.t.createUser({ username: `keep_stranger_${ctx.seq}` });
    const theirs = await ctx.t.asUser(stranger, () =>
      ctx.t.sql(`select count(*)::int as n from show_reaffirmations`),
    );
    assert.equal(theirs.rows[0].n, 0);

    const insert = await ctx.t.asUser(ctx.user, () =>
      ctx.t.errorFrom(
        `insert into show_reaffirmations (user_id, show_id, season_placement_id, show_bucket, show_position, show_score)
         values ($1, $2, $3, 'loved', 1, 9.0)`,
        [ctx.user, main, s1.placement_id],
      ),
    );
    assert.ok(insert, 'no client insert');
    const remove = await ctx.t.asUser(ctx.user, () =>
      ctx.t.sql(`delete from show_reaffirmations returning id`).catch((e) => e),
    );
    assert.ok(remove instanceof Error || remove.rows.length === 0, 'no client delete');
    assert.equal((await reaffirmations()).length, 1);

    const anon = await ctx.t.asAnon(() =>
      ctx.t.sql(`select count(*)::int as n from show_reaffirmations`).catch((e) => e),
    );
    assert.ok(anon instanceof Error || anon.rows[0].n === 0);
  });

  it('goes with the season placement and the account', async () => {
    const { main, seasons } = await fixture();
    await rank(main, 'loved', 80);
    const s1 = await rank(seasons[0], 'loved', 50);
    await keep(s1.placement_id);
    await ctx.t.sql(`delete from profiles where id = $1`, [ctx.user]);
    const left = await ctx.t.sql(`select count(*)::int as n from show_reaffirmations where user_id = $1`, [
      ctx.user,
    ]);
    assert.equal(left.rows[0].n, 0);
  });
});
