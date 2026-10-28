import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { raceContext } from './_shared.mjs';

/**
 * Proactive notifications under independent connections: 20261028000100 / 20261028000200.
 *
 * ---------------------------------------------------------------------------
 * THE THREE RACES
 *
 * **Two arbiter ticks at once** (a slow tick overlapping the next). Each takes
 * `pg_advisory_xact_lock('bingd.proactive:' || recipient)` before reading the reader's
 * budget, so the second sees the first one's selection in its count. Behind that, the
 * partial unique index on (recipient, selected_local_date) makes a second push on the
 * same local day impossible rather than unlikely.
 *
 * **Two friends finishing the same film at the same moment.** Both rankings fire the
 * feed_events trigger and both reach `_proactive_social_add` for the same reader and
 * title. The per-(reader, title) advisory lock makes the second find the first's
 * cluster and join it, instead of opening a second inbox row.
 *
 * **Two senders claiming at once.** claim_push_batch is `for update skip locked`, so a
 * proactive job goes to exactly one of them.
 *
 * THE INVARIANTS
 *
 * **PA1.** Two concurrent arbiters, one reader with two eligible candidates: exactly one
 * selected, one outbox row, neither connection fails.
 * **PA2.** Two concurrent qualifying activities: one cluster, one inbox row, two members,
 * and the candidate eligible.
 * **PA3.** Two concurrent claims: the proactive job is returned once.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('proactive notification races', () => {
    before(async () => {
      await rc.open();
      // Both switches ship off; these races are about what happens once they are on.
      await ctx.db.sql(
        `insert into app_config (key, value) values
           ('proactive.push_enabled', 'true'::jsonb),
           ('proactive.generation_enabled', 'true'::jsonb)
         on conflict (key) do update set value = excluded.value`,
      );
    });
    after(() => rc.close());

    const EVENING = '2031-03-03T17:30:00Z';

    const friends = async (a, b) => {
      await ctx.db.sql(
        `insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved'), ($2, $1, 'approved')`,
        [a, b],
      );
    };

    /** A reader in UTC with one device from a capable build, who has `m` saved. */
    const reader = async (m) => {
      const { db, fx } = ctx;
      const r = await fx.createUser();
      await db.sql(`insert into account_context (user_id, timezone, region) values ($1, 'UTC', 'US')`, [r]);
      await db.sql(
        `insert into device_tokens (user_id, token, platform, proactive_version) values ($1, $2, 'ios', 1)`,
        [r, `ExponentPushToken[${r}]`],
      );
      await db.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [r, m]);
      return r;
    };

    /** An eligible two-friend cluster for (r, m), built with the clock in 2031. */
    const eligibleCluster = async (r, m) => {
      const { db, fx } = ctx;
      await db.sql(`update app_config set value = 'false'::jsonb where key = 'proactive.generation_enabled'`);
      try {
        for (let i = 0; i < 2; i += 1) {
          const f = await fx.createUser();
          await friends(r, f);
          const [ev] = await db.rows(
            `insert into feed_events (actor_id, type, media_item_id) values ($1, 'title_ranked', $2) returning id`,
            [f, m],
          );
          await db.sql(`select _proactive_social_add($1, $2, $3, $4, '2031-03-03T09:00:00Z')`, [r, f, m, ev.id]);
        }
      } finally {
        await db.sql(`update app_config set value = 'true'::jsonb where key = 'proactive.generation_enabled'`);
      }
    };

    it('PA1: two concurrent arbiters select one push for one reader, and neither fails', async () => {
      const { db, fx } = ctx;
      const a = await fx.createMovie('PA1 a');
      const b = await fx.createMovie('PA1 b');
      const r = await reader(a);
      await db.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [r, b]);
      await eligibleCluster(r, a);
      await eligibleCluster(r, b);

      const s1 = await db.session('arbiter-1');
      const s2 = await db.session('arbiter-2');
      try {
        await Promise.all([
          s1.one(`select _proactive_arbitrate($1::timestamptz) as r`, [EVENING]),
          s2.one(`select _proactive_arbitrate($1::timestamptz) as r`, [EVENING]),
        ]);
      } finally {
        await s1.end().catch(() => {});
        await s2.end().catch(() => {});
      }

      const states = await db.rows(
        `select state from proactive_candidates where recipient_id = $1 order by state`,
        [r],
      );
      assert.deepEqual(states.map((s) => s.state), ['pending', 'selected'], 'PA1: one selected');
      const outbox = await db.rows(`select 1 from push_outbox where recipient_id = $1`, [r]);
      assert.equal(outbox.length, 1, 'PA1: one push queued');
    });

    it('PA2: two friends finishing the same title at once join one cluster', async () => {
      const { db, fx } = ctx;
      const m = await fx.createMovie('PA2');
      const r = await reader(m);
      const f1 = await fx.createUser();
      const f2 = await fx.createUser();
      await friends(r, f1);
      await friends(r, f2);

      const s1 = await db.session('friend-1');
      const s2 = await db.session('friend-2');
      const insert = `insert into feed_events (actor_id, type, media_item_id) values ($1, 'title_ranked', $2) returning id`;
      try {
        await Promise.all([s1.q(insert, [f1, m]), s2.q(insert, [f2, m])]);
      } finally {
        await s1.end().catch(() => {});
        await s2.end().catch(() => {});
      }

      const cs = await db.rows(
        `select id, eligible_at from proactive_candidates where recipient_id = $1 and type = 'watchlist_social'`,
        [r],
      );
      assert.equal(cs.length, 1, 'PA2: one cluster');
      assert.ok(cs[0].eligible_at, 'PA2: both counted, so it is eligible');
      const [{ n }] = await db.rows(
        `select count(*)::int n from notifications where recipient_id = $1 and type = 'watchlist_social'`,
        [r],
      );
      assert.equal(n, 1, 'PA2: one inbox row');
      const [{ people }] = await db.rows(
        `select count(distinct actor_id)::int people from proactive_cluster_actors where candidate_id = $1`,
        [cs[0].id],
      );
      assert.equal(people, 2);
    });

    it('PA3: two concurrent claims return a proactive job once', async () => {
      const { db, fx } = ctx;
      const m = await fx.createMovie('PA3');
      const r = await reader(m);
      await eligibleCluster(r, m);
      await db.sql(`select _proactive_arbitrate($1::timestamptz)`, [EVENING]);
      const [{ notification_id: note }] = await db.rows(
        `select notification_id from proactive_candidates where recipient_id = $1 and state = 'selected'`,
        [r],
      );

      const s1 = await db.session('sender-1');
      const s2 = await db.session('sender-2');
      let results;
      try {
        results = await Promise.all([
          s1.one(`select claim_push_batch(100, $1::timestamptz) as r`, [EVENING]),
          s2.one(`select claim_push_batch(100, $1::timestamptz) as r`, [EVENING]),
        ]);
      } finally {
        await s1.end().catch(() => {});
        await s2.end().catch(() => {});
      }
      const hits = results.flatMap((row) => row.r).filter((job) => job.notification_id === note);
      assert.equal(hits.length, 1, 'PA3: claimed exactly once');
      const [{ state }] = await db.rows(`select state from proactive_candidates where notification_id = $1`, [note]);
      assert.equal(state, 'sent');
    });
  });
}
