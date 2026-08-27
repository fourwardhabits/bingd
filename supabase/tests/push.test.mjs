import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Push delivery, 20260825000300.
 *
 * Two things are under test and they are different in kind.
 *
 * The **token lifecycle** is ordinary writer testing: who may write, what a replay does,
 * what a shared device does. The case that matters most is the one with no obvious
 * symptom — a phone that two people sign into in turn, where getting it wrong means one
 * person's notifications arriving on a screen the other is holding.
 *
 * The **outbox** is tested for what it makes *unrepresentable* rather than for what it
 * does. A row here is a notification that was written; there is no path from a client to
 * this table, and a preference that suppressed the notification suppressed the push by
 * construction rather than by a second check. Every one of those claims is asserted with
 * a control beside it, following the rule `notification-preferences.test.mjs` sets: an
 * empty result proves a broken fixture at least as often as it proves working code.
 */

let t;

/** The recipient of everything. */
let reader;
/** Somebody to do things to them, so no notification is a self-notification. */
let actor;
/** A second reader, used as the control wherever a row is expected to be absent. */
let control;

const TOKEN = (n) => `ExponentPushToken[aaaaaaaaaaaaaaaaaaaa${n}]`;

const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

const register = async (userId, token, platform = 'ios', operationId) =>
  t.asUser(userId, async () => {
    const { rows } = await t.sql(
      `select register_device_token($1, $2, $3) as r`,
      [operationId ?? (await uuid()), token, platform],
    );
    return rows[0].r;
  });

const revoke = async (userId, token, operationId) =>
  t.asUser(userId, async () => {
    const { rows } = await t.sql(`select revoke_device_token($1, $2) as r`, [
      operationId ?? (await uuid()),
      token,
    ]);
    return rows[0].r;
  });

/** The live owner of a token, as the sender would resolve it. Null when revoked or absent. */
const liveOwnerOf = async (token) => {
  const { rows } = await t.sql(
    `select user_id from device_tokens where token = $1 and revoked_at is null`,
    [token],
  );
  return rows[0]?.user_id ?? null;
};

/** Files a notification the way every writer in this schema does: a plain insert. */
const notify = async (recipient, type, { actorId = actor, subject = 'profile' } = {}) => {
  const { rows } = await t.sql(
    `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
     values ($1, $2, $3, $4, $3)
     returning id`,
    [recipient, type, actorId, subject],
  );
  return rows[0]?.id ?? null;
};

const outboxFor = async (notificationId) => {
  const { rows } = await t.sql(`select * from push_outbox where notification_id = $1`, [
    notificationId,
  ]);
  return rows[0] ?? null;
};

const claim = async (limit = 20) => {
  const { rows } = await t.sql(`select claim_push_batch($1) as jobs`, [limit]);
  return rows[0].jobs;
};

const settle = async (results, invalidTokens = null) => {
  const { rows } = await t.sql(`select settle_push_batch($1::jsonb, $2::text[]) as r`, [
    JSON.stringify(results),
    invalidTokens,
  ]);
  return rows[0].r;
};

const clearOutbox = () => t.sql(`delete from push_outbox`);
const clearTokens = () => t.sql(`delete from device_tokens`);

before(async () => {
  t = await createTestDb();
  reader = await t.createUser({ username: 'push_reader' });
  actor = await t.createUser({ username: 'push_actor' });
  control = await t.createUser({ username: 'push_control' });
});

after(async () => {
  await t?.close();
});

// ---------------------------------------------------------------------------

