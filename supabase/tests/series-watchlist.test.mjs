import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { createTestDb, createTestDbBefore } from './harness.mjs';

const MIGRATION = '20260906000100_a_series_you_have_finished_leaves.sql';

/**
 * The series watchlist invariant (20260906000100).
 *
 * "A series stays on the watchlist while a currently released normal season remains
 * unmet. Once every currently released normal season is met, the series leaves."
 *
 * The exact-object rule of 20260815040000 is untouched and is still tested in
 * watchlist-invariant.test.mjs; this file is about the parent. What is worth testing
 * is where the refined rule could quietly be wrong:
 *
 *   - removing a series while a released normal season is genuinely unmet, which
 *     deletes an intention that is still true,
 *   - removing on vacuous truth: a series whose seasons were never hydrated, or whose
 *     only known seasons are undated, future, or specials, has not been finished,
 *   - letting Season 0 block a removal, or letting an undated or future season block
 *     one (founder decisions 3 and 4),
 *   - re-adding the series on unrank or unlog, which the founder ruled out,
 *   - disagreeing with 20260815040000 about what "watched" means.
 */
describe('series watchlist invariant', () => {
  let t;
  let user;
  let fixtureSeq = 5000;

  before(async () => {
    t = await createTestDb();
    user = await t.createUser({ username: 'finisher' });
    await t.actAs(user);
  });

  after(async () => t.close());

  const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

  const call = async (sql, params) => {
    const { rows } = await t.sql(`select ${sql} as result`, params);
    return rows[0].result;
  };

  const watchlisted = async (mediaItemId, forUser = user) => {
    const { rows } = await t.sql(
      `select 1 from watchlist where user_id = $1 and media_item_id = $2`,
      [forUser, mediaItemId],
    );
    return rows.length === 1;
  };

  const addToWatchlist = async (mediaItemId) =>
    call(`set_watchlist($1, $2, true)`, [await uuid(), mediaItemId]);

  /**
   * A season with a stated release date, because the rule is about release dates and
   * the shared harness deliberately leaves the column null. `release: null` is a
   * season the catalogue has not dated; a past or future ISO date says the rest.
   */
  const season = async (seriesId, number, release) => {
    const id = await t.createSeason(seriesId, number, `Season ${number}`);
    if (release !== null) {
      await t.sql(`update media_items set release_date = $2 where id = $1`, [id, release]);
    }
    return id;
  };

  const series = async (title) => t.createSeries(title, (fixtureSeq += 1));

  const RELEASED = '2020-01-01';
  const FUTURE = '2099-01-01';

  describe('the terminating rule', () => {
    it('a single released season: ranking it removes the series', async () => {
      const show = await series('One and Done');
      const s1 = await season(show, 1, RELEASED);
      await addToWatchlist(show);

      await t.rankToCompletion(s1, 'loved', () => s1);

      assert.equal(await watchlisted(show), false, 'nothing left to intend');
    });

    it('five released seasons: the series survives four and leaves on the fifth', async () => {
      const show = await series('The Long Haul');
      const seasons = [];
      for (let n = 1; n <= 5; n += 1) seasons.push(await season(show, n, RELEASED));
      await addToWatchlist(show);

      for (const s of seasons.slice(0, 4)) {
        await call(`set_bucket($1, $2, 'loved')`, [await uuid(), s]);
        assert.equal(
          await watchlisted(show),
          true,
          'a released season is still unmet, so the intention is still true',
        );
      }

      await call(`set_bucket($1, $2, 'loved')`, [await uuid(), seasons[4]]);

      assert.equal(await watchlisted(show), false, 'the final released season was the last');
    });

    it('a future season does not block: ranking released S1 removes the series', async () => {
      const show = await series('Renewed Already');
      const s1 = await season(show, 1, RELEASED);
      await season(show, 2, FUTURE);
      await addToWatchlist(show);

      await call(`set_bucket($1, $2, 'loved')`, [await uuid(), s1]);

      assert.equal(
        await watchlisted(show),
        false,
        'everything there is to watch today has been watched',
      );
    });

    it('an undated season does not block: ranking released S1 removes the series', async () => {
      const show = await series('Announced, No Air Date');
      const s1 = await season(show, 1, RELEASED);
      await season(show, 2, null);
      await addToWatchlist(show);

      await call(`set_bucket($1, $2, 'loved')`, [await uuid(), s1]);

      assert.equal(await watchlisted(show), false, 'founder decision 4');
    });

    it('an unwatched Season 0 does not block once the normal seasons are met', async () => {
      const show = await series('Has Specials');
      await season(show, 0, RELEASED);
      const s1 = await season(show, 1, RELEASED);
      await addToWatchlist(show);

      await call(`set_bucket($1, $2, 'loved')`, [await uuid(), s1]);

      assert.equal(await watchlisted(show), false, 'specials are outside the rule');
    });

    it('watching only Season 0 removes nothing', async () => {
      const show = await series('Specials First');
      const s0 = await season(show, 0, RELEASED);
      await season(show, 1, RELEASED);
      await addToWatchlist(show);

      await call(`set_bucket($1, $2, 'loved')`, [await uuid(), s0]);

      assert.equal(await watchlisted(show), true, 'Season 1 is released and unmet');
    });

    it('a completed but unranked season counts as met, same as 20260815040000', async () => {
      const show = await series('Completed Counts');
      const s1 = await season(show, 1, RELEASED);
      await addToWatchlist(show);

      await call(`set_season_progress($1, $2, 'completed')`, [await uuid(), s1]);

      assert.equal(await watchlisted(show), false);
    });

    it('a season merely in progress does not count as met', async () => {
      const show = await series('Still Going');
      const s1 = await season(show, 1, RELEASED);
      await addToWatchlist(show);

      await call(`set_season_progress($1, $2, 'watching')`, [await uuid(), s1]);

      assert.equal(
        await watchlisted(show),
        true,
        'watching is the state a watchlist entry describes, not the one that ends it',
      );
    });
  });

  describe('the vacuous-truth guard', () => {
    it('a series whose only known normal season is undated is never removed', async () => {
      const show = await series('Not Yet Hydrated');
      const s1 = await season(show, 1, null);
      await addToWatchlist(show);

      // The user logs the undated season itself. Every released normal season being
      // met is vacuously true here, and the guard is what keeps the series.
      await call(`set_bucket($1, $2, 'loved')`, [await uuid(), s1]);

      assert.equal(
        await watchlisted(show),
        true,
        'no released normal season exists in the catalogue, so nothing was finished',
      );
    });
  });

  describe('object separation with 20260815040000', () => {
    it('a watchlisted season leaves alone when its series is not on the watchlist', async () => {
      const show = await series('Season Only');
      const s1 = await season(show, 1, RELEASED);
      await addToWatchlist(s1);

      await call(`set_bucket($1, $2, 'loved')`, [await uuid(), s1]);

      assert.equal(await watchlisted(s1), false, 'the exact-object rule still holds');
      assert.equal(await watchlisted(show), false, 'and the series was never there');
    });

    it('series and season both watchlisted: each leaves under its own rule', async () => {
      const show = await series('Both Listed');
      const s1 = await season(show, 1, RELEASED);
      const s2 = await season(show, 2, RELEASED);
      await addToWatchlist(show);
      await addToWatchlist(s2);

      await call(`set_bucket($1, $2, 'loved')`, [await uuid(), s2]);

      assert.equal(await watchlisted(s2), false, 'the season leaves as the exact object');
      assert.equal(await watchlisted(show), true, 'Season 1 is released and unmet');

      await call(`set_bucket($1, $2, 'loved')`, [await uuid(), s1]);

      assert.equal(await watchlisted(show), false, 'the final released season is met');
    });

    it('a movie watch is a safe no-op for the series rule', async () => {
      const show = await series('Bystander Show');
      await season(show, 1, RELEASED);
      const film = await t.createMovie('Unrelated Film', (fixtureSeq += 1));
      await addToWatchlist(show);

      await call(`set_bucket($1, $2, 'loved')`, [await uuid(), film]);

      assert.equal(await watchlisted(show), true, 'a movie has no parent to finish');
    });
  });

  describe('is one-directional', () => {
    it('unranking a season does not re-add the series', async () => {
      const show = await series('No Take Backs');
      const s1 = await season(show, 1, RELEASED);
      await addToWatchlist(show);

      await t.rankToCompletion(s1, 'loved', () => s1);
      assert.equal(await watchlisted(show), false);

      await call(`rank_unrank($1, $2)`, [s1, await uuid()]);

      assert.equal(await watchlisted(show), false, 'founder decision 6');
    });

    it('unlogging a season does not re-add the series', async () => {
      const show = await series('Still Gone');
      const s1 = await season(show, 1, RELEASED);
      await addToWatchlist(show);

      await call(`set_bucket($1, $2, 'loved')`, [await uuid(), s1]);
      assert.equal(await watchlisted(show), false);

      await call(`unlog($1, $2)`, [await uuid(), s1]);

      assert.equal(await watchlisted(show), false, 'the user re-adds it by hand');
    });

    it('a finished series deliberately re-added survives non-watch writes', async () => {
      const show = await series('The Rewatch');
      const s1 = await season(show, 1, RELEASED);
      await addToWatchlist(show);

      await call(`set_bucket($1, $2, 'loved')`, [await uuid(), s1]);
      assert.equal(await watchlisted(show), false);

      // The rewatch: a later, explicit intention over older watch signals.
      await addToWatchlist(show);

      // Neither a note nor progress=watching is a watch transition, so neither
      // re-evaluates the series.
      await call(`log_watched($1, $2, null, 'rewatching this with friends')`, [
        await uuid(),
        s1,
      ]);
      await call(`set_season_progress($1, $2, 'watching')`, [await uuid(), s1]);

      assert.equal(
        await watchlisted(show),
        true,
        'the re-add is newer than every watch signal on the seasons',
      );
    });
  });

  describe('scope', () => {
    it('one account finishing a show leaves another account holding it', async () => {
      const other = await t.createUser({ username: 'other_finisher' });
      const show = await series('Shared Show');
      const s1 = await season(show, 1, RELEASED);

      await addToWatchlist(show);
      await t.actAs(other);
      await call(`set_watchlist($1, $2, true)`, [await uuid(), show]);
      await call(`set_bucket($1, $2, 'loved')`, [await uuid(), s1]);
      await t.actAs(user);

      assert.equal(await watchlisted(show, other), false, 'they finished it');
      assert.equal(await watchlisted(show), true, 'we did not');
    });
  });

  describe('the trigger function is not callable by a client', () => {
    it('has no execute grant', async () => {
      const { rows } = await t.sql(`
        select has_function_privilege('authenticated', '_leave_series_watchlist()', 'execute') as granted`);
      assert.equal(rows[0].granted, false);
    });
  });
});

