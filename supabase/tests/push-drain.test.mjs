import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The push drain's health check, `20260826000700`.
 *
 * WHAT THIS FILE IS FOR, STATED AS THE INCIDENT IT COMES FROM
 *
 * On 2026-08-26 `bingd-push-drain` reported **1,221 consecutive successful runs** over a
 * pipeline that had never sent one HTTP request. `vault.secrets` was empty, so every tick
 * with work in front of it took the `unconfigured` branch, raised a warning nobody read,
 * and returned normally — and pg_cron, which can only conclude "failed" from a function
 * that raises, wrote `succeeded`. `push_drain_status()` checked `functions.base_url` and
 * did not check the Vault, so the one missing input was the one thing it could not see.
 *
 * Nothing in this repository would have caught it, because there were no tests for the
 * drain at all. These are those tests, and the ones that matter are the *failures*: every
 * assertion below that a broken pipeline reports itself broken is an assertion that this
 * day does not repeat.
 *
 * WHAT PGLITE CAN AND CANNOT DO HERE
 *
 * It has no `pg_cron`, no `pg_net` and no `vault`, which is exactly why the status
 * function reads all three through `to_regclass` and dynamic SQL. That makes the harness a
 * genuine test of the missing-dependency paths rather than a compromise: a bare replay
 * *is* the "nothing is installed" case. Where a test needs the opposite, it creates the
 * schema objects itself — a two-column stand-in for `vault.decrypted_secrets` is enough,
 * because the function only ever asks it one question.
 *
 * NO SECRET, ANYWHERE. The fixture value below is the literal string `not-a-real-key`,
 * and one of the tests is that no field this function returns is long enough to be a
 * credential.
 */

let t;
let recipient;
let actor;

const status = async () => (await t.sql(`select push_drain_status() as s`)).rows[0].s;

/** The Vault, as much of it as the status function looks at. */
const installFakeVault = async (secretName) => {
  await t.sql(`create schema if not exists vault`);
  await t.sql(`drop view if exists vault.decrypted_secrets`);
  await t.sql(`drop table if exists vault.secrets`);
  await t.sql(`create table vault.secrets (name text primary key, secret text not null)`);
  await t.sql(
    `create view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets`,
  );
  if (secretName !== undefined) {
    await t.sql(`insert into vault.secrets (name, secret) values ($1, 'not-a-real-key')`, [
      secretName,
    ]);
  }
};

const removeFakeVault = async () => {
  await t.sql(`drop view if exists vault.decrypted_secrets`);
  await t.sql(`drop table if exists vault.secrets`);
  await t.sql(`drop schema if exists vault`);
};

/**
 * One genuinely queued push, made the way every writer in this schema makes one.
 *
 * `push_outbox.notification_id` references `notifications` and `recipient_id` references
 * `profiles`, so a synthetic pair of uuids is a foreign key violation rather than a
 * queued push — and a fixture that inserted straight into the outbox would also skip
 * `_enqueue_push`, which is the thing that decides there is work at all.
 */
const enqueueOnePush = async () => {
  await t.sql(
    `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
     values ($1, 'follow', $2, 'profile', $2)`,
    [recipient, actor],
  );
  const { rows } = await t.sql(`select count(*)::int as n from push_outbox`);
  assert.ok(rows[0].n > 0, 'fixture did not enqueue a push_outbox row');
};

before(async () => {
  t = await createTestDb();
  recipient = await t.createUser({ username: 'draincheck_to' });
  actor = await t.createUser({ username: 'draincheck_by' });
});

after(async () => {
  await t?.close();
});

beforeEach(async () => {
  await removeFakeVault();
  await t.sql(`delete from push_outbox`);
  await t.sql(`delete from notifications`);
  await t.sql(
    `insert into app_config (key, value)
     values ('functions.base_url', '"https://example.test/functions/v1"'::jsonb)
     on conflict (key) do update set value = excluded.value`,
  );
});

// ---------------------------------------------------------------------------