describe('register_device_token', () => {
  beforeEach(async () => {
    await clearTokens();
  });

  it('stores a token for the caller', async () => {
    assert.deepEqual(await register(reader, TOKEN(1)), { status: 'ok' });
    assert.equal(await liveOwnerOf(TOKEN(1)), reader);
  });

  it('is unreachable without a session', async () => {
    const error = await t.asAnon(() =>
      t.errorFrom(`select register_device_token(gen_random_uuid(), $1, 'ios')`, [TOKEN(2)]),
    );
    assert.ok(error, 'anon registered a device token');
  });

  /**
   * There is no parameter naming a user, which is the strongest form of the rule
   * `20260813001900` sets — so this asserts the *absence of a signature* rather than a
   * refusal. If somebody adds a `p_user_id` later, this is the test that has to be
   * deleted on purpose.
   */
  it('has no signature by which a caller could register for somebody else', async () => {
    const { rows } = await t.sql(`
      select p.oid::regprocedure::text as signature
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'register_device_token'
    `);
    assert.deepEqual(
      rows.map((r) => r.signature.replace(/^public\./, '').replace(/,\s+/g, ',')),
      ['register_device_token(uuid,text,text)'],
    );
  });

  it('answers already_applied to a replayed operation id', async () => {
    const op = await uuid();
    assert.deepEqual(await register(reader, TOKEN(3), 'ios', op), { status: 'ok' });
    assert.deepEqual(await register(reader, TOKEN(3), 'ios', op), { status: 'already_applied' });
    assert.equal(await liveOwnerOf(TOKEN(3)), reader);
  });

  it('is safe to call twice under different intents', async () => {
    await register(reader, TOKEN(4));
    await register(reader, TOKEN(4));

    const { rows } = await t.sql(`select count(*)::int as n from device_tokens where token = $1`, [
      TOKEN(4),
    ]);
    assert.equal(rows[0].n, 1, 'a device is one row however often it re-registers');
  });

  /**
   * The case with no symptom, and the reason the token is globally unique.
   *
   * A phone is one device however many people sign into it. If both accounts could hold a
   * live row, the sender would deliver the first person's notifications to a screen the
   * second person is holding — and nothing about the app would look wrong.
   */
  it('moves a device to the new account when somebody else signs in on it', async () => {
    await register(reader, TOKEN(5));
    assert.equal(await liveOwnerOf(TOKEN(5)), reader);

    await register(control, TOKEN(5), 'android');

    assert.equal(await liveOwnerOf(TOKEN(5)), control, 'the device did not move');

    const { rows } = await t.sql(
      `select count(*)::int as n from device_tokens
        where token = $1 and user_id = $2 and revoked_at is null`,
      [TOKEN(5), reader],
    );
    assert.equal(rows[0].n, 0, 'the previous account still holds this device');
  });

  /**
   * The ledger is keyed on (user_id, operation_id) since 20260813002300, and this is what
   * that buys: B re-registering a device cannot be answered `already_applied` by a claim A
   * made, which would leave the device pointing at A for ever.
   */
  it('is not blocked by the previous account having used the same operation id', async () => {
    const op = await uuid();
    await register(reader, TOKEN(6), 'ios', op);
    assert.deepEqual(await register(control, TOKEN(6), 'ios', op), { status: 'ok' });
    assert.equal(await liveOwnerOf(TOKEN(6)), control);
  });

  it('refuses a platform it does not support', async () => {
    for (const platform of ['web', 'IOS', '']) {
      const error = await t.asUser(reader, () =>
        t.errorFrom(`select register_device_token(gen_random_uuid(), $1, $2)`, [
          TOKEN(7),
          platform,
        ]),
      );
      assert.ok(error, `${platform} was accepted`);
      assert.match(error.message, /platform/);
    }
  });

  /**
   * A raw APNs or FCM token is 64 hex characters and would pass any length check, then
   * fail silently at the provider for ever. The refusal turns that into an error.
   */
  it('refuses anything that is not an Expo push token', async () => {
    const notTokens = [
      '',
      '   ',
      'a'.repeat(64),
      'ExponentPushToken[]',
      'ExponentPushToken[abc',
      `ExponentPushToken[ok] and then some`,
    ];

    for (const value of notTokens) {
      const error = await t.asUser(reader, () =>
        t.errorFrom(`select register_device_token(gen_random_uuid(), $1, 'ios')`, [value]),
      );
      assert.ok(error, `${JSON.stringify(value)} was accepted`);
    }

    // The control: the shape it is refusing everything *else* against.
    assert.deepEqual(await register(reader, 'ExpoPushToken[xxxxxxxxxxxxxxxxxxxxxx]'), {
      status: 'ok',
    });
  });

  it('refuses a suspended account', async () => {
    const suspended = await t.createUser({ username: 'push_suspended' });
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [suspended]);

    const error = await t.asUser(suspended, () =>
      t.errorFrom(`select register_device_token(gen_random_uuid(), $1, 'ios')`, [TOKEN(8)]),
    );
    assert.ok(error, 'a suspended account registered for push');

    await t.sql(`update profiles set status = 'active' where id = $1`, [suspended]);
  });
});

