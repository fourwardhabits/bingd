import { strict as assert } from 'node:assert';

import { one } from './harness.mjs';

/**
 * Shared fixtures for the TV show & season ranking tests (20261114000100–000300):
 * `tv-show-ranking.test.mjs` (the category) and `tv-update-show.test.mjs` (Update Show and
 * the Feed contract). Not a test file itself: no `.test.` in the name.
 *
 * `ctx` is the test file's own `{ t, user, seq }`, read at call time so a `beforeEach` that
 * replaces the user is seen by every helper.
 */
export function tvRanking(ctx) {
  const op = async () => (await ctx.t.sql(`select gen_random_uuid() as id`)).rows[0].id;
  const movie = (title) => ctx.t.createMovie(title, (ctx.seq += 1) * 10 + 950000);
  const series = (title) => ctx.t.createSeries(title, (ctx.seq += 1) * 10 + 960000);

  /** The reader's secret order: a higher number wins every comparison it is in. */
  const taste = new Map();
  const prefer = (pivot, subject) =>
    (taste.get(subject) ?? 0) > (taste.get(pivot) ?? 0) ? subject : pivot;

  /** Answers comparisons from a step until it places. */
  const drive = async (step, subject, decide = prefer) => {
    let r = step;
    let guard = 0;
    while (!r.done) {
      assert.ok(r.session_id && r.pivot, `expected a comparison, got ${JSON.stringify(r)}`);
      r = await one(ctx.t.db, `select rank_answer($1, $2, $3) as r`, [
        r.session_id,
        await decide(r.pivot, subject),
        await op(),
      ]);
      guard += 1;
      if (guard > 64) throw new Error('did not converge');
    }
    return r;
  };

  const rank = async (item, bucket, score) => {
    taste.set(item, score);
    const start = await one(ctx.t.db, `select rank_start($1, $2::taste_bucket, $3) as r`, [
      item,
      bucket,
      await op(),
    ]);
    return drive(start, item);
  };

  /**
   * A correction, through the call the band chooser makes: `rank_again` for the band the
   * title already has, `rank_rebucket` for another. Without a link it sends the argument
   * lists an installed client sends (and the only ones a backend before 20261114000300
   * has); with one, the Update Show form.
   */
  const correct = async (item, bucket, { linked = null, opId = null } = {}) => {
    const current = (
      await ctx.t.sql(`select bucket from rankings where user_id = $1 and media_item_id = $2`, [
        ctx.user,
        item,
      ])
    ).rows[0]?.bucket;
    const id = opId ?? (await op());
    const same = current === bucket;
    const sql = linked
      ? same
        ? `select rank_again($1, $2::taste_bucket, $3, false, null, $4) as r`
        : `select rank_rebucket($1, $2::taste_bucket, $3, $4) as r`
      : same
        ? `select rank_again($1, $2::taste_bucket, $3, false, null) as r`
        : `select rank_rebucket($1, $2::taste_bucket, $3) as r`;
    const start = await one(
      ctx.t.db,
      sql,
      linked ? [item, bucket, id, linked] : [item, bucket, id],
    );
    return drive(start, item);
  };

  const positions = async (category) =>
    (
      await ctx.t.sql(
        `select media_item_id, position, bucket from rankings
          where user_id = $1 and category = $2::ranking_category order by position`,
        [ctx.user, category],
      )
    ).rows;

  const posts = async (item) =>
    (
      await ctx.t.sql(
        `select id, payload from feed_events
          where actor_id = $1 and media_item_id = $2 and type = 'title_ranked'
          order by created_at, id`,
        [ctx.user, item],
      )
    ).rows;

  const scoreOf = async (item) =>
    (
      await ctx.t.sql(`select score from public_scores($1::uuid[], $2::uuid[])`, [
        [ctx.user],
        [item],
      ])
    ).rows[0]?.score;

  /** A show with five seasons, and three ranked shows around it. */
  const fixture = async () => {
    const shows = [];
    for (const [name, score] of [
      ['Show A', 90],
      ['Show B', 70],
      ['Show C', 50],
    ]) {
      const id = await series(name);
      await rank(id, 'loved', score);
      shows.push(id);
    }
    const main = await series('Shameless');
    const seasons = [];
    for (let n = 1; n <= 5; n += 1)
      seasons.push(await ctx.t.createSeason(main, n, `Season ${n}`));
    return { shows, main, seasons };
  };

  return {
    op,
    movie,
    series,
    taste,
    prefer,
    drive,
    rank,
    correct,
    positions,
    posts,
    scoreOf,
    fixture,
  };
}