describe('push_drain_status fails closed', () => {
  /**
   * **The regression, in one assertion.**
   *
   * A database with a correct base URL and no Vault secret cannot send a push, and it must
   * not be able to answer `healthy`. The old function had no field that could have said so.
   */
  it('is unhealthy when the service-role secret is not in the Vault', async () => {
    await installFakeVault(undefined); // Vault present, secret absent.
    const s = await status();

    assert.equal(s.vault_available, true);
    assert.equal(s.vault_secret_set, false);
    assert.equal(s.healthy, false);
    assert.ok(
      s.problems.includes('vault_service_role_key_missing'),
      `problems should name the missing secret, got ${JSON.stringify(s.problems)}`,
    );
  });

  /**
   * A secret under some other name is not the secret. Worth its own test because the
   * plausible operator slip is `service-role-key` or `SERVICE_ROLE_KEY`, and a check that
   * counted rows in `vault.secrets` would have passed for all three.
   */
  it('is not satisfied by a secret stored under a different name', async () => {
    await installFakeVault('service-role-key');
    const s = await status();

    assert.equal(s.vault_secret_set, false);
    assert.equal(s.healthy, false);
    assert.ok(s.problems.includes('vault_service_role_key_missing'));
  });

  it('is not satisfied by an empty secret', async () => {
    await installFakeVault('service_role_key');
    await t.sql(`update vault.secrets set secret = '' where name = 'service_role_key'`);
    const s = await status();

    assert.equal(s.vault_secret_set, false);
    assert.equal(s.healthy, false);
  });

  /**
   * No Vault extension at all is a different operator action from an empty Vault — enable
   * it, rather than go looking in it — so it gets its own problem string. A bare replay is
   * this case, which is why it needs no fixture.
   */
  it('distinguishes a Vault that is not installed from one that is empty', async () => {
    const s = await status();

    assert.equal(s.vault_available, false);
    assert.equal(s.vault_secret_set, false);
    assert.ok(s.problems.includes('vault_unavailable'));
    assert.ok(!s.problems.includes('vault_service_role_key_missing'));
  });

  /**
   * The transport is a dependency too — independent review 46b.
   *
   * `_drain_push_outbox()` ends in `net.http_post`. A project whose `pg_net` has been
   * disabled has an active job, a good URL, a stored secret and an empty queue, and could
   * not send the next push if one arrived; the old summary called that healthy and let the
   * truth surface later as an undefined-function error. Same shape as the incident this
   * file is named after.
   *
   * PGlite has no `pg_net`, so a bare replay is the failing case and the fixture is the
   * *presence* of a `net.http_post`.
   */
  it('is unhealthy when pg_net is not available to post with', async () => {
    await installFakeVault('service_role_key');
    const without = await status();

    assert.equal(without.pg_net_available, false);
    assert.ok(without.problems.includes('pg_net_unavailable'));
    assert.equal(without.healthy, false);

    await t.sql(`create schema if not exists net`);

    /**
     * A function of the right name and the wrong shape is not the transport — review 46c.
     * `_drain_push_outbox()` binds to pg_net's five-argument overload; a stray
     * `net.http_post(text)` left behind by anything at all satisfied the first version of
     * this check while the drain still could not post.
     */
    await t.sql(
      `create function net.http_post(url text) returns bigint language sql as $fn$ select 1::bigint $fn$`,
    );
    const wrongShape = await status();
    assert.equal(wrongShape.pg_net_available, false, 'a different overload is not the one we call');
    assert.ok(wrongShape.problems.includes('pg_net_unavailable'));

    // pg_net's real signature, which is the one the tick's named-argument call resolves to.
    await t.sql(
      `create function net.http_post(
         url text,
         body jsonb default '{}'::jsonb,
         params jsonb default '{}'::jsonb,
         headers jsonb default '{}'::jsonb,
         timeout_milliseconds integer default 5000
       ) returns bigint language sql as $fn$ select 1::bigint $fn$`,
    );
    try {
      const withNet = await status();
      assert.equal(withNet.pg_net_available, true);
      assert.ok(!withNet.problems.includes('pg_net_unavailable'));
    } finally {
      await t.sql(`drop function if exists net.http_post(text)`);
      await t.sql(`drop function if exists net.http_post(text, jsonb, jsonb, jsonb, integer)`);
      await t.sql(`drop schema if exists net`);
    }
  });

  it('is unhealthy when the scheduler was never installed', async () => {
    const s = await status();

    assert.equal(s.job, null);
    assert.equal(s.healthy, false);
    assert.ok(s.problems.includes('scheduler_not_installed'));
  });

  /**
   * The base URL was the one input the old version did check, and it checked only that a
   * row existed. An empty string is a row: the tick would have posted to `/push-sender`
   * relative to nothing at all.
   */
  it('treats an empty base URL as missing', async () => {
    await t.sql(`update app_config set value = '""'::jsonb where key = 'functions.base_url'`);
    const empty = await status();

    assert.equal(empty.base_url_set, false);
    assert.ok(empty.problems.includes('base_url_missing'));

    await t.sql(`delete from app_config where key = 'functions.base_url'`);
    const gone = await status();
    assert.equal(gone.base_url_set, false);
    assert.ok(gone.problems.includes('base_url_missing'));
  });

  /**
   * A queue that is filling and not emptying, which was already the number the runbook
   * alerted on and is now a reason `healthy` is false rather than a figure printed beside
   * a `true`.
   */
  it('is unhealthy while anything has been waiting longer than the drain interval', async () => {
    await installFakeVault('service_role_key');
    await enqueueOnePush();
    await t.sql(`update push_outbox set created_at = now() - interval '20 minutes'`);
    const s = await status();

    assert.equal(Number(s.older_than_15m), 1);
    assert.ok(s.problems.includes('outbox_stalled'));
    assert.equal(s.healthy, false);
  });

  /**
   * A scheduled job that has never executed has demonstrated nothing — independent review
   * 46. `last_run: null` on a job that has been active for more than a minute is a real and
   * documented failure (pg_cron enabled in the wrong database), and calling it healthy is
   * the same mistake as calling `succeeded` delivered, one layer up.
   *
   * PGlite has no `cron.job`, so the job is faked to the shape `push_drain_status()` reads:
   * a jobid, a schedule, `active`, and no matching `job_run_details` row.
   */
  it('is unhealthy when the scheduler exists and has never run', async () => {
    await installFakeVault('service_role_key');
    await t.sql(`create schema if not exists cron`);
    await t.sql(
      `create table cron.job (jobid bigint, jobname text, schedule text, active boolean)`,
    );
    await t.sql(
      `insert into cron.job values (2, 'bingd-push-drain', '* * * * *', true)`,
    );
    try {
      const s = await status();

      assert.equal(s.job.active, true);
      assert.equal(s.last_run, null);
      assert.ok(s.problems.includes('last_run_missing'));
      assert.ok(!s.problems.includes('last_run_not_succeeded'), 'the two are different facts');
      assert.equal(s.healthy, false);
    } finally {
      await t.sql(`drop table if exists cron.job`);
      await t.sql(`drop schema if exists cron`);
    }
  });

  /**
   * Everything the harness *can* satisfy, satisfied — so the failures above are failures
   * of the thing being tested rather than of a function that can only ever say no. The
   * scheduler is the one dependency PGlite cannot provide, so it is the one problem left.
   */
  it('clears each problem as its dependency arrives', async () => {
    await installFakeVault('service_role_key');
    const s = await status();

    assert.deepEqual(s.problems.sort(), ['pg_net_unavailable', 'scheduler_not_installed']);
    assert.equal(s.base_url_set, true);
    assert.equal(s.vault_secret_set, true);
    // Still false, and that is the point: one missing dependency is enough.
    assert.equal(s.healthy, false);
  });

  /**
   * Nothing removed. `scripts/bootstrap-production.mjs` reads four of these keys and four
   * runbooks quote them; a health check that renames its own fields reads as broken on the
   * day it gets better.
   */
  it('still answers every field the runbooks and the bootstrap script read', async () => {
    const s = await status();
    for (const key of [
      'environment',
      'job',
      'last_run',
      'queued',
      'older_than_15m',
      'base_url_set',
    ]) {
      assert.ok(key in s, `push_drain_status lost the ${key} field`);
    }
  });
});