describe('revoke_device_token', () => {
  beforeEach(async () => {
    await clearTokens();
  });

  it('releases the caller own device', async () => {
    await register(reader, TOKEN(10));
    assert.deepEqual(await revoke(reader, TOKEN(10)), { status: 'ok' });
    assert.equal(await liveOwnerOf(TOKEN(10)), null);
  });

  it('cannot release somebody else device, and does not say so', async () => {
    await register(reader, TOKEN(11));
    assert.deepEqual(await revoke(control, TOKEN(11)), { status: 'ok' });
    assert.equal(await liveOwnerOf(TOKEN(11)), reader, 'another account revoked this device');
  });

  it('brings a released device back rather than writing a second row', async () => {
    await register(reader, TOKEN(12));
    await revoke(reader, TOKEN(12));
    await register(reader, TOKEN(12));

    assert.equal(await liveOwnerOf(TOKEN(12)), reader);
    const { rows } = await t.sql(`select count(*)::int as n from device_tokens where token = $1`, [
      TOKEN(12),
    ]);
    assert.equal(rows[0].n, 1);
  });

  /**
   * Every other writer in this schema refuses a suspended account. This one must not:
   * signing out is the thing a suspended account most needs to be able to do, and a live
   * token left behind because the suspension arrived first is the outcome the function
   * exists to prevent.
   */
  it('still works for a suspended account, unlike every other writer', async () => {
    const suspended = await t.createUser({ username: 'push_suspended_out' });
    await register(suspended, TOKEN(13));
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [suspended]);

    assert.deepEqual(await revoke(suspended, TOKEN(13)), { status: 'ok' });
    assert.equal(await liveOwnerOf(TOKEN(13)), null);
  });

  it('is unreachable without a session', async () => {
    await register(reader, TOKEN(14));
    const error = await t.asAnon(() =>
      t.errorFrom(`select revoke_device_token(gen_random_uuid(), $1)`, [TOKEN(14)]),
    );
    assert.ok(error, 'anon revoked a device token');
    assert.equal(await liveOwnerOf(TOKEN(14)), reader);
  });
});

describe('device_tokens is not a client surface', () => {
  it('cannot be read by its own owner, or by anyone', async () => {
    await clearTokens();
    await register(reader, TOKEN(20));

    for (const [name, run] of [
      ['the owner', (q) => t.asUser(reader, q)],
      ['another account', (q) => t.asUser(control, q)],
      ['anon', (q) => t.asAnon(q)],
    ]) {
      const { rows } = await run(() => t.sql(`select token from device_tokens`));
      assert.deepEqual(rows, [], `${name} could read device tokens`);
    }
  });

  it('cannot be written directly', async () => {
    const error = await t.asUser(reader, () =>
      t.errorFrom(
        `insert into device_tokens (user_id, token, platform) values ($1, $2, 'ios')`,
        [control, TOKEN(21)],
      ),
    );
    assert.ok(error, 'a client wrote a device token directly');
  });
});

// ---------------------------------------------------------------------------

