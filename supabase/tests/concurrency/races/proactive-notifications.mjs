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
 * **PA4.** A mute of Watchlist & discovery racing a qualifying activity (Codex re-review):
 * `_proactive_social_add` takes the reader's preference lock SHARED and the mute trigger
 * takes it EXCLUSIVE, so either the mute lands first and the activity records nothing,
 * or the activity lands first and the mute closes the cluster it wrote. Never an open
 * cluster carrying an activity from across the boundary.
 * **PA5.** A mute racing a CLAIM (Codex final review, MAJOR). claim_push_batch locks each
 * proactive candidate before judging it and holds the lock until it is marked sent, and
 * returns a proactive job only if its candidate went selected -> sent in that claim. So a
 * mute that holds the row first makes the claim wait, then return nothing, leave nothing
 * queued and spend no budget; a claim that holds it first sends once, and the mute that
 * follows leaves the candidate sent and produces no second push.
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

    describe('PA5: a mute racing a claim', () => {
      const mute = `insert into notification_preferences (user_id, category, enabled)
                    values ($1, 'watchlist_discovery', false)
                    on conflict (user_id, category) do update set enabled = excluded.enabled`;

      /** A reader whose social cluster is selected for tonight, with its push queued. */
      const selected = async (name) => {
        const { db, fx } = ctx;
        const m = await fx.createMovie(name);
        const r = await reader(m);
        await eligibleCluster(r, m);
        await db.sql(`select _proactive_arbitrate($1::timestamptz)`, [EVENING]);
        const [c] = await db.rows(
          `select id, notification_id, state from proactive_candidates where recipient_id = $1`,
          [r],
        );
        assert.equal(c.state, 'selected', 'selected for tonight');
        const [{ n }] = await db.rows(
          `select count(*)::int n from push_outbox where notification_id = $1`,
          [c.notification_id],
        );
        assert.equal(n, 1, 'and queued');
        return { r, c };
      };

      const candidate = async (id) =>
        (await ctx.db.rows(
          `select state, suppression_reason, sent_at, selected_local_date from proactive_candidates where id = $1`,
          [id],
        ))[0];

      it('the mute first: the claim waits, then returns nothing, queues nothing, spends nothing', async () => {
        const { db } = ctx;
        const { r, c } = await selected('PA5 mute first');
        const s1 = await db.session('mute');
        const s2 = await db.session('claim');
        let claimed;
        try {
          // B. The preference-off transaction, held open. Its trigger has already
          // suppressed the selected candidate, uncommitted.
          await s1.q('begin');
          await s1.q(mute, [r]);
          // C/D. The claim starts and genuinely waits on the candidate row.
          const pending = s2.start(`select claim_push_batch(100, $1::timestamptz) as r`, [EVENING]);
          const seen = await s2.awaitBlocked();
          assert.equal(seen.wait_event_type, 'Lock', 'PA5: the claim waits on the mute');
          // E. The mute commits.
          await s1.q('commit');
          claimed = (await pending).rows[0].r;
        } finally {
          await s1.end().catch(() => {});
          await s2.end().catch(() => {});
        }

        // F. No proactive job for this reader's notification.
        assert.equal(
          claimed.filter((j) => j.notification_id === c.notification_id).length,
          0,
          'PA5: the muted push is not returned',
        );
        // G. Still suppressed for the preference.
        const after = await candidate(c.id);
        assert.deepEqual([after.state, after.suppression_reason], ['suppressed', 'preference_off']);
        // H. Nothing left that a later drain could send.
        const [{ n }] = await db.rows(
          `select count(*)::int n from push_outbox where notification_id = $1`,
          [c.notification_id],
        );
        assert.equal(n, 0, 'PA5: no outbox row survives');
        // I. No sent_at, so no budget consumed: nothing selected or sent holds the day.
        assert.equal(after.sent_at, null);
        const [{ held }] = await db.rows(
          `select count(*)::int held from proactive_candidates
            where recipient_id = $1 and state in ('selected', 'sent')`,
          [r],
        );
        assert.equal(held, 0, 'PA5: the day and the week are free');
      });

      it('the claim first: sent once, and the mute after it changes nothing that was sent', async () => {
        const { db } = ctx;
        const { r, c } = await selected('PA5 claim first');
        const s1 = await db.session('claim');
        const s2 = await db.session('mute');
        let claimed;
        try {
          await s1.q('begin');
          claimed = (await s1.one(`select claim_push_batch(100, $1::timestamptz) as r`, [EVENING])).r;
          // The mute arrives while the claim's transaction still holds the candidate.
          const pending = s2.start(mute, [r]);
          await s2.awaitBlocked();
          await s1.q('commit');
          await pending;
        } finally {
          await s1.end().catch(() => {});
          await s2.end().catch(() => {});
        }

        assert.equal(
          claimed.filter((j) => j.notification_id === c.notification_id).length,
          1,
          'PA5: the claim that held the row sends it, once',
        );
        const after = await candidate(c.id);
        assert.equal(after.state, 'sent', 'PA5: the mute does not rewrite a sent candidate');
        assert.ok(after.sent_at);
        assert.equal(after.suppression_reason, null);
        // No second effect: a later drain returns nothing for it.
        const [{ r: again }] = await db.rows(`select claim_push_batch(100, $1::timestamptz) as r`, [EVENING]);
        assert.equal(again.filter((j) => j.notification_id === c.notification_id).length, 0);
      });
    });

    describe('PA4: a mute racing a qualifying activity', () => {
      const prefKey = async (r) =>
        (await ctx.db.rows(`select hashtextextended('bingd.proactive.social_pref:' || $1::text, 0)::text as k`, [r]))[0].k;
      const mute = `insert into notification_preferences (user_id, category, enabled)
                    values ($1, 'watchlist_discovery', false)
                    on conflict (user_id, category) do update set enabled = excluded.enabled`;
      const rank = `insert into feed_events (actor_id, type, media_item_id) values ($1, 'title_ranked', $2)`;

      /** A reader with one friend already in an open cluster for `m`, and a second friend. */
      const world = async (name) => {
        const { db, fx } = ctx;
        const m = await fx.createMovie(name);
        const r = await reader(m);
        const [f1, f2] = [await fx.createUser(), await fx.createUser()];
        await friends(r, f1);
        await friends(r, f2);
        await db.sql(rank, [f1, m]);
        const [c] = await db.rows(`select id from proactive_candidates where recipient_id = $1`, [r]);
        assert.ok(c, 'the first friend opened a cluster');
        return { r, m, f2 };
      };

      const people = async (r) =>
        (await ctx.db.rows(
          `select count(distinct a.actor_id)::int n from proactive_cluster_actors a
             join proactive_candidates c on c.id = a.candidate_id where c.recipient_id = $1`,
          [r],
        ))[0].n;
      const open = async (r) =>
        ctx.db.rows(
          `select id from proactive_candidates
            where recipient_id = $1 and window_ends_at > now() and state not in ('suppressed', 'expired')`,
          [r],
        );

      it('the mute first: the activity waits for it, then records nothing', async () => {
        const { r, m, f2 } = await world('PA4 mute first');
        const s1 = await ctx.db.session('mute');
        const s2 = await ctx.db.session('activity');
        try {
          await s1.q('begin');
          await s1.q(mute, [r]);
          const pending = s2.start(rank, [f2, m]);
          await s2.awaitBlocked({ advisoryKey: await prefKey(r) });
          await s1.q('commit');
          await pending;
        } finally {
          await s1.end().catch(() => {});
          await s2.end().catch(() => {});
        }
        assert.equal(await people(r), 1, 'PA4: the muted-time friend is not recorded');
        assert.equal((await open(r)).length, 0, 'PA4: nothing open across the boundary');
      });

      it('the activity first: the mute waits for it, then closes what it wrote', async () => {
        const { r, m, f2 } = await world('PA4 activity first');
        const s1 = await ctx.db.session('activity');
        const s2 = await ctx.db.session('mute');
        try {
          await s1.q('begin');
          await s1.q(rank, [f2, m]);
          const pending = s2.start(mute, [r]);
          await s2.awaitBlocked({ advisoryKey: await prefKey(r) });
          await s1.q('commit');
          await pending;
        } finally {
          await s1.end().catch(() => {});
          await s2.end().catch(() => {});
        }
        assert.equal(await people(r), 2, 'PA4: the activity landed before the mute');
        assert.equal((await open(r)).length, 0, 'PA4: and the mute closed it');
        const [c] = await ctx.db.rows(
          `select state, suppression_reason from proactive_candidates where recipient_id = $1`,
          [r],
        );
        assert.deepEqual([c.state, c.suppression_reason], ['suppressed', 'preference_off']);
      });
    });
  });
}
