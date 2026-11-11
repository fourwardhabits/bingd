import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb, one } from './harness.mjs';
import { tvRanking } from './tv-ranking-support.mjs';

/**
 * Update Show and the Feed contract for TV (20261114000300; founder brief §5-§6).
 *
 *   Rank a show / a season on its own          one ranking activity
 *   Update a show / a season on its own        one ranking-update activity (`update`)
 *   Rank a season, then Update Show            the season's activity only
 *   Abandon the linked Update Show             the season's activity remains, nothing else
 *   Movies                                     a correction stays silent
 *
 * The link is the season placement's id, carried on the session; nothing is published
 * and then deleted, and no timestamp decides anything.
 */
const ctx = { t: null, user: null, seq: 0 };
const {
  op,
  movie,
  series,
  taste,
  rank,
  correct,
  positions,
  posts,
  scoreOf,
  fixture,
} = tvRanking(ctx);

before(async () => {
  ctx.t = await createTestDb();
});

after(async () => {
  await ctx.t?.close();
});

beforeEach(async () => {
  ctx.seq += 1;
  ctx.user = await ctx.t.createUser({ username: `tvupd_${ctx.seq}` });
  await ctx.t.actAs(ctx.user);
});

describe('the Feed contract for TV', () => {
  it('posts a first show ranking and a first season ranking as ranking activities', async () => {
    const { main, seasons } = await fixture();
    await rank(main, 'loved', 80);
    await rank(seasons[0], 'loved', 50);
    const [show] = await posts(main);
    const [season] = await posts(seasons[0]);
    assert.equal(show.payload.category, 'tv_shows');
    assert.equal(show.payload.update, undefined);
    assert.equal(season.payload.category, 'tv_seasons');
  });

  it('posts a standalone show update that moved it, marked as an update', async () => {
    const { main } = await fixture();
    await rank(main, 'loved', 80);
    taste.set(main, 10);
    await correct(main, 'loved');
    const all = await posts(main);
    assert.equal(all.length, 2);
    assert.equal(all[1].payload.update, true);
    assert.equal(all[1].payload.category, 'tv_shows');
    assert.equal(Number(all[1].payload.score), Number(await scoreOf(main)));
  });

  it('posts a standalone season update the same way', async () => {
    const { seasons } = await fixture();
    await rank(seasons[0], 'loved', 80);
    await rank(seasons[1], 'loved', 70);
    await correct(seasons[1], 'fine');
    const all = await posts(seasons[1]);
    assert.equal(all.length, 2);
    assert.equal(all[1].payload.update, true);
    assert.equal(all[1].payload.category, 'tv_seasons');
  });

  it('posts nothing for an update that left the show where it was', async () => {
    const { main } = await fixture();
    await rank(main, 'loved', 80);
    await correct(main, 'loved');
    assert.equal((await posts(main)).length, 1);
  });

  it('leaves a movie correction silent, as it always was', async () => {
    const a = await movie('Heat');
    const b = await movie('Sicario');
    await rank(a, 'loved', 90);
    await rank(b, 'loved', 80);
    taste.set(b, 100);
    const moved = await correct(b, 'loved');
    assert.equal(moved.movement.outcome, 'moved');
    await correct(b, 'fine');
    assert.equal((await posts(b)).length, 1, 'the first ranking only');
  });

  it('keeps an update post at its own score when a later correction lands', async () => {
    const { main } = await fixture();
    await rank(main, 'loved', 80);
    taste.set(main, 10);
    await correct(main, 'loved');
    const [, update] = await posts(main);
    taste.set(main, 1000);
    await correct(main, 'loved');
    const after = (await posts(main)).find((p) => p.id === update.id);
    assert.equal(after.payload.score, update.payload.score);
  });
});