describe('the outbox is filled by notifications and by nothing else', () => {
  beforeEach(async () => {
    await clearOutbox();
    await t.sql(`delete from notifications`);
    await t.sql(`delete from notification_preferences`);
  });

  it('queues every push-eligible kind', async () => {
    for (const type of [
      'follow',
      'follow_request',
      'comment',
      'reaction',
      'watch_tag',
      'recommendation',
      'recommendation_ranked',
      'invite_activated',
      'invite_welcome',
    ]) {
      const id = await notify(reader, type);
      assert.ok(id, `${type} was not written at all`);
      assert.ok(await outboxFor(id), `${type} was not queued`);
    }
  });

  /**
   * PRD §15's event table says Push: No for `follow_approved`, nothing writes an
   * `award_earned`, and `friendship` is the reader's own action. All still reach the
   * inbox, which is the control: the assertion is that they were written and not
   * queued, rather than that nothing happened.
   */
  it('does not queue the kinds that are inbox-only', async () => {
    for (const type of ['follow_approved', 'award_earned', 'friendship']) {
      // `award_earned` defaults off as a category, so it needs turning on to be written
      // at all -- otherwise this test would pass because of the preference gate.
      await t.asUser(reader, () =>
        t.sql(`select set_notification_preference('awards', true)`),
      );
      const id = await notify(reader, type, { actorId: type === 'award_earned' ? null : actor });
      assert.ok(id, `${type} was not written, so this proves nothing`);
      assert.equal(await outboxFor(id), null, `${type} was queued`);
    }
  });

  /**
   * The preference axis, and the whole reason this is an AFTER trigger.
   *
   * `_apply_notification_preference` is a BEFORE trigger returning null, and a row a
   * before-row trigger skips fires no after-row trigger. So there is no push preference
   * to bypass: the notification does not exist.
   */
  it('cannot queue a push for a category the recipient switched off', async () => {
    await t.asUser(reader, () =>
      t.sql(`select set_notification_preference('reactions', false)`),
    );

    const muted = await notify(reader, 'reaction');
    assert.equal(muted, null, 'the notification itself should not have been written');

    const { rows } = await t.sql(`select count(*)::int as n from push_outbox`);
    assert.equal(rows[0].n, 0, 'a suppressed notification was queued for push');

    // The control, in the same shape, for an account that changed nothing.
    const delivered = await notify(control, 'reaction');
    assert.ok(delivered, 'the control account did not receive one either -- fixture is wrong');
    assert.ok(await outboxFor(delivered), 'the control account was not queued');
  });

  it('takes its rows with it when the notification goes', async () => {
    const id = await notify(reader, 'follow');
    assert.ok(await outboxFor(id));

    await t.sql(`delete from notifications where id = $1`, [id]);
    assert.equal(await outboxFor(id), null, 'a queued push outlived its notification');
  });

  /**
   * Refused rather than empty, which is the stronger of the two answers and the one the
   * migration asks for: the select grant is revoked, so this is 42501 before RLS is
   * consulted at all. `notifications` has read the same way since `20260819000300`.
   */
  it('is not readable or writable by a client', async () => {
    await notify(reader, 'follow');

    for (const [name, run] of [
      ['the recipient', (q) => t.asUser(reader, q)],
      ['anon', (q) => t.asAnon(q)],
    ]) {
      const error = await run(() => t.errorFrom(`select notification_id from push_outbox`));
      assert.ok(error, `${name} could read the push outbox`);
      assert.match(error.message, /permission denied/i, name);
    }

    const error = await t.asUser(reader, () =>
      t.errorFrom(
        `insert into push_outbox (notification_id, recipient_id) values (gen_random_uuid(), $1)`,
        [control],
      ),
    );
    assert.ok(error, 'a client queued a push directly');
  });
});

// ---------------------------------------------------------------------------

