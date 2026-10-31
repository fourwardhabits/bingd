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
 * **PA5.** A mute racing a CLAIM (Codex final reviews, MAJOR). claim_push_batch locks each
 * proactive candidate (FOR UPDATE SKIP LOCKED) before judging it and holds the lock until
 * it is marked sent, and returns a proactive job only if its candidate went selected ->
 * sent in that claim. A mute that holds the row first makes the claim SKIP it, not wait:
 * the job goes back to the queue untouched, and the next drain drops it once the mute has
 * committed, with no budget spent. A claim that holds it first sends once, and the mute
 * that follows leaves the candidate sent and produces no second push.
 * **PA6.** A mute racing the ARBITER (Codex + Fable final reviews). The arbiter walks a
 * reader's due rows in priority order; the mute used to lock the same rows by id, so a
 * reader with two clusters whose eligibility order inverts their id order could leave each
 * holding one row and waiting on the other. Now both take the reader's arbiter lock before
 * any row, and the arbiter locks every due row by id before its walk. So one waits on the
 * reader lock holding nothing, whichever arrives first, and neither is ever aborted.
 * **PA7.** Two overlapping TICKS with different clocks (Codex + Fable final reviews). The
 * old bulk expiry held another reader's row while the later tick waited for a reader lock
 * the earlier tick held, and the earlier tick then waited on that row. Now one global
 * arbiter lock makes the later tick wait before it touches any row, and expiry happens per
 * reader under that reader's lock.
 * **PA8.** A claim racing one social activity that touches TWO readers' clusters (Codex
 * final review). The activity holds both rows; the claim skips them rather than waiting, so
 * it cannot close a cycle with any writer's order, and the jobs go back to the queue to be
 * judged and sent, once, by the next drain.
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

    /** Resolves as `p` does, or fails if it takes longer than `ms`: "it did not wait". */
    const within = async (p, ms, label) => {
      let timer;
      try {
        return await Promise.race([
          p,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label}: still waiting after ${ms}ms`)), ms);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };

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
        `insert into device_tokens (user_id, token, platform, proactive_version) values ($1, $2, 'ios', 2)`,
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

      it('the mute first: the claim skips without waiting, requeues, and the next drain drops it', async () => {
        const { db } = ctx;
        const { r, c } = await selected('PA5 mute first');
        const s1 = await db.session('mute');
        const s2 = await db.session('claim');
        let claimed;
        try {
          // B. The preference-off transaction, held open. Its trigger has already
          // suppressed the selected candidate, uncommitted, and holds its row.
          await s1.q('begin');
          await s1.q(mute, [r]);
          // C/D. The claim runs to completion while the mute is still open: it skips the
          // row it cannot lock rather than waiting on it.
          claimed = (await within(s2.one(`select claim_push_batch(100, $1::timestamptz) as r`, [EVENING]),
            5000, 'PA5 claim during an open mute')).r;
          assert.equal(
            claimed.filter((j) => j.notification_id === c.notification_id).length,
            0,
            'PA5: nothing is sent for a candidate the mute holds',
          );
          // The job is back in the queue exactly as before the claim.
          const [o] = await db.rows(
            `select state, claimed_at, attempts from push_outbox where notification_id = $1`,
            [c.notification_id],
          );
          assert.deepEqual([o.state, o.claimed_at, o.attempts], ['pending', null, 0], 'PA5: requeued, clean');
          const [mid] = await db.rows(`select state, sent_at from proactive_candidates where id = $1`, [c.id]);
          assert.deepEqual([mid.state, mid.sent_at], ['selected', null], 'PA5: nothing charged by the skip');
          // E. The mute commits.
          await s1.q('commit');
        } finally {
          await s1.end().catch(() => {});
          await s2.end().catch(() => {});
        }

        // F. The next drain judges it afresh and drops it.
        const [{ r: next }] = await db.rows(`select claim_push_batch(100, $1::timestamptz) as r`, [EVENING]);
        assert.equal(
          next.filter((j) => j.notification_id === c.notification_id).length,
          0,
          'PA5: the muted push is never returned',
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
        // No second effect, and not because of the lease: a sender that crashed holding
        // it would let the row be re-claimed once the five minutes pass. Expire the lease,
        // as that crash would, and claim again: at most once still returns nothing, and
        // the row leaves the queue.
        await db.sql(
          `update push_outbox set claimed_at = now() - interval '6 minutes' where notification_id = $1`,
          [c.notification_id],
        );
        const [{ eligible }] = await db.rows(
          `select count(*)::int eligible from push_outbox
            where notification_id = $1 and state = 'claimed' and claimed_at < now() - interval '5 minutes'`,
          [c.notification_id],
        );
        assert.equal(eligible, 1, 'PA5: the lease really has expired, so the row is claimable');
        const [{ r: again }] = await db.rows(`select claim_push_batch(100, $1::timestamptz) as r`, [EVENING]);
        assert.equal(
          again.filter((j) => j.notification_id === c.notification_id).length,
          0,
          'PA5: a re-claimed row is never sent twice',
        );
        const [{ n: left }] = await db.rows(
          `select count(*)::int n from push_outbox where notification_id = $1`,
          [c.notification_id],
        );
        assert.equal(left, 0, 'PA5: and it leaves the queue');
        assert.equal((await candidate(c.id)).state, 'sent');
      });
    });

    describe('PA6: a mute racing the arbiter', () => {
      const mute = `insert into notification_preferences (user_id, category, enabled)
                    values ($1, 'watchlist_discovery', false)
                    on conflict (user_id, category) do update set enabled = excluded.enabled`;
      const arbKey = async (r) =>
        (await ctx.db.rows(`select hashtextextended('bingd.proactive:' || $1::text, 0)::text as k`, [r]))[0].k;

      /**
       * A reader with two due social clusters whose eligibility order is the inverse of
       * their id order: `first` (eligible earlier, so the arbiter's walk reaches it
       * first) has the HIGHER id, and `second` the lower. That is the shape the old lock
       * orders disagreed on.
       */
      const inverted = async (name) => {
        const { db, fx } = ctx;
        const m1 = await fx.createMovie(`${name} 1`);
        const m2 = await fx.createMovie(`${name} 2`);
        const r = await reader(m1);
        await db.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [r, m2]);
        await eligibleCluster(r, m1);
        await eligibleCluster(r, m2);
        const [low, high] = await db.rows(
          `select id, notification_id from proactive_candidates where recipient_id = $1 order by id`,
          [r],
        );
        await db.sql(`update proactive_candidates set eligible_at = '2031-03-03T10:00:00Z' where id = $1`, [high.id]);
        await db.sql(`update proactive_candidates set eligible_at = '2031-03-03T11:00:00Z' where id = $1`, [low.id]);
        return { r, first: high, second: low };
      };

      /** Settles every racer and fails on any error, a deadlock (40P01) above all. */
      const settle = async (label, ...pending) => {
        const results = await Promise.allSettled(pending);
        for (const res of results) {
          if (res.status === 'rejected') {
            assert.fail(`${label}: ${res.reason?.code ?? ''} ${res.reason?.message ?? res.reason}`);
          }
        }
      };

      /** The valid final state after a mute, whichever side went first. */
      const assertMutedCleanly = async (r, label) => {
        const { db } = ctx;
        const rows = await db.rows(
          `select state, suppression_reason, sent_at from proactive_candidates where recipient_id = $1`,
          [r],
        );
        assert.equal(rows.length, 2);
        for (const c of rows) {
          assert.deepEqual([c.state, c.suppression_reason, c.sent_at], ['suppressed', 'preference_off', null], label);
        }
        // Whatever the arbiter queued is not sendable: the next drain drops it and
        // nothing is left behind.
        const [{ r: jobs }] = await db.rows(`select claim_push_batch(100, $1::timestamptz) as r`, [EVENING]);
        const mine = await db.rows(`select id from notifications where recipient_id = $1`, [r]);
        const ids = new Set(mine.map((n) => n.id));
        assert.equal(jobs.filter((j) => ids.has(j.notification_id)).length, 0, `${label}: no push`);
        const [{ n }] = await db.rows(`select count(*)::int n from push_outbox where recipient_id = $1`, [r]);
        assert.equal(n, 0, `${label}: no outbox row left`);
      };

      /**
       * The old deadlock, reproduced deterministically. A third session holds an
       * uncommitted outbox insert for `first`'s notification, so the arbiter stops inside
       * its walk at exactly the point where it has `first` and has not reached `second`.
       * The mute then arrives. Before the fix it locked `second` (lower id) and waited on
       * `first`; releasing the arbiter sent it to `second`, and Postgres aborted one of
       * them. Now the arbiter already holds both rows, and the mute waits on the reader
       * lock holding none.
       */
      const arbiterFirst = async (name) => {
        const { db } = ctx;
        const { r, first } = await inverted(name);
        const hold = await db.session('outbox-holder');
        const arb = await db.session('arbiter');
        const mut = await db.session('mute');
        try {
          await hold.q('begin');
          await hold.q(`insert into push_outbox (notification_id, recipient_id) values ($1, $2)`, [
            first.notification_id,
            r,
          ]);
          const arbiting = arb.start(`select _proactive_arbitrate($1::timestamptz)`, [EVENING]);
          await arb.awaitBlocked();

          const muting = mut.start(mute, [r]);
          // The mute waits on the reader's arbiter lock, holding no candidate row.
          await mut.awaitBlocked({ advisoryKey: await arbKey(r) });
          const [{ n: rowsHeld }] = await db.rows(
            `select count(*)::int n from pg_locks l
               join pg_class c on c.oid = l.relation
              where l.pid = $1 and l.granted and c.relname = 'proactive_candidates'`,
            [mut.pid],
          );
          assert.equal(rowsHeld, 0, 'PA6: the waiting mute holds no lock of any mode on proactive_candidates');

          await hold.q('rollback');
          await settle('PA6 arbiter first', arbiting, muting);
        } finally {
          await hold.end().catch(() => {});
          await arb.end().catch(() => {});
          await mut.end().catch(() => {});
        }
        await assertMutedCleanly(r, 'PA6 arbiter first');
      };

      const muteFirst = async (name) => {
        const { db } = ctx;
        const { r } = await inverted(name);
        const mut = await db.session('mute');
        const arb = await db.session('arbiter');
        try {
          await mut.q('begin');
          await mut.q(mute, [r]);
          const arbiting = arb.start(`select _proactive_arbitrate($1::timestamptz) as r`, [EVENING]);
          // The arbiter waits on the reader lock the mute holds, before touching a row.
          await arb.awaitBlocked({ advisoryKey: await arbKey(r) });
          await mut.q('commit');
          await settle('PA6 mute first', arbiting);
        } finally {
          await mut.end().catch(() => {});
          await arb.end().catch(() => {});
        }
        await assertMutedCleanly(r, 'PA6 mute first');
        const [{ n }] = await ctx.db.rows(
          `select count(*)::int n from proactive_candidates where recipient_id = $1 and selected_at is not null`,
          [r],
        );
        assert.equal(n, 0, 'PA6: nothing was selected after the mute');
      };

      it('the arbiter mid-walk, then a mute: the mute waits on the reader lock, no deadlock', async () => {
        await arbiterFirst('PA6 arbiter first');
      });

      it('a mute, then the arbiter: the arbiter waits on the reader lock, no deadlock', async () => {
        await muteFirst('PA6 mute first');
      });

      /**
       * Repeated, both orders, then the two fired together with no choreography, on a
       * fresh reader each round. Any lock cycle would surface here as a 40P01.
       */
      it('stays deadlock-free over repeated rounds, choreographed and free-running', async () => {
        const { db } = ctx;
        for (let i = 0; i < 5; i += 1) {
          await arbiterFirst(`PA6 rep a${i}`);
          await muteFirst(`PA6 rep m${i}`);
        }
        for (let i = 0; i < 15; i += 1) {
          const { r } = await inverted(`PA6 free ${i}`);
          const a = await db.session('arbiter');
          const b = await db.session('mute');
          try {
            await settle(
              `PA6 free round ${i}`,
              a.q(`select _proactive_arbitrate($1::timestamptz)`, [EVENING]),
              b.q(mute, [r]),
            );
          } finally {
            await a.end().catch(() => {});
            await b.end().catch(() => {});
          }
          await assertMutedCleanly(r, `PA6 free round ${i}`);
        }
      });
    });

    describe('PA7: overlapping ticks with different clocks', () => {
      const T1 = '2031-03-03T17:30:00Z'; // the earlier tick
      const T2 = '2031-03-03T17:50:00Z'; // the later one
      const BETWEEN = '2031-03-03T17:40:00Z'; // expired for T2, still timely for T1
      const globalKey = async () =>
        (await ctx.db.rows(`select hashtextextended('bingd.proactive.arbiter', 0)::text as k`))[0].k;
      const readerKey = async (r) =>
        (await ctx.db.rows(`select hashtextextended('bingd.proactive:' || $1::text, 0)::text as k`, [r]))[0].k;

      /**
       * Two readers in recipient order. `low` (visited first) has a cluster that will be
       * selected; `high` has one that is due but held (no device) and expires BETWEEN the
       * two clocks: the row the old bulk expiry of the later tick took, then held.
       */
      const world = async (name) => {
        const { db, fx } = ctx;
        const ma = await fx.createMovie(`${name} a`);
        const mb = await fx.createMovie(`${name} b`);
        const ra = await reader(ma);
        const rb = await reader(mb);
        const [low, high] = ra < rb ? [{ r: ra, m: ma }, { r: rb, m: mb }] : [{ r: rb, m: mb }, { r: ra, m: ma }];
        await eligibleCluster(low.r, low.m);
        await eligibleCluster(high.r, high.m);
        await db.sql(`delete from device_tokens where user_id = $1`, [high.r]);
        await db.sql(`update proactive_candidates set expires_at = $2 where recipient_id = $1`, [high.r, BETWEEN]);
        const [lc] = await db.rows(`select id, notification_id from proactive_candidates where recipient_id = $1`, [low.r]);
        const [hc] = await db.rows(`select id from proactive_candidates where recipient_id = $1`, [high.r]);
        return { low: { ...low, c: lc }, high: { ...high, c: hc } };
      };

      const settle = async (label, ...pending) => {
        for (const res of await Promise.allSettled(pending)) {
          if (res.status === 'rejected') {
            assert.fail(`${label}: ${res.reason?.code ?? ''} ${res.reason?.message ?? res.reason}`);
          }
        }
      };

      const candidateLocks = async (pid) =>
        (await ctx.db.rows(
          `select count(*)::int n from pg_locks l join pg_class c on c.oid = l.relation
            where l.pid = $1 and l.granted and c.relname = 'proactive_candidates'`,
          [pid],
        ))[0].n;

      /** The one valid outcome, whichever tick ran first. */
      const assertValid = async (w, label) => {
        const { db } = ctx;
        const [lc] = await db.rows(
          `select state, sent_at, selected_local_date from proactive_candidates where id = $1`, [w.low.c.id]);
        assert.equal(lc.state, 'selected', `${label}: low selected`);
        assert.equal(lc.sent_at, null, `${label}: nothing sent by arbitration`);
        const [hc] = await db.rows(
          `select state, suppression_reason, sent_at from proactive_candidates where id = $1`, [w.high.c.id]);
        // Expired by whichever tick reached it past BETWEEN: with the reason that held it
        // (no_device) if the earlier tick had arbitrated it first, else plain `expired`.
        assert.equal(hc.state, 'expired', `${label}: high expired`);
        assert.ok(['no_device', 'expired'].includes(hc.suppression_reason), `${label}: ${hc.suppression_reason}`);
        assert.equal(hc.sent_at, null);
        const [{ n }] = await db.rows(`select count(*)::int n from push_outbox where recipient_id = $1`, [w.low.r]);
        assert.equal(n, 1, `${label}: one push queued for low, not two`);
        const [{ h }] = await db.rows(`select count(*)::int h from push_outbox where recipient_id = $1`, [w.high.r]);
        assert.equal(h, 0, `${label}: nothing queued for high`);
        // And the drain sends low once, and nothing twice.
        const [{ r: jobs }] = await db.rows(`select claim_push_batch(100, $1::timestamptz) as r`, [T1]);
        assert.equal(jobs.filter((j) => j.notification_id === w.low.c.notification_id).length, 1, `${label}: sent once`);
        const [after] = await db.rows(`select state, sent_at from proactive_candidates where id = $1`, [w.low.c.id]);
        assert.equal(after.state, 'sent');
        assert.ok(after.sent_at);
      };

      /**
       * The first tick is frozen inside its walk of `low` (an uncommitted outbox insert for
       * low's notification), holding the global lock and low's reader lock. The second
       * tick, with the other clock, then starts. Before the fix it expired `high`'s row,
       * held it, waited for low's reader lock, and the first tick then waited on that row.
       */
      const overlap = async (name, firstClock, secondClock) => {
        const { db } = ctx;
        const w = await world(name);
        const hold = await db.session('outbox-holder');
        const first = await db.session('tick-first');
        const second = await db.session('tick-second');
        try {
          await hold.q('begin');
          await hold.q(`insert into push_outbox (notification_id, recipient_id) values ($1, $2)`,
            [w.low.c.notification_id, w.low.r]);
          const one = first.start(`select _proactive_arbitrate($1::timestamptz)`, [firstClock]);
          await first.awaitBlocked();

          const two = second.start(`select _proactive_arbitrate($1::timestamptz)`, [secondClock]);
          // The second tick waits on the GLOBAL lock, before touching any candidate.
          await second.awaitBlocked({ advisoryKey: await globalKey() });
          assert.equal(await candidateLocks(second.pid), 0, 'PA7: the waiting tick holds no candidate lock');
          // And high's row is free: nothing has locked it outside high's reader lock.
          const probe = await db.session('probe');
          try {
            await probe.q('begin');
            const err = await probe.errorFrom(
              `select id from proactive_candidates where id = $1 for update nowait`, [w.high.c.id]);
            assert.equal(err, null, 'PA7: no tick holds high\'s row while waiting');
            await probe.q('rollback');
          } finally {
            await probe.end().catch(() => {});
          }

          await hold.q('rollback');
          await settle(`PA7 ${name}`, one, two);
        } finally {
          await hold.end().catch(() => {});
          await first.end().catch(() => {});
          await second.end().catch(() => {});
        }
        await assertValid(w, `PA7 ${name}`);
      };

      it('the earlier tick first, then the later: the later waits on the global lock, no deadlock', async () => {
        await overlap('earlier first', T1, T2);
      });

      it('the later tick first, then the earlier: the same, and the expiry is not undone', async () => {
        await overlap('later first', T2, T1);
      });

      it('expiry happens under the reader\'s own lock, not before it', async () => {
        const { db } = ctx;
        const w = await world('PA7 per reader');
        const ctl = await db.session('reader-lock-holder');
        const tick = await db.session('tick');
        try {
          // Somebody (a mute, say) holds high's reader lock.
          await ctl.q(`select pg_advisory_lock(hashtextextended('bingd.proactive:' || $1::text, 0))`, [w.high.r]);
          const running = tick.start(`select _proactive_arbitrate($1::timestamptz)`, [T2]);
          await tick.awaitBlocked({ advisoryKey: await readerKey(w.high.r) });
          // The tick has not expired, or even locked, high's row yet.
          const probe = await db.session('probe');
          try {
            await probe.q('begin');
            const err = await probe.errorFrom(
              `select id from proactive_candidates where id = $1 for update nowait`, [w.high.c.id]);
            assert.equal(err, null, 'PA7: high\'s row is untouched until its reader lock is held');
            await probe.q('rollback');
          } finally {
            await probe.end().catch(() => {});
          }
          await ctl.q(`select pg_advisory_unlock(hashtextextended('bingd.proactive:' || $1::text, 0))`, [w.high.r]);
          await settle('PA7 per reader', running);
        } finally {
          await ctl.end().catch(() => {});
          await tick.end().catch(() => {});
        }
        const [hc] = await db.rows(`select state, suppression_reason from proactive_candidates where id = $1`, [w.high.c.id]);
        assert.deepEqual([hc.state, hc.suppression_reason], ['expired', 'expired'], 'PA7: then expired, by that tick');
      });

      it('stays deadlock-free over repeated rounds, choreographed and free-running', async () => {
        const { db } = ctx;
        for (let i = 0; i < 3; i += 1) {
          await overlap(`rep e${i}`, T1, T2);
          await overlap(`rep l${i}`, T2, T1);
        }
        for (let i = 0; i < 10; i += 1) {
          const w = await world(`PA7 free ${i}`);
          const a = await db.session('tick-a');
          const b = await db.session('tick-b');
          try {
            await settle(`PA7 free round ${i}`,
              a.q(`select _proactive_tick($1::timestamptz)`, [T1]),
              b.q(`select _proactive_tick($1::timestamptz)`, [T2]));
          } finally {
            await a.end().catch(() => {});
            await b.end().catch(() => {});
          }
          await assertValid(w, `PA7 free round ${i}`);
        }
      });
    });

    describe('PA8: a claim racing a social activity that touches two readers', () => {
      /**
       * Two readers who both have `m` saved, each with a cluster for it selected tonight
       * and queued, and a friend of both (`y`) who is about to rank `m`.
       */
      const world = async (name) => {
        const { db, fx } = ctx;
        const m = await fx.createMovie(name);
        const a = await reader(m);
        const b = await reader(m);
        await eligibleCluster(a, m);
        await eligibleCluster(b, m);
        await db.sql(`select _proactive_arbitrate($1::timestamptz)`, [EVENING]);
        const rows = await db.rows(
          `select id, notification_id, recipient_id, state from proactive_candidates
            where recipient_id = any ($1::uuid[]) order by recipient_id`,
          [[a, b]],
        );
        assert.deepEqual(rows.map((r) => r.state), ['selected', 'selected'], 'both selected for tonight');
        const y = await fx.createUser();
        await friends(a, y);
        await friends(b, y);
        return { m, y, cs: rows };
      };

      const notes = (w) => new Set(w.cs.map((c) => c.notification_id));

      const runRound = async (name) => {
        const { db } = ctx;
        const w = await world(name);
        const writer = await db.session('activity');
        const sender = await db.session('claim');
        try {
          // One activity transaction, holding BOTH readers' cluster rows (its trigger
          // visits every reader who has the title saved).
          await writer.q('begin');
          await writer.q(`insert into feed_events (actor_id, type, media_item_id) values ($1, 'title_ranked', $2)`,
            [w.y, w.m]);
          const [{ n: members }] = await db.rows(
            `select count(*)::int n from proactive_cluster_actors where candidate_id = any ($1::uuid[])`,
            [w.cs.map((c) => c.id)],
          );
          assert.equal(members, 4, 'PA8: the new friend is not committed yet');

          // The claim finishes while the activity is open: it skips, it does not wait.
          const [{ r: during }] = [await within(
            sender.one(`select claim_push_batch(100, $1::timestamptz) as r`, [EVENING]),
            5000, `PA8 ${name} claim during the activity`)];
          assert.equal(during.filter((j) => notes(w).has(j.notification_id)).length, 0,
            'PA8: neither locked candidate is sent');
          const queued = await db.rows(
            `select state, claimed_at, attempts from push_outbox where notification_id = any ($1::uuid[])`,
            [[...notes(w)]],
          );
          assert.equal(queued.length, 2, 'PA8: both jobs are still queued, not lost');
          for (const o of queued) {
            assert.deepEqual([o.state, o.claimed_at, o.attempts], ['pending', null, 0], 'PA8: requeued, clean');
          }
          const mid = await db.rows(
            `select state, sent_at from proactive_candidates where id = any ($1::uuid[])`,
            [w.cs.map((c) => c.id)],
          );
          for (const c of mid) {
            assert.deepEqual([c.state, c.sent_at], ['selected', null], 'PA8: nothing charged by the skip');
          }
          await writer.q('commit');
        } finally {
          await writer.end().catch(() => {});
          await sender.end().catch(() => {});
        }

        // The next drain judges both afresh and sends each once, counting the new friend.
        const [{ r: next }] = await db.rows(`select claim_push_batch(100, $1::timestamptz) as r`, [EVENING]);
        const mine = next.filter((j) => notes(w).has(j.notification_id));
        assert.equal(mine.length, 2, 'PA8: each sent by the next drain');
        assert.equal(new Set(mine.map((j) => j.notification_id)).size, 2, 'PA8: once each');
        const after = await db.rows(
          `select state, sent_at, actor_count_at_send from proactive_candidates where id = any ($1::uuid[])`,
          [w.cs.map((c) => c.id)],
        );
        for (const c of after) {
          assert.equal(c.state, 'sent');
          assert.ok(c.sent_at);
          assert.equal(c.actor_count_at_send, 3, 'PA8: with the friend the activity added');
        }

        // And never again, even once the lease has run out.
        await db.sql(
          `update push_outbox set claimed_at = now() - interval '6 minutes' where notification_id = any ($1::uuid[])`,
          [[...notes(w)]],
        );
        const [{ r: again }] = await db.rows(`select claim_push_batch(100, $1::timestamptz) as r`, [EVENING]);
        assert.equal(again.filter((j) => notes(w).has(j.notification_id)).length, 0, 'PA8: no second push');
        const [{ n_left: remaining }] = await db.rows(
          `select count(*)::int n_left from push_outbox where notification_id = any ($1::uuid[])`,
          [[...notes(w)]],
        );
        assert.equal(remaining, 0);
      };

      it('the claim skips both locked candidates, then the next drain sends each once', async () => {
        await runRound('PA8');
      });

      it('repeated, on fresh readers each round', async () => {
        for (let i = 0; i < 5; i += 1) await runRound(`PA8 rep ${i}`);
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

    // -----------------------------------------------------------------------
    // 20261031000100: seasons, the one-event guard, and affinity
    // -----------------------------------------------------------------------

    const globalKey9 = async () =>
      (await ctx.db.rows(`select hashtextextended('bingd.proactive.arbiter', 0)::text as k`))[0].k;
    const readerKey9 = async (r) =>
      (await ctx.db.rows(`select hashtextextended('bingd.proactive:' || $1::text, 0)::text as k`, [r]))[0].k;
    const candidateLocks9 = async (pid, mode = null) =>
      (await ctx.db.rows(
        `select count(*)::int n from pg_locks l join pg_class c on c.oid = l.relation
          where l.pid = $1 and l.granted and c.relname = 'proactive_candidates'
            and ($2::text is null or l.mode = $2)`,
        [pid, mode],
      ))[0].n;
    const settle9 = async (label, ...pending) => {
      for (const res of await Promise.allSettled(pending)) {
        if (res.status === 'rejected') assert.fail(`${label}: ${res.reason?.code ?? ''} ${res.reason?.message ?? res.reason}`);
      }
    };
    const mute9 = `insert into notification_preferences (user_id, category, enabled)
                   values ($1, 'watchlist_discovery', false)
                   on conflict (user_id, category) do update set enabled = excluded.enabled`;

    describe('PA9: season collection inside overlapping ticks and against a mute', () => {
      const RELEASE = '2031-05-16';
      const OBSERVED = '2031-05-16T14:00:00Z';
      const NIGHT = '2031-05-16T18:00:00Z';
      const CLAIM = '2031-05-16T18:05:00Z';
      let n = 0;

      before(async () => {
        await ctx.db.sql(
          `insert into app_config (key, value) values ('proactive.season_enabled', 'true'::jsonb)
           on conflict (key) do update set value = excluded.value`,
        );
      });
      after(async () => {
        await ctx.db.sql(`update app_config set value = 'false'::jsonb where key = 'proactive.season_enabled'`);
      });

      /** A series whose Season 2 is released and verified, and a reader who saved the series. */
      const world = async () => {
        const { db } = ctx;
        n += 1;
        const [s] = await db.rows(
          `insert into media_items (kind, tmdb_id, title, provenance) values ('series', $1, $2, 'tmdb') returning id`,
          [1_970_000_000 + n * 10, `PA9 ${n}`],
        );
        for (const [k, d] of [[1, '2024-01-01'], [2, RELEASE]]) {
          await db.sql(
            `insert into media_items (kind, parent_id, season_number, tmdb_id, title, release_date, provenance)
             values ('season', $1, $2, $3, $4, $5, 'tmdb')`,
            [s.id, k, 1_970_000_000 + n * 10 + k, `Season ${k}`, d],
          );
        }
        await db.sql(`insert into release_subjects (media_item_id, subject_kind, next_check_at) values ($1, 'series', $2)`, [
          s.id, OBSERVED,
        ]);
        await db.sql(`select release_observe($1::jsonb, $2::timestamptz)`, [
          JSON.stringify({
            media_item_id: s.id, kind: 'series', status: 'Returning Series', in_production: true,
            read_at: OBSERVED,
            seasons: [{ season_number: 1, air_date: '2024-01-01' }, { season_number: 2, air_date: RELEASE }],
          }),
          OBSERVED,
        ]);
        const [e] = await db.rows(
          `select e.id from release_events e join media_items m on m.id = e.media_item_id
            where m.parent_id = $1 and m.season_number = 2`,
          [s.id],
        );
        await db.sql(
          `insert into proactive_season_availability
             values ($1, 'US', $2, $3, $3::timestamptz + interval '24 hours', 'https://tv.example.com')`,
          [e.id, RELEASE, OBSERVED],
        );
        const r = await reader(s.id);
        return { r, series: s.id, event: e.id };
      };
      const seasonRows = async (r) =>
        ctx.db.rows(
          `select state, suppression_reason from proactive_candidates where recipient_id = $1 and type = 'season_premiere'`,
          [r],
        );
      const notes = async (r) =>
        ctx.db.rows(`select id from notifications where recipient_id = $1 and type = 'season_premiere'`, [r]);

      it('two overlapping ticks collect one season once: the later waits on the global lock holding nothing', async () => {
        const { db } = ctx;
        const w = await world();
        const first = await db.session('tick-first');
        const second = await db.session('tick-second');
        try {
          await first.q('begin');
          await first.q(`select _proactive_tick($1::timestamptz)`, [NIGHT]);
          const two = second.start(`select _proactive_tick($1::timestamptz)`, [NIGHT]);
          await second.awaitBlocked({ advisoryKey: await globalKey9() });
          assert.equal(await candidateLocks9(second.pid), 0, 'PA9: the waiting tick holds no candidate lock');
          await first.q('commit');
          await settle9('PA9 ticks', two);
        } finally {
          await first.end().catch(() => {});
          await second.end().catch(() => {});
        }
        const rows = await seasonRows(w.r);
        assert.deepEqual(rows.map((c) => c.state), ['selected'], 'PA9: one candidate, selected once');
        const [note, extra] = await notes(w.r);
        assert.ok(note && !extra, 'PA9: one inbox row');
        const [{ r: jobs }] = await db.rows(`select claim_push_batch(100, $1::timestamptz) as r`, [CLAIM]);
        assert.equal(jobs.filter((j) => j.notification_id === note.id).length, 1, 'PA9: sent once');
      });

      it('a mute in flight: the tick collects, waits on the reader lock, then suppresses', async () => {
        const { db } = ctx;
        const w = await world();
        const muter = await db.session('mute');
        const ticker = await db.session('tick');
        try {
          await muter.q('begin');
          await muter.q(mute9, [w.r]);
          const pending = ticker.start(`select _proactive_tick($1::timestamptz)`, [NIGHT]);
          await ticker.awaitBlocked({ advisoryKey: await readerKey9(w.r) });
          await muter.q('commit');
          await settle9('PA9 mute first', pending);
        } finally {
          await muter.end().catch(() => {});
          await ticker.end().catch(() => {});
        }
        const rows = await seasonRows(w.r);
        assert.deepEqual(rows.map((c) => [c.state, c.suppression_reason]), [['suppressed', 'preference_off']]);
        const [{ k }] = await db.rows(`select count(*)::int k from push_outbox where recipient_id = $1`, [w.r]);
        assert.equal(k, 0, 'PA9: nothing queued');
      });

      it('the tick first: the mute waits for it, and the claim then drops the season', async () => {
        const { db } = ctx;
        const w = await world();
        const ticker = await db.session('tick');
        const muter = await db.session('mute');
        try {
          await ticker.q('begin');
          await ticker.q(`select _proactive_tick($1::timestamptz)`, [NIGHT]);
          const pending = muter.start(mute9, [w.r]);
          await muter.awaitBlocked({ advisoryKey: await readerKey9(w.r) });
          await ticker.q('commit');
          await settle9('PA9 tick first', pending);
        } finally {
          await ticker.end().catch(() => {});
          await muter.end().catch(() => {});
        }
        const [note] = await notes(w.r);
        const [{ r: jobs }] = await db.rows(`select claim_push_batch(100, $1::timestamptz) as r`, [CLAIM]);
        assert.equal(jobs.filter((j) => j.notification_id === note.id).length, 0, 'PA9: no push after the mute');
        const rows = await seasonRows(w.r);
        assert.deepEqual(rows.map((c) => [c.state, c.suppression_reason]), [['suppressed', 'preference_off']]);
      });
    });

    describe('PA10: one qualifying social event per transaction, under a concurrent tick', () => {
      it('the second event joins nothing, the writer holds one row per reader, and a tick runs through', async () => {
        const { db, fx } = ctx;
        const m1 = await fx.createMovie('PA10 one');
        const m2 = await fx.createMovie('PA10 two');
        const r1 = await reader(m1);
        const r2 = await reader(m1);
        for (const r of [r1, r2]) await db.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [r, m2]);
        const a = await fx.createUser();
        await friends(r1, a);
        await friends(r2, a);
        const writer = await db.session('writer');
        const ticker = await db.session('tick');
        try {
          await writer.q('begin');
          await writer.q(`insert into feed_events (actor_id, type, media_item_id) values ($1, 'title_ranked', $2)`, [a, m1]);
          await writer.q(`insert into feed_events (actor_id, type, media_item_id) values ($1, 'title_ranked', $2)`, [a, m2]);
          await within(ticker.q(`select _proactive_tick($1::timestamptz)`, ['2031-03-03T17:30:00Z']), 5000, 'PA10 tick');
          await writer.q('commit');
        } finally {
          await writer.end().catch(() => {});
          await ticker.end().catch(() => {});
        }
        for (const r of [r1, r2]) {
          const titles = (await db.rows(
            `select media_item_id from proactive_candidates where recipient_id = $1 and type = 'watchlist_social'`, [r],
          )).map((x) => x.media_item_id);
          assert.deepEqual(titles, [m1], 'PA10: only the first event of the transaction');
        }
      });
    });

    describe('PA11: affinity-ordered arbitration and claims, with interactions being written', () => {
      it('an uncommitted comment never blocks the arbiter, the closer cluster wins, and it is sent once', async () => {
        const { db, fx } = ctx;
        const older = await fx.createMovie('PA11 older');
        const closer = await fx.createMovie('PA11 closer');
        const r = await reader(older);
        await db.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [r, closer]);
        // The older cluster first (09:00), then the one with friends the reader talks to.
        await eligibleCluster(r, older);
        await db.sql(`update app_config set value = 'false'::jsonb where key = 'proactive.generation_enabled'`);
        const close = [];
        try {
          for (let i = 0; i < 2; i += 1) {
            const f = await fx.createUser();
            await friends(r, f);
            close.push(f);
            const [ev] = await db.rows(
              `insert into feed_events (actor_id, type, media_item_id) values ($1, 'title_ranked', $2) returning id`, [f, closer],
            );
            await db.sql(`select _proactive_social_add($1, $2, $3, $4, '2031-03-03T10:00:00Z')`, [r, f, closer, ev.id]);
            const [post] = await db.rows(
              `insert into feed_events (actor_id, type, media_item_id) values ($1, 'watchlist_added', $2) returning id`, [f, closer],
            );
            await db.sql(
              `insert into comments (feed_event_id, author_id, body, created_at) values ($1, $2, 'yes', '2031-03-02T12:00:00Z')`,
              [post.id, r],
            );
          }
        } finally {
          await db.sql(`update app_config set value = 'true'::jsonb where key = 'proactive.generation_enabled'`);
        }

        const commenter = await db.session('commenter');
        const arbiter = await db.session('arbiter');
        try {
          await commenter.q('begin');
          const post = await commenter.q(
            `insert into feed_events (actor_id, type, media_item_id) values ($1, 'watchlist_added', $2) returning id`,
            [close[0], older],
          );
          await commenter.q(
            `insert into comments (feed_event_id, author_id, body, created_at) values ($1, $2, 'more', '2031-03-03T12:00:00Z')`,
            [post.rows[0].id, r],
          );
          await within(arbiter.q(`select _proactive_arbitrate($1::timestamptz)`, [EVENING]), 5000, 'PA11 arbiter');
          await commenter.q('commit');
        } finally {
          await commenter.end().catch(() => {});
          await arbiter.end().catch(() => {});
        }
        const [sel] = await db.rows(
          `select media_item_id, notification_id from proactive_candidates where recipient_id = $1 and state = 'selected'`, [r],
        );
        assert.equal(sel.media_item_id, closer, 'PA11: affinity chose the closer friends');

        const s1 = await db.session('claim-1');
        const s2 = await db.session('claim-2');
        let jobs = [];
        try {
          const results = await Promise.all([
            s1.q(`select claim_push_batch(100, '2031-03-03T17:35:00Z'::timestamptz) as r`),
            s2.q(`select claim_push_batch(100, '2031-03-03T17:35:00Z'::timestamptz) as r`),
          ]);
          jobs = results.flatMap((res) => res.rows[0].r);
        } finally {
          await s1.end().catch(() => {});
          await s2.end().catch(() => {});
        }
        const mine = jobs.filter((j) => j.notification_id === sel.notification_id);
        assert.equal(mine.length, 1, 'PA11: sent once');
        assert.equal(JSON.stringify(mine[0]).includes('affinity'), false);
      });
    });
  });
}
