import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { raceContext } from './_shared.mjs';

/**
 * Release awareness under independent connections: 20260930000100 / 20260930000200.
 *
 * ---------------------------------------------------------------------------
 * THE TWO RACES
 *
 * **Two reads of one subject at once.** The scheduled refresh and a reader opening the
 * title page both hand a fresh TMDB read to `release_observe`. On a release day both can
 * find the season's event missing (first sight) or scheduled, and without serialisation
 * both would try to create it, or both would log a `released`. `release_observe` takes
 * `pg_advisory_xact_lock('release-subject:' || id)` before it reads anything.
 *
 * **Two evaluation ticks at once** (a slow tick overlapping the next). Each selects the
 * pending events `for update skip locked`, and the ledger's unique (user, event) key is
 * the dedupe of last resort. However they land: one row per account per event, and no
 * error on either connection.
 *
 * THE INVARIANTS
 *
 * **RA1.** The second observation is OBSERVED waiting on the subject's named key; after
 * both commit there is one event and exactly one `released` log row.
 * **RA2.** Two bare concurrent observations of the same release: same outcome.
 * **RA3.** Two bare concurrent evaluations: one ledger row per account, both succeed.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('release awareness races', () => {
    before(() => rc.open());
    after(() => rc.close());

    const NOW = '2031-05-16T08:00:00Z';

    const observation = (seriesId) =>
      JSON.stringify({
        media_item_id: seriesId,
        kind: 'series',
        status: 'Returning Series',
        read_at: NOW,
        seasons: [
          { season_number: 1, air_date: '2030-01-01' },
          { season_number: 2, air_date: '2031-05-16' },
        ],
      });

    const observeSql = `select release_observe($1::jsonb, $2::timestamptz) as r`;

    const subjectKey = async (seriesId) => {
      const [row] = await ctx.db.rows(
        `select hashtextextended('release-subject:' || $1::text, 0)::text as k`,
        [seriesId],
      );
      return row.k;
    };

    /** A tracked series, one caught-up viewer per `viewers`, Season 2 not yet observed. */
    const fixture = async (viewers = 1) => {
      const { db, fx } = ctx;
      const show = await fx.createSeries();
      const s1 = await fx.createSeason(show, 1, '2030-01-01');
      const s2 = await fx.createSeason(show, 2, null);
      const who = [];
      for (let i = 0; i < viewers; i += 1) {
        const u = await fx.createUser();
        await db.sql(`insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`, [u, s1]);
        await db.sql(`insert into account_context (user_id, timezone, region) values ($1, 'UTC', 'US')`, [u]);
        who.push(u);
      }
      await db.sql(
        `insert into release_subjects (media_item_id, subject_kind, next_check_at) values ($1, 'series', $2)`,
        [show, NOW],
      );
      return { show, s2, who };
    };

    const releasedLogs = async (seasonId) =>
      (
        await ctx.db.rows(
          `select l.change from release_event_log l join release_events e on e.id = l.release_event_id
            where e.media_item_id = $1 and l.change in ('released', 'released_stale')`,
          [seasonId],
        )
      ).length;

    it('RA1: the second read of a subject waits on its key, and the release is logged once', async () => {
      const { db } = ctx;
      const { show, s2 } = await fixture();
      const t1 = await db.session('refresh');
      const t2 = await db.session('detail');
      try {
        await t1.begin();
        await t1.one(observeSql, [observation(show), NOW]);

        await t2.begin();
        const p2 = t2.start(observeSql, [observation(show), NOW]);
        /**
         * Remove the advisory lock from release_observe and this throws: t2 would instead
         * block on the event row's unique index (or, for an existing row, on FOR UPDATE),
         * which is not the named key, and on a missing row would fail with a duplicate.
         */
        await t2.awaitBlocked({ on: 'advisory', advisoryKey: await subjectKey(show) });

        await t1.commit();
        const second = await p2;
        await t2.commit();
        assert.deepEqual(second.rows[0].r.changes, { unchanged: 2 }, 'the second read learned nothing new');
      } finally {
        await t1.rollback().catch(() => {});
        await t2.rollback().catch(() => {});
        await t1.end().catch(() => {});
        await t2.end().catch(() => {});
      }

      const events = await db.rows(`select state from release_events where media_item_id = $1`, [s2]);
      assert.deepEqual(events.map((e) => e.state), ['released']);
      assert.equal(await releasedLogs(s2), 1, 'RA1: one release, logged once');
    });

    it('RA2: two bare concurrent reads of the same release create one event and one release', async () => {
      const { db } = ctx;
      const { show, s2 } = await fixture();
      const a = await db.session('a');
      const b = await db.session('b');
      try {
        await Promise.all([a.one(observeSql, [observation(show), NOW]), b.one(observeSql, [observation(show), NOW])]);
      } finally {
        await a.end().catch(() => {});
        await b.end().catch(() => {});
      }
      assert.equal((await db.rows(`select 1 from release_events where media_item_id = $1`, [s2])).length, 1);
      assert.equal(await releasedLogs(s2), 1, 'RA2');
    });

    it('RA3: two concurrent evaluation ticks write one ledger row per account, and neither fails', async () => {
      const { db } = ctx;
      const { show, s2, who } = await fixture(5);
      await db.sql(observeSql, [observation(show), NOW]);

      const a = await db.session('tick-a');
      const b = await db.session('tick-b');
      try {
        await Promise.all([
          a.one(`select _release_evaluate($1::timestamptz) as r`, ['2031-05-16T08:05:00Z']),
          b.one(`select _release_evaluate($1::timestamptz) as r`, ['2031-05-16T08:05:00Z']),
        ]);
      } finally {
        await a.end().catch(() => {});
        await b.end().catch(() => {});
      }

      const rows = await db.rows(
        `select l.user_id from release_shadow_ledger l join release_events e on e.id = l.release_event_id
          where e.media_item_id = $1`,
        [s2],
      );
      assert.equal(rows.length, who.length, 'RA3: one row per account');
      assert.equal(new Set(rows.map((r) => r.user_id)).size, who.length);
      const [{ n }] = await db.rows(
        `select count(*)::int n from notifications where type in ('season_premiere', 'theatrical_release')`,
      );
      assert.equal(n, 0, 'and still nothing sent');
    });
  });
}