describe('claim_push_batch', () => {
  beforeEach(async () => {
    await clearOutbox();
    await clearTokens();
    await t.sql(`delete from notifications`);
    await t.sql(`delete from blocks`);
  });

  it('is unreachable by a client role', async () => {
    for (const [name, run] of [
      ['authenticated', (q) => t.asUser(reader, q)],
      ['anon', (q) => t.asAnon(q)],
    ]) {
      const error = await run(() => t.errorFrom(`select claim_push_batch(10)`));
      assert.ok(error, `${name} could claim a push batch`);
      assert.match(error.message, /permission denied/i);
    }
  });

  it('returns the copy and the tokens for one queued notification', async () => {
    await register(reader, TOKEN(30), 'ios');
    const id = await notify(reader, 'follow');

    const jobs = await claim();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].notification_id, id);
    assert.equal(jobs[0].type, 'follow');
    assert.equal(jobs[0].actor_username, 'push_actor');
    assert.deepEqual(jobs[0].tokens, [{ token: TOKEN(30), platform: 'ios' }]);
  });

  it('resolves the title behind a recommendation', async () => {
    await register(reader, TOKEN(31), 'android');
    const movie = await t.createMovie('Stalker', -4242);

    const { rows } = await t.sql(
      `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
       values ($1, 'recommendation', $2, 'media_item', $3) returning id`,
      [reader, actor, movie],
    );

    const jobs = await claim();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].notification_id, rows[0].id);
    assert.equal(jobs[0].media_item_id, movie);
    assert.equal(jobs[0].media_title, 'Stalker');
    assert.equal(jobs[0].media_kind, 'movie');
  });

  it('claims a row once, so a second sender running beside it takes nothing', async () => {
    await register(reader, TOKEN(32));
    await notify(reader, 'follow');

    assert.equal((await claim()).length, 1);
    assert.equal((await claim()).length, 0, 'the same push was claimed twice');
  });

  it('is a no-op when there is nothing queued', async () => {
    assert.deepEqual(await claim(), []);
  });

  /**
   * A recipient with no live device is not something to wait for: a token arriving
   * tomorrow should not produce a buzz about a follow from today. The row is dropped
   * rather than retried.
   */
  it('drops a queued push for a recipient with no live device', async () => {
    const id = await notify(reader, 'follow');
    assert.deepEqual(await claim(), []);
    assert.equal(await outboxFor(id), null, 'an undeliverable row was left in the queue');
  });

  it('ignores a revoked token, and delivers to a live one beside it', async () => {
    await register(reader, TOKEN(33), 'ios');
    await register(reader, TOKEN(34), 'android');
    await revoke(reader, TOKEN(33));

    await notify(reader, 'follow');
    const jobs = await claim();
    assert.deepEqual(jobs[0].tokens, [{ token: TOKEN(34), platform: 'android' }]);
  });

  /**
   * `block()` deletes the notifications that exist when it runs, so a writer that passed
   * its visibility check and committed afterwards leaves a row behind. `my_notifications`
   * already refuses to draw that row (20260819000300 §7); this refuses to push it.
   */
  it('does not push a notification whose actor the recipient has since blocked', async () => {
    await register(reader, TOKEN(35));
    const id = await notify(reader, 'follow');

    // The block after the fact, written directly so it cannot delete the row first --
    // which is precisely the race being reproduced.
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [reader, actor]);

    assert.deepEqual(await claim(), [], 'a blocked actor was pushed');
    assert.equal(await outboxFor(id), null);

    await t.sql(`delete from blocks where blocker_id = $1`, [reader]);
  });

  it('does not push a notification whose actor has been suspended', async () => {
    await register(reader, TOKEN(36));
    const id = await notify(reader, 'follow');
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [actor]);

    assert.deepEqual(await claim(), [], 'a suspended actor was pushed');
    assert.equal(await outboxFor(id), null);

    await t.sql(`update profiles set status = 'active' where id = $1`, [actor]);
  });

  it('bounds the batch however large a limit it is given', async () => {
    await register(reader, TOKEN(37));
    for (let i = 0; i < 5; i += 1) await notify(reader, 'follow');

    assert.equal((await claim(2)).length, 2);
    assert.equal((await claim(1000)).length, 3, 'the ceiling should not have applied here');
  });
});

