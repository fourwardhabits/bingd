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
 * **PA6.** A mute racing the ARBITER (Codex + Fable final reviews). The arbiter walks a
 * reader's due rows in priority order; the mute used to lock the same rows by id, so a
 * reader with two clusters whose eligibility order inverts their id order could leave each
 * holding one row and waiting on the other. Now both take the reader's arbiter lock before
 * any row, and the arbiter locks every due row by id before its walk. So one waits on the
 * reader lock holding nothing, whichever arrives first, and neither is ever aborted.
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
          assert.equal(seen.wait_event_type, 'Lock', 'PA5: the claim waits on a lock');
          // On the mute's transaction specifically, and on a row lock rather than an
          // advisory one: the claim takes no advisory lock, so this is the candidate row
          // the mute's trigger has just suppressed.
          assert.equal(seen.wait_event, 'transactionid', 'PA5: a row lock, not an advisory one');
          const [{ by }] = await db.rows(`select pg_blocking_pids($1) as by`, [s2.pid]);
          assert.deepEqual(by, [s1.pid], 'PA5: blocked by the mute, and nothing else');
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
              where l.pid = $1 and l.granted and c.relname = 'proactive_candidates' and l.mode = 'RowShareLock'`,
            [mut.pid],
          );
          assert.equal(rowsHeld, 0, 'PA6: the waiting mute holds no candidate row lock');

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
