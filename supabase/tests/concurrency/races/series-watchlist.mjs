import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { raceContext } from './_shared.mjs';

/**
 * The series watchlist rule, under independent connections — `20260906000100`.
 *
 * ---------------------------------------------------------------------------
 * THE RACE THE LOCK EXISTS FOR
 *
 * Two devices complete the final two released seasons of one series at the same
 * time. Each trigger asks "does any released normal season remain unmet?", and
 * under READ COMMITTED neither transaction sees the other's uncommitted row —
 * so each finds the *other* season unmet, neither removes the series, both
 * commit, and the entry is stranded forever with nothing left to fire for it.
 * That is the lost-crossing shape of 20260829000200's goal completion, pointed
 * at a delete instead of an insert, and it is invisible to
 * `series-watchlist.test.mjs` because PGlite is one connection.
 *
 * The fix is the same: `pg_advisory_xact_lock` per (user, series), taken
 * before counting. The second transaction waits for the first to commit, its
 * count runs under a fresh snapshot, and it sees every met season.
 *
 * THE INVARIANTS
 *
 * **SW1. The second completion is OBSERVED waiting on the named key, and the
 * series is removed.** Named, not just "an advisory lock", so this proves
 * `_leave_series_watchlist` serialised the pair rather than something else
 * having done so — and so that deleting the lock turns this red via
 * `awaitBlocked` instead of passing on a lucky interleaving.
 *
 * **SW2. Two bare concurrent completions of the final two seasons** leave the
 * series absent however the scheduler lands them.
 *
 * **SW3. Concurrency never removes early.** Two seasons of a three-season
 * series completing together must leave the series standing, because the third
 * is still unmet in every snapshot either transaction can take.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('series watchlist races', () => {
    before(() => rc.open());
    after(() => rc.close());

    const bucketSql = `insert into user_media (user_id, media_item_id, bucket)
                       values ($1, $2, 'loved')
                       on conflict (user_id, media_item_id)
                         do update set bucket = excluded.bucket`;

    /** The advisory key `_leave_series_watchlist` takes, computed the same way. */
    const seriesKey = async (who, seriesId) => {
      const [row] = await ctx.db.rows(
        `select hashtextextended('series-watchlist:' || $1::text || ':' || $2::text, 0)::text as k`,
        [who, seriesId],
      );
      return row.k;
    };

    const onWatchlist = async (who, seriesId) =>
      (
        await ctx.db.rows(
          `select 1 from watchlist where user_id = $1 and media_item_id = $2`,
          [who, seriesId],
        )
      ).length === 1;

    const fixture = async (seasonCount) => {
      const { db, fx } = ctx;
      const who = await fx.createUser();
      const show = await fx.createSeries();
      const seasons = [];
      for (let n = 1; n <= seasonCount; n += 1) seasons.push(await fx.createSeason(show, n));
      await db.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [
        who,
        show,
      ]);
      return { who, show, seasons };
    };

    it('SW1: the second season’s completion waits on the series key, then removes the entry', async () => {
      const { db } = ctx;
      const { who, show, seasons } = await fixture(2);

      const t1 = await db.session('phone');
      const t2 = await db.session('tablet');

      try {
        // t1 completes Season 1 and stays open. Its trigger found Season 2 unmet, so
        // it removed nothing — but it holds the series lock until commit.
        await t1.begin();
        await t1.one(`${bucketSql} returning user_id`, [who, seasons[0]]);

        // t2 completes Season 2 and must stop on the same key.
        await t2.begin();
        const p2 = t2.start(bucketSql, [who, seasons[1]]);
        /**
         * The observation that carries the suite. Remove the advisory lock from
         * `_leave_series_watchlist` and t2 never blocks: `awaitBlocked` throws here
         * instead of the test passing on whichever interleaving happened to occur —
         * which is exactly how the stranded-entry defect would present.
         */
        await t2.awaitBlocked({ on: 'advisory', advisoryKey: await seriesKey(who, show) });

        await t1.commit();
        await p2;
        await t2.commit();
      } finally {
        await t1.rollback().catch(() => {});
        await t2.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }

      assert.equal(
        await onWatchlist(who, show),
        false,
        'SW1: the removal was not lost between two connections',
      );
    });

    it('SW2: two bare concurrent completions of the final two seasons remove the series', async () => {
      const { db } = ctx;
      const { who, show, seasons } = await fixture(2);

      const t1 = await db.session('a');
      const t2 = await db.session('b');
      try {
        await Promise.all([
          t1.one(`${bucketSql} returning user_id`, [who, seasons[0]]),
          t2.one(`${bucketSql} returning user_id`, [who, seasons[1]]),
        ]);
      } finally {
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }

      assert.equal(
        await onWatchlist(who, show),
        false,
        'SW2: however the scheduler lands them, the finished series leaves',
      );
    });

    it('SW3: concurrent completions with a third season unmet never remove early', async () => {
      const { db } = ctx;
      const { who, show, seasons } = await fixture(3);

      const t1 = await db.session('a3');
      const t2 = await db.session('b3');
      try {
        await Promise.all([
          t1.one(`${bucketSql} returning user_id`, [who, seasons[0]]),
          t2.one(`${bucketSql} returning user_id`, [who, seasons[1]]),
        ]);
      } finally {
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }

      assert.equal(
        await onWatchlist(who, show),
        true,
        'SW3: Season 3 is released and unmet in every snapshot, so the intention holds',
      );
    });
  });
}
