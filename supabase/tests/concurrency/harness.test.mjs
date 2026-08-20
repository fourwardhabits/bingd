import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createRaceDb, fixtures, startCluster, stopCluster } from './harness.mjs';

/**
 * The harness proving itself.
 *
 * Every other file here rests on three claims, and a claim that is not tested is the
 * thing that quietly stops being true:
 *
 *   1. the sessions really are independent backends, not one connection multiplexed;
 *   2. `awaitBlocked` really observes blocking, and really fails when nothing blocks;
 *   3. the barrier really pauses one transaction at a chosen table, and really lets
 *      another past while it is paused.
 *
 * The second is the one worth the most: a `awaitBlocked` that returned on a timeout
 * instead of throwing would make every lock-ordering test in this directory pass
 * against a schema with no locks in it at all.
 */

let db;
let fx;

before(async () => {
  await startCluster();
  db = await createRaceDb();
  fx = fixtures(db);
});

after(async () => {
  await db.close();
  await stopCluster();
});

describe('the harness itself', () => {
  it('runs a real PostgreSQL, not a simulator', async () => {
    const [{ version }] = await db.rows('select version()');
    assert.match(version, /^PostgreSQL 1[5-9]/);
    // The gap `../harness.mjs` documents and cannot close: here citext is the real
    // extension, so case-insensitive uniqueness is genuinely enforced.
    const [{ extname }] = await db.rows(`select extname from pg_extension where extname = 'citext'`);
    assert.equal(extname, 'citext');
  });

  it('applied the real migrations, in the real order', async () => {
    const [{ n }] = await db.rows(
      `select count(*)::int as n from pg_proc
        where proname in ('_claim_operation', '_lock_pair', '_assert_operation_rate',
                          'follow', 'block', 'recommend_title', 'create_invite_link')`,
    );
    assert.equal(n, 7);
  });

  it('gives each session its own backend and its own transaction', async () => {
    const t1 = await db.session('t1');
    const t2 = await db.session('t2');

    assert.notEqual(t1.pid, t2.pid, 'two sessions shared a backend');

    const alice = await fx.createUser({ username: 'harness_alice' });

    await t1.begin();
    await t1.q(`update profiles set display_name = 'changed' where id = $1`, [alice]);

    // Uncommitted in t1 is invisible in t2. If these were one connection it would
    // not be — which is exactly why PGlite cannot host any of this.
    const seen = await t2.one(`select display_name from profiles where id = $1`, [alice]);
    assert.equal(seen.display_name, 'harness_alice');

    await t1.rollback();
    await t1.end();
    await t2.end();
  });

  it('awaitBlocked observes a real lock wait', async () => {
    const ctl = await db.controller();
    const t1 = await db.session('blocked');

    await ctl.hold('selftest');
    const pending = t1.start(
      `select pg_advisory_xact_lock(hashtextextended('race:selftest', 0))`,
    );

    const seen = await t1.awaitBlocked();
    assert.equal(seen.wait_event_type, 'Lock');
    assert.equal(seen.wait_event, 'advisory');

    await ctl.release('selftest');
    await pending;
    await t1.q('rollback');
    await t1.end();
    await ctl.end();
  });

  it('awaitBlocked throws when nothing blocks — the failure mode that matters', async () => {
    const t1 = await db.session('never-blocks');
    await assert.rejects(
      () => t1.awaitBlocked({ timeoutMs: 300 }),
      /never blocked on a lock/,
      'a harness that times out silently would make every lock test vacuous',
    );
    await t1.end();
  });

  it('the barrier pauses one transaction at a chosen table and lets another past', async () => {
    const alice = await fx.createUser({ username: 'barrier_alice' });
    const bob = await fx.createUser({ username: 'barrier_bob' });

    await db.armBarrier('notifications', 'demo');

    const ctl = await db.controller();
    await ctl.hold('demo');

    const t1 = await db.session('paused');
    await t1.begin();
    await t1.pauseAt('demo');
    const pending = t1.start(
      `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
       values ($1, 'follow', $2, 'profile', $2)`,
      [alice, bob],
    );
    await t1.awaitBlocked();

    // A session that did not opt in is untouched by the armed trigger — otherwise
    // the barrier would stop the other half of every race it is used to construct.
    const t2 = await db.session('free');
    await t2.begin();
    await t2.q(
      `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
       values ($1, 'follow', $2, 'profile', $2)`,
      [bob, alice],
    );
    await t2.commit();

    const before = await db.rows(`select count(*)::int as n from notifications`);
    assert.equal(before[0].n, 1, 'only the unpaused insert should have landed');

    await ctl.release('demo');
    await pending;
    await t1.commit();

    const after = await db.rows(`select count(*)::int as n from notifications`);
    assert.equal(after[0].n, 2);

    await db.sql(`delete from notifications`);
    await db.sql(`drop trigger if exists _race_barrier_notifications on notifications`);
    await t1.end();
    await t2.end();
    await ctl.end();
  });
});