/**
 * The backfill, tested at the migration boundary, for the reason the 20260815040000
 * suite records: in the ordinary harness every migration has already run against an
 * empty database, so the `do` block deleted nothing and any assertion afterwards is
 * really measuring the triggers. Here the stranded state is constructed first: series
 * entries the old exact-object rule correctly left standing, with every released
 * season already met.
 */
describe('series watchlist invariant — historical backfill', () => {
  let t;
  let user;
  let other;
  const shows = {};

  const RELEASED = '2020-01-01';
  const FUTURE = '2099-01-01';

  before(async () => {
    t = await createTestDbBefore(MIGRATION);
    user = await t.createUser({ username: 'stranded' });
    other = await t.createUser({ username: 'unstranded' });

    let seq = 6000;
    const makeShow = async (title, seasonSpecs) => {
      const id = await t.createSeries(title, (seq += 1));
      const seasons = [];
      for (const { n, release } of seasonSpecs) {
        const sid = await t.createSeason(id, n, `Season ${n}`);
        if (release !== null) {
          await t.sql(`update media_items set release_date = $2 where id = $1`, [sid, release]);
        }
        seasons.push(sid);
      }
      return { id, seasons };
    };

    const meet = async (forUser, seasonId, how = 'bucket') => {
      if (how === 'ranked') {
        await t.sql(
          `insert into rankings (user_id, media_item_id, category, bucket, position)
           values ($1, $2, 'tv_seasons', 'loved',
                   coalesce((select max(position) + 1 from rankings
                              where user_id = $1 and category = 'tv_seasons'), 1))`,
          [forUser, seasonId],
        );
      } else {
        await t.sql(
          `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`,
          [forUser, seasonId],
        );
      }
    };

    // Finished: two released seasons, one bucketed and one ranked. Stuck under the
    // old rule, removed by the backfill.
    shows.finished = await makeShow('Finished Long Ago', [
      { n: 1, release: RELEASED },
      { n: 2, release: RELEASED },
    ]);
    await meet(user, shows.finished.seasons[0], 'bucket');
    await meet(user, shows.finished.seasons[1], 'ranked');

    // Half watched: S2 is released and unmet. Kept.
    shows.halfWatched = await makeShow('Half Watched', [
      { n: 1, release: RELEASED },
      { n: 2, release: RELEASED },
    ]);
    await meet(user, shows.halfWatched.seasons[0]);

    // Caught up: S1 met, S2 is announced for the future. Removed.
    shows.caughtUp = await makeShow('Caught Up', [
      { n: 1, release: RELEASED },
      { n: 2, release: FUTURE },
    ]);
    await meet(user, shows.caughtUp.seasons[0]);

    // Specials remain: S0 unwatched, S1 met. Removed, because specials never block.
    shows.specialsLeft = await makeShow('Specials Left', [
      { n: 0, release: RELEASED },
      { n: 1, release: RELEASED },
    ]);
    await meet(user, shows.specialsLeft.seasons[1]);

    // Unhydrated: on the watchlist with no season rows at all. Kept, always.
    shows.unhydrated = await makeShow('Never Hydrated', []);

    // Undated only: the catalogue knows one normal season and cannot date it, and the
    // user has even watched it. Vacuous truth for released seasons; kept.
    shows.undatedOnly = await makeShow('Undated Only', [{ n: 1, release: null }]);
    await meet(user, shows.undatedOnly.seasons[0]);

    // In progress: the only released season is watching, not completed. Kept.
    shows.inProgress = await makeShow('In Progress', [{ n: 1, release: RELEASED }]);
    await t.sql(
      `insert into user_media (user_id, media_item_id, progress) values ($1, $2, 'watching')`,
      [user, shows.inProgress.seasons[0]],
    );

    for (const { id } of Object.values(shows)) {
      await t.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [user, id]);
    }

    // The other account holds the finished show too, but has watched nothing.
    await t.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [
      other,
      shows.finished.id,
    ]);

    // A movie on the watchlist, watched, sitting beside the series rows: the backfill
    // must not touch it, watched or not, because this file's rule is about series.
    // The watch signal is written FIRST: the exact-object triggers are live at this
    // boundary, and a bucket landing on a watchlisted movie would remove the row in
    // setup. Watched-then-re-added is the deliberate rewatch state, which is exactly
    // the row this backfill must leave alone.
    shows.movie = { id: await t.createMovie('A Watched Movie', 6999) };
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`,
      [user, shows.movie.id],
    );
    await t.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [
      user,
      shows.movie.id,
    ]);

    await t.applyMigration(MIGRATION);
  });

  after(async () => t.close());

  const survives = async (id, forUser = user) =>
    (
      await t.sql(`select 1 from watchlist where user_id = $1 and media_item_id = $2`, [
        forUser,
        id,
      ])
    ).rows.length === 1;

  it('removes a series whose released seasons are all met', async () => {
    assert.equal(await survives(shows.finished.id), false);
  });

  it('keeps a series with a released season still unmet', async () => {
    assert.equal(await survives(shows.halfWatched.id), true);
  });

  it('removes a series whose only outstanding season is in the future', async () => {
    assert.equal(await survives(shows.caughtUp.id), false);
  });

  it('removes a series where only Season 0 remains unwatched', async () => {
    assert.equal(await survives(shows.specialsLeft.id), false);
  });

  it('keeps a series with no season rows in the catalogue', async () => {
    assert.equal(await survives(shows.unhydrated.id), true);
  });

  it('keeps a series whose only known season is undated, even watched', async () => {
    assert.equal(await survives(shows.undatedOnly.id), true);
  });

  it('keeps a series whose only released season is merely in progress', async () => {
    assert.equal(await survives(shows.inProgress.id), true);
  });

  it('keeps the other account’s entry for the show one account finished', async () => {
    assert.equal(await survives(shows.finished.id, other), true);
  });

  it('does not touch a movie row, watched or not', async () => {
    assert.equal(await survives(shows.movie.id), true);
  });

  it('is idempotent: re-running the migration removes nothing further', async () => {
    const count = async () =>
      (await t.sql(`select count(*)::int as n from watchlist`)).rows[0].n;

    const before = await count();
    await t.applyMigration(MIGRATION);

    assert.equal(await count(), before);
  });
});