describe('settle_push_batch', () => {
  beforeEach(async () => {
    await clearOutbox();
    await clearTokens();
    await t.sql(`delete from notifications`);
  });

  it('is unreachable by a client role', async () => {
    for (const [name, run] of [
      ['authenticated', (q) => t.asUser(reader, q)],
      ['anon', (q) => t.asAnon(q)],
    ]) {
      const error = await run(() =>
        t.errorFrom(`select settle_push_batch('[]'::jsonb, null::text[])`),
      );
      assert.ok(error, `${name} could settle a push batch`);
    }
  });

  it('removes a delivered push from the queue and leaves the inbox row alone', async () => {
    await register(reader, TOKEN(40));
    const id = await notify(reader, 'follow');
    await claim();

    const result = await settle([{ notification_id: id, delivered: true }]);
    assert.equal(result.settled, 1);
    assert.equal(await outboxFor(id), null);

    const { rows } = await t.sql(`select count(*)::int as n from notifications where id = $1`, [
      id,
    ]);
    assert.equal(rows[0].n, 1, 'settling a push must not touch the notification');
  });

  it('puts a failed push back, carrying why, and gives up on the third attempt', async () => {
    await register(reader, TOKEN(41));
    const id = await notify(reader, 'follow');

    for (const attempt of [1, 2]) {
      const jobs = await claim();
      const result = await settle([
        {
          notification_id: id,
          // The generation this claim was given. Only a first claim may omit it — see
          // 'refuses a result with no generation once the row has been reclaimed'.
          attempt: jobs[0].attempt,
          delivered: false,
          error: 'provider timed out',
        },
      ]);
      assert.equal(result.retry, 1, `attempt ${attempt} should have been retried`);

      const row = await outboxFor(id);
      assert.equal(row.state, 'pending');
      assert.equal(row.attempts, attempt);
      assert.equal(row.failures, attempt);
      assert.equal(row.last_error, 'provider timed out');
    }

    const third = await claim();
    const final = await settle([
      { notification_id: id, attempt: third[0].attempt, delivered: false, error: 'again' },
    ]);
    assert.equal(final.settled, 1, 'the third failure should have been given up on');
    assert.equal(await outboxFor(id), null);
  });

  it('stops claiming a row that has failed three times', async () => {
    await register(reader, TOKEN(42));
    const id = await notify(reader, 'follow');

    // Three settled failures. This is the bound `20260825000300` meant, and it is the one
    // that still holds: the provider was reached three times and said no three times.
    await t.sql(
      `update push_outbox set failures = 3, state = 'pending' where notification_id = $1`,
      [id],
    );
    assert.deepEqual(await claim(), [], 'a row that has failed three times was claimed again');
  });

  /**
   * `20260826000200`, and the reason it exists.
   *
   * The old schema counted claims and read the count as failures, so a sender dying between
   * its third claim and its settle left a row that `attempts < 3` would never claim again
   * and that `settle_push_batch` would never see again — undeliverable *and* undeletable, in
   * a table documented as a queue that stays bounded with no pruner.
   *
   * The crash is simulated the way it actually happens: claim, then nothing, then the lease
   * expires. Not by writing a counter, because a test that sets up the state it is checking
   * proves the predicate and not the path to it.
   */
  it('claims again after a sender dies mid-flight, however late it died', async () => {
    await register(reader, TOKEN(46));
    const id = await notify(reader, 'follow');

    for (const death of [1, 2, 3]) {
      const jobs = await claim();
      assert.equal(jobs.length, 1, `the sender should have had work on death ${death}`);

      // The sender is gone. Nothing settles; five minutes pass.
      await t.sql(
        `update push_outbox set claimed_at = now() - interval '6 minutes' where notification_id = $1`,
        [id],
      );
    }

    const row = await outboxFor(id);
    assert.equal(row.attempts, 3, 'three claims');
    assert.equal(row.failures, 0, 'nothing ever failed to deliver — nobody got that far');

    const recovered = await claim();
    assert.equal(recovered.length, 1, 'a row was stranded by a crash rather than by a failure');

    const settled = await settle([
      { notification_id: id, attempt: recovered[0].attempt, delivered: true },
    ]);
    assert.equal(settled.settled, 1);
    assert.equal(await outboxFor(id), null);
  });

  /**
   * The other half of the same fix, and the half that is easy to leave out. Something has to
   * *delete* a row that will never be claimed again, or the queue grows for ever — and the
   * only thing that used to delete was the call the stranded row never reaches.
   */
  it('reaps a row that no sender will ever claim again', async () => {
    await register(reader, TOKEN(47));
    const stranded = await notify(reader, 'follow');

    // Six claims' worth of crashing, with the lease expired: past the crash ceiling and
    // held by nobody.
    await t.sql(
      `update push_outbox
          set attempts = 6, state = 'claimed', claimed_at = now() - interval '6 minutes'
        where notification_id = $1`,
      [stranded],
    );

    // A control, so an empty queue cannot be mistaken for a working reaper.
    const live = await notify(control, 'follow');
    await register(control, TOKEN(48));

    const jobs = await claim();
    assert.equal(await outboxFor(stranded), null, 'the exhausted row is still in the queue');
    assert.deepEqual(
      jobs.map((j) => j.notification_id),
      [live],
      'the reaper took the live row with it',
    );
  });

  /**
   * A sender that stalls past its lease has already lost the row, and its late reply must
   * land on nothing.
   *
   * Both statements in `settle_push_batch` matched on `notification_id` alone, which is one
   * identifier short: the stalled sender's failure would reset the row the *next* sender is
   * actively working on — `pending`, `claimed_at` cleared, a failure charged to a delivery
   * still in flight — and a third drain would claim it and send the same notification
   * alongside the sender that never lost it.
   */
  it('ignores a settle from a sender whose lease has expired', async () => {
    await register(reader, TOKEN(51));
    const id = await notify(reader, 'follow');

    // Sender A claims, then stalls past its lease.
    const aJobs = await claim();
    const aAttempt = aJobs[0].attempt;
    assert.equal(aAttempt, 1, 'the claim did not hand back its generation');
    await t.sql(
      `update push_outbox set claimed_at = now() - interval '6 minutes' where notification_id = $1`,
      [id],
    );

    // Sender B takes it. A live lease again — which is why the lease predicate alone cannot
    // tell the two apart, and why the generation is the thing that does.
    const bJobs = await claim();
    assert.equal(bJobs.length, 1, 'the expired lease was not reclaimed');
    assert.equal(bJobs[0].attempt, 2, 'the generation did not move with the reclaim');
    const held = await outboxFor(id);
    assert.equal(held.state, 'claimed');

    // A finally answers, having failed, echoing the generation it was given.
    const late = await settle([
      { notification_id: id, attempt: aAttempt, delivered: false, error: 'A was slow' },
    ]);
    assert.equal(late.settled, 0);
    assert.equal(late.retry, 0);
    assert.equal(late.stale, 1, 'a late reply was not reported as stale');

    const after = await outboxFor(id);
    assert.equal(after.state, 'claimed', 'a late reply released a row B is still sending');
    assert.equal(after.failures, 0, 'a late reply charged a failure to B’s delivery');
    assert.equal(after.attempts, 2, 'a late reply moved the generation');

    // And B's own settle still works, which is what stops this being a test of a
    // settle_push_batch that has simply stopped settling.
    const onTime = await settle([
      { notification_id: id, attempt: bJobs[0].attempt, delivered: true },
    ]);
    assert.equal(onTime.settled, 1);
    assert.equal(await outboxFor(id), null);
  });

  /**
   * The deploy window, asserted so that it is a decision rather than an accident. Migrations
   * land before functions, so for a few minutes a sender built before `20260826000200` is
   * talking to a database built after it. Refusing its results would mean every push in that
   * window retried to the ceiling, which is duplicate notifications to real people.
   */
  it('still settles a result with no generation at all, on a first claim', async () => {
    await register(reader, TOKEN(52));
    const id = await notify(reader, 'follow');

    await claim();
    const settled = await settle([{ notification_id: id, delivered: true }]);
    assert.equal(settled.settled, 1);
    assert.equal(await outboxFor(id), null);
  });

  /**
   * And not past the first, because "accept any result with no generation" is not a deploy
   * window — it is a permanent hole with the original race still in it. The race needs a
   * *second* claim to exist, so `attempts = 1` is exactly the line between the two.
   */
  it('refuses a result with no generation once the row has been reclaimed', async () => {
    await register(reader, TOKEN(53));
    const id = await notify(reader, 'follow');

    await claim();
    await t.sql(
      `update push_outbox set claimed_at = now() - interval '6 minutes' where notification_id = $1`,
      [id],
    );
    const second = await claim();
    assert.equal(second[0].attempt, 2);

    const legacy = await settle([{ notification_id: id, delivered: false, error: 'no generation' }]);
    assert.equal(legacy.stale, 1, 'a generation-less result settled a reclaimed row');

    const after = await outboxFor(id);
    assert.equal(after.state, 'claimed');
    assert.equal(after.failures, 0);
  });

  it('does not reap a row a sender is still holding', async () => {
    await register(reader, TOKEN(49));
    const id = await notify(reader, 'follow');

    // At the ceiling, but leased seconds ago: somebody is working on it and may yet settle.
    await t.sql(
      `update push_outbox
          set failures = 3, state = 'claimed', claimed_at = now()
        where notification_id = $1`,
      [id],
    );

    await claim();
    assert.ok(await outboxFor(id), 'a leased row was reaped out from under its sender');
  });

  it('revokes the tokens the provider reported as gone, and only those', async () => {
    await register(reader, TOKEN(43));
    await register(reader, TOKEN(44));
    const id = await notify(reader, 'follow');
    await claim();

    const result = await settle([{ notification_id: id, delivered: true }], [TOKEN(43)]);
    assert.equal(result.revoked, 1);
    assert.equal(await liveOwnerOf(TOKEN(43)), null);
    assert.equal(await liveOwnerOf(TOKEN(44)), reader, 'a live token was revoked too');
  });

  /**
   * Revoked rather than deleted, so the device can come back. A reinstall produces a new
   * token in practice, but a token rolled by APNs and rolled back is not impossible and
   * the row is one update either way.
   */
  it('leaves a revoked token re-registerable', async () => {
    await register(reader, TOKEN(45));
    await settle([], [TOKEN(45)]);
    assert.equal(await liveOwnerOf(TOKEN(45)), null);

    await register(reader, TOKEN(45));
    assert.equal(await liveOwnerOf(TOKEN(45)), reader);
  });

  it('refuses anything that is not a list of results', async () => {
    for (const bad of ['{}', '"nope"', 'null']) {
      const error = await t.errorFrom(`select settle_push_batch($1::jsonb, null::text[])`, [bad]);
      assert.ok(error, `${bad} was accepted`);
    }
  });
});