describe('Update Show, linked to the season that offered it', () => {
  const seasonPlacement = async (season) =>
    (
      await ctx.t.sql(
        `select id from ranking_placements where user_id = $1 and media_item_id = $2
          order by created_at desc limit 1`,
        [ctx.user, season],
      )
    ).rows[0].id;

  it("tells a season's completion whether its show is ranked, and in which band", async () => {
    const { main, seasons } = await fixture();
    const before = await rank(seasons[0], 'loved', 50);
    assert.deepEqual(before.parent, { media_item_id: main, ranked: false, bucket: null });
    await rank(main, 'fine', 40);
    const after = await rank(seasons[1], 'loved', 60);
    assert.deepEqual(after.parent, { media_item_id: main, ranked: true, bucket: 'fine' });
    assert.ok(after.placement_id);
    const film = await rank(await movie('No parent'), 'loved', 1);
    assert.equal(film.parent, null);
  });

  it('yields one season activity, and moves the show with no activity of its own', async () => {
    const { main, seasons } = await fixture();
    await rank(main, 'loved', 80);
    const s4 = await rank(seasons[3], 'loved', 50);
    taste.set(main, 10);

    const placed = await correct(main, 'loved', { linked: s4.placement_id });
    assert.equal(placed.movement.outcome, 'moved');
    assert.equal(placed.linked_placement_id, s4.placement_id);
    assert.equal((await posts(seasons[3])).length, 1, 'the season activity');
    assert.equal((await posts(main)).length, 1, 'the show keeps only its first ranking post');
    const ledger = await ctx.t.sql(
      `select kind, linked_placement_id from ranking_placements
        where user_id = $1 and media_item_id = $2 order by created_at desc limit 1`,
      [ctx.user, main],
    );
    assert.equal(ledger.rows[0].kind, 'correction');
    assert.equal(ledger.rows[0].linked_placement_id, s4.placement_id);
  });

  it('can change the show band from the season, still silently', async () => {
    const { main, seasons } = await fixture();
    await rank(main, 'loved', 80);
    const s5 = await rank(seasons[4], 'loved', 50);
    const placed = await correct(main, 'fine', { linked: s5.placement_id });
    assert.equal(placed.bucket, 'fine');
    assert.equal((await posts(main)).length, 1);
  });

  it('keeps the show where it was when Update Show is abandoned, and posts nothing', async () => {
    const { main, seasons } = await fixture();
    await rank(main, 'loved', 80);
    const s4 = await rank(seasons[3], 'loved', 50);
    const before = await positions('tv_shows');

    const step = await one(
      ctx.t.db,
      `select rank_again($1, 'loved', $2, false, null, $3) as r`,
      [main, await op(), s4.placement_id],
    );
    assert.equal(step.done, false);
    await ctx.t.sql(`select rank_cancel($1)`, [step.session_id]);

    assert.deepEqual(await positions('tv_shows'), before);
    assert.equal((await posts(main)).length, 1);
    assert.equal((await posts(seasons[3])).length, 1, 'the season activity remains');

    // And the link was not spent: the reader can still update the show from that season.
    taste.set(main, 10);
    const later = await correct(main, 'loved', { linked: s4.placement_id });
    assert.equal(later.done, true);
  });

  it('never duplicates on a retried linked completion, and refuses a second link', async () => {
    const { main, seasons } = await fixture();
    await rank(main, 'loved', 80);
    const s4 = await rank(seasons[3], 'loved', 50);
    taste.set(main, 10);
    await correct(main, 'loved', { linked: s4.placement_id });

    const again = await ctx.t.errorFrom(`select rank_again($1, 'loved', $2, false, null, $3)`, [
      main,
      await op(),
      s4.placement_id,
    ]);
    assert.equal(again?.code, '23505', 'the show was already updated in this linked workflow');
    assert.equal((await posts(main)).length, 1);
  });

  it('refuses a link that is not a fresh ranking of a season of this show', async () => {
    const { main, seasons } = await fixture();
    const other = await series('Another show');
    await rank(other, 'loved', 85);
    await rank(main, 'loved', 80);
    const s1 = await rank(seasons[0], 'loved', 50);

    const wrongShow = await ctx.t.errorFrom(
      `select rank_again($1, 'loved', $2, false, null, $3)`,
      [other, await op(), s1.placement_id],
    );
    assert.equal(wrongShow?.code, 'P0002');

    // A pure correction of the season is not a new watch, so it cannot link.
    taste.set(seasons[0], 1);
    await rank(seasons[1], 'loved', 60);
    await correct(seasons[0], 'loved');
    const correction = await seasonPlacement(seasons[0]);
    const notFresh = await ctx.t.errorFrom(
      `select rank_again($1, 'loved', $2, false, null, $3)`,
      [main, await op(), correction],
    );
    assert.equal(notFresh?.code, 'P0002');

    const asWatch = await ctx.t.errorFrom(
      `select rank_again($1, 'loved', $2, true, null, $3)`,
      [main, await op(), s1.placement_id],
    );
    assert.equal(asWatch?.code, '22023', 'Update Show records no watch');
  });

  it('refuses to link to a show that is not ranked', async () => {
    const { main, seasons } = await fixture();
    const s1 = await rank(seasons[0], 'loved', 50);
    const err = await ctx.t.errorFrom(`select rank_again($1, 'loved', $2, false, null, $3)`, [
      main,
      await op(),
      s1.placement_id,
    ]);
    assert.equal(err?.code, 'P0002');
    assert.equal(
      (await positions('tv_shows')).filter((r) => r.media_item_id === main).length,
      0,
    );
  });

  it("refuses another reader's season placement", async () => {
    const { main, seasons } = await fixture();
    await rank(main, 'loved', 80);
    const s1 = await rank(seasons[0], 'loved', 50);
    const mine = ctx.user;
    const other = await ctx.t.createUser({ username: `tvrank_other_${ctx.seq}` });
    await ctx.t.actAs(other);
    await rank(main, 'loved', 80);
    const err = await ctx.t.errorFrom(`select rank_again($1, 'loved', $2, false, null, $3)`, [
      main,
      await op(),
      s1.placement_id,
    ]);
    assert.equal(err?.code, 'P0002');
    await ctx.t.actAs(mine);
  });

  it('keeps an installed client calling the old argument lists working', async () => {
    const { main } = await fixture();
    await rank(main, 'loved', 80);
    const five = await one(ctx.t.db, `select rank_again($1, 'loved', $2, false, null) as r`, [
      main,
      await op(),
    ]);
    assert.ok(five);
    if (five.session_id) await ctx.t.sql(`select rank_cancel($1)`, [five.session_id]);
    const three = await one(ctx.t.db, `select rank_rebucket($1, 'fine', $2) as r`, [
      main,
      await op(),
    ]);
    assert.ok(three);
  });
});