describe('push_drain_status says nothing it should not', () => {
  /**
   * A status function that leaked a service-role key to whoever ran the health check would
   * be a worse defect than the one it exists to fix. The fixture value is checked for by
   * name, and so is anything long enough to be a credential.
   */
  it('returns no secret value and nothing shaped like one', async () => {
    await installFakeVault('service_role_key');
    const raw = JSON.stringify(await status());

    assert.ok(!raw.includes('not-a-real-key'), 'the secret value reached the status output');
    // A service-role JWT is ~220 characters. Nothing this function returns is a long
    // opaque run of credential-ish characters.
    for (const run of raw.match(/[A-Za-z0-9_-]{40,}/g) ?? []) {
      assert.fail(`push_drain_status returned a ${run.length}-character opaque value`);
    }
  });

  it('is closed to anon', async () => {
    await t.asAnon(async () => {
      const error = await t.errorFrom(`select push_drain_status()`);
      assert.match(
        String(error ?? ''),
        /permission denied/i,
        'anon must not read the push pipeline’s configuration state',
      );
    });
  });
});

describe('_drain_push_outbox refuses to look successful', () => {
  /**
   * **The other half of the incident.** pg_cron writes `succeeded` for any function that
   * returns, so a tick that could not send had to start raising or `last_run` would go on
   * lying.
   */
  it('raises when there is work it cannot send', async () => {
    await installFakeVault(undefined); // base URL set, secret absent
    await enqueueOnePush();

    const error = await t.errorFrom(`select _drain_push_outbox()`);
    assert.match(
      String(error ?? ''),
      /not configured/i,
      'a tick with work it cannot do must fail the cron run, not return quietly',
    );
  });

  /**
   * And says which input to go and fix, without saying what either one holds. The base URL
   * is set in this fixture, so a message naming it as missing would send an operator to the
   * wrong dashboard.
   */
  it('names the missing input and no value', async () => {
    await installFakeVault(undefined);
    await enqueueOnePush();

    const message = String((await t.errorFrom(`select _drain_push_outbox()`)) ?? '');

    assert.match(message, /service_role_key is MISSING/);
    assert.match(message, /functions\.base_url is set/);
    assert.ok(!message.includes('example.test'), 'the message must not echo the configured URL');
  });

  /**
   * An idle queue on an unbootstrapped project is not an incident, and 1,440 failed cron
   * rows a day for a database with nothing to send would train everybody to ignore the one
   * that matters.
   */
  it('stays silent when there is nothing to send', async () => {
    await t.sql(`delete from app_config where key = 'functions.base_url'`);
    const { rows } = await t.sql(`select _drain_push_outbox() as r`);

    assert.equal(rows[0].r.status, 'idle');
    assert.equal(Number(rows[0].r.due), 0);
  });
});
