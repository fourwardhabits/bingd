import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The push kill switch, `20260911000200`.
 *
 * `app_config['push.delivery_enabled']` was seeded `false` on day one and read by nothing,
 * so for three weeks the one row an operator would reach for in an emergency said "off"
 * while delivery ran. These tests pin what the row means now, and — the half that matters
 * for a switch — what flipping it must NOT do: lose a push, charge an attempt, or make a
 * deliberately stopped pipeline look like a broken one.
 *
 * No secret anywhere. PGlite has no Vault, which is what makes the tick's "not configured"
 * raise reachable here, and reachable is the point: the switch has to come before it.
 */

let t;
let reader;
let actor;

const TOKEN = 'ExponentPushToken[kkkkkkkkkkkkkkkkkkkk1]';

const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

const setSwitch = (value) =>
  t.sql(
    `update app_config set value = $1::jsonb, updated_at = now() where key = 'push.delivery_enabled'`,
    [JSON.stringify(value)],
  );

const enabled = async () => (await t.sql(`select _push_delivery_enabled() as e`)).rows[0].e;

const notify = async () => {
  const { rows } = await t.sql(
    `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
     values ($1, 'follow', $2, 'profile', $2)
     returning id`,
    [reader, actor],
  );
  return rows[0].id;
};

const outbox = async () => (await t.sql(`select * from push_outbox order by created_at`)).rows;

const claim = async (limit = 20) =>
  (await t.sql(`select claim_push_batch($1) as jobs`, [limit])).rows[0].jobs;

const tick = async () => (await t.sql(`select _drain_push_outbox() as r`)).rows[0].r;

const status = async () => (await t.sql(`select push_drain_status() as s`)).rows[0].s;

before(async () => {
  t = await createTestDb();
  reader = await t.createUser({ username: 'switch_reader' });
  actor = await t.createUser({ username: 'switch_actor' });
  await t.asUser(reader, async () => {
    await t.sql(`select register_device_token($1, $2, 'ios')`, [await uuid(), TOKEN]);
  });
});

after(async () => {
  await t?.close();
});

beforeEach(async () => {
  await t.sql(`delete from push_outbox`);
  await t.sql(`delete from notifications`);
  await t.sql(
    `insert into app_config (key, value) values ('push.delivery_enabled', 'true'::jsonb)
     on conflict (key) do update set value = excluded.value`,
  );
});

describe('the initial state the migration chooses', () => {
  it('is on, because it was on', async () => {
    // The seed row was `false` and inert; delivery ran regardless. Section 5 of the
    // migration states the truth rather than silently honouring the seed, which would
    // have stopped every push the moment it applied. This test is the assertion that a
    // reviewer who changes that literal has to change on purpose.
    const { rows } = await t.sql(
      `select value from app_config where key = 'push.delivery_enabled'`,
    );
    assert.equal(JSON.stringify(rows[0].value), 'true');
  });
});

describe('what the row means', () => {
  it('only the JSON boolean false switches delivery off', async () => {
    await setSwitch(false);
    assert.equal(await enabled(), false);

    await setSwitch(true);
    assert.equal(await enabled(), true);
  });

  it('fails open: a missing row is on', async () => {
    await t.sql(`delete from app_config where key = 'push.delivery_enabled'`);
    assert.equal(await enabled(), true, 'a lost row must not be a silent outage');
  });

  it('is not a client-readable fact', async () => {
    await t.asRole('authenticated', reader, async () => {
      const error = await t.errorFrom(`select _push_delivery_enabled()`);
      assert.ok(error, 'a client cannot ask whether push is on');
    });
  });
});

describe('while the switch is off', () => {
  it('the claim takes nothing, charges nothing and leases nothing', async () => {
    await notify();
    await setSwitch(false);

    const jobs = await claim();

    assert.deepEqual(jobs, []);
    const [row] = await outbox();
    assert.ok(row, 'the row is still queued');
    assert.equal(row.state, 'pending');
    assert.equal(row.attempts, 0, 'an attempt was not charged for a claim that never happened');
    assert.equal(row.claimed_at, null);
  });

  it('the tick posts nothing and does not raise, even unconfigured', async () => {
    // Nothing is configured in PGlite: no base URL, no Vault. With work queued and the
    // switch on, the tick RAISES (20260826000700) so a broken pipeline shows in the job
    // log. With the switch off it must not: stopped on purpose is not broken.
    await notify();
    await setSwitch(false);

    const result = await tick();

    assert.equal(result.status, 'disabled');
    assert.equal(result.due, 1, 'and it says what is waiting');
  });

  it('the readout names the switch and is not healthy', async () => {
    await notify();
    await setSwitch(false);

    const s = await status();

    assert.equal(s.delivery_enabled, false);
    assert.ok(s.problems.includes('delivery_disabled'), JSON.stringify(s.problems));
    assert.equal(s.healthy, false);
  });

  it('notifications keep arriving in the inbox', async () => {
    await setSwitch(false);
    const id = await notify();

    const { rows } = await t.sql(`select 1 from notifications where id = $1`, [id]);
    assert.equal(rows.length, 1, 'stop the phones never means lose the message');
    assert.equal((await outbox()).length, 1, 'and the push is held, not dropped');
  });
});

describe('flipping it back', () => {
  it('drains what waited, oldest first, with nothing lost', async () => {
    await setSwitch(false);
    const first = await notify();
    const second = await notify();
    assert.deepEqual(await claim(), []);

    await setSwitch(true);
    const jobs = await claim();

    assert.deepEqual(
      jobs.map((j) => j.notification_id),
      [first, second],
    );
  });

  it('the readout is healthy again on that axis', async () => {
    await setSwitch(false);
    await setSwitch(true);

    const s = await status();

    assert.equal(s.delivery_enabled, true);
    assert.ok(!s.problems.includes('delivery_disabled'));
  });
});

describe('with the switch on, nothing about the claim changed', () => {
  it('returns the job exactly as before', async () => {
    const id = await notify();

    const jobs = await claim();

    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].notification_id, id);
    assert.equal(jobs[0].type, 'follow');
    assert.equal(jobs[0].tokens.length, 1);
    const [row] = await outbox();
    assert.equal(row.state, 'claimed');
    assert.equal(row.attempts, 1);
  });
});