// ---------------------------------------------------------------------------

describe('deleting an account takes its push state with it', () => {
  it('leaves no token and no queued push behind', async () => {
    const leaving = await t.createUser({ username: 'push_leaver' });
    await register(leaving, TOKEN(50));
    const id = await notify(leaving, 'follow');
    assert.ok(await outboxFor(id));

    // The cascade, exercised through the foreign keys rather than through delete_account,
    // which additionally needs a confirmation string and a storage round trip.
    await t.sql(`delete from profiles where id = $1`, [leaving]);

    assert.equal(await liveOwnerOf(TOKEN(50)), null);
    assert.equal(await outboxFor(id), null);
  });
});

// ---------------------------------------------------------------------------

/**
 * The comment excerpt (20260827000300) — the one written payload a push may carry,
 * and the three conditions under which it may not.
 *
 * Real `add_comment` rows rather than the `notify` shorthand, because the excerpt is
 * resolved from the payload's `comment_id` and the notification the writer files is
 * the thing under test.
 */
describe('claim_push_batch carries the comment, when it may', () => {
  let movie;
  let event;

  const eventOf = async (who, mediaItemId) => {
    const { rows } = await t.sql(
      `insert into feed_events (actor_id, type, media_item_id, payload)
       values ($1, 'title_ranked', $2, '{"position":1,"bucket":"loved","category":"movies","score":10}')
       returning id`,
      [who, mediaItemId],
    );
    return rows[0].id;
  };

  const commentBy = async (who, body, spoilers = false) => {
    await t.actAs(who);
    const { rows } = await t.sql(`select add_comment(gen_random_uuid(), $1, $2, $3, null) as r`, [
      event,
      body,
      spoilers,
    ]);
    return rows[0].r.comment_id;
  };

  beforeEach(async () => {
    await clearOutbox();
    await clearTokens();
    await t.sql(`delete from notifications`);
    await register(reader, TOKEN(70), 'ios');
    movie = await t.createMovie(`Excerpted ${Date.now()}`, 70000 + Math.floor(Math.random() * 1000));
    event = await eventOf(reader, movie);
  });

  it('quotes a live, spoiler-free comment', async () => {
    await commentBy(actor, 'This ending broke me');

    const jobs = await claim();
    const job = jobs.find((j) => j.type === 'comment');
    assert.ok(job, 'the comment was not queued');
    assert.equal(job.comment_excerpt, 'This ending broke me');
  });

  it('ships no excerpt for a spoiler-marked comment', async () => {
    // The author asked for a tap between reader and text; a lock screen has none.
    await commentBy(actor, 'the twist is that he dies', true);

    const jobs = await claim();
    const job = jobs.find((j) => j.type === 'comment');
    assert.ok(job, 'the spoiler comment still pushes — only its text stays home');
    assert.equal(job.comment_excerpt, null);
  });

  it('pushes nothing at all for a comment deleted before the drain', async () => {
    // `delete_comment` retracts the announcement rows along with the comment, and the
    // outbox entry goes with the notification — so the null-excerpt branch in the
    // claim is a belt for a race inside one drain, not the ordinary retraction path.
    const commentId = await commentBy(actor, 'regretted immediately');
    await t.sql(`select delete_comment(gen_random_uuid(), $1)`, [commentId]);

    const jobs = await claim();
    assert.equal(
      jobs.find((j) => j.type === 'comment'),
      undefined,
      'the retraction takes the push with it',
    );
  });

  it('bounds what leaves the server', async () => {
    await commentBy(actor, 'a'.repeat(500));

    const jobs = await claim();
    const job = jobs.find((j) => j.type === 'comment');
    assert.equal(job.comment_excerpt.length, 180, 'left(body, 180), exactly');
  });
});
