import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, beforeEach, describe, it } from 'node:test';

import { run } from '../../emails/welcome/automation/send-welcome.mjs';
import { createTestDb } from './harness.mjs';
import { AUTH_COLUMNS_SQL, OPEN_COHORT_SQL, welcomeSource, welcomeSqlToApply } from './welcome-email-support.mjs';

const execFileAsync = promisify(execFile);

/**
 * The welcome email's ledger, claim and worker, 2026-09-13.
 *
 * `emails/welcome/automation/welcome_email.sql` is not a migration yet, so this file
 * applies it on top of every real one. The properties it holds:
 *
 *   1. **Nothing happens until two switches say so.** Delivery off, or the cutoff at its
 *      2099 default, claims nobody and writes nothing: hold, do not drop.
 *   2. **The existing user base is never in the cohort.** Only accounts created after the
 *      cutoff, at least `delay_hours` and less than `max_age_hours` ago.
 *   3. **Exactly one email per account.** A claim is a primary-key insert; a second run
 *      finds the row. A retry reuses the claim with a compare-and-set and is bounded.
 *   4. **The ineligible are held, the opted-out are recorded.** Unconfirmed, banned,
 *      anonymous, suspended and address-less accounts write nothing; a suppressed address
 *      is marked `suppressed` and never sent to.
 *   5. **A canary is one named account at one named address, or nobody.**
 *   6. **Only the service role can do any of it.**
 *
 * The second half runs the real worker, `send-welcome.mjs`, over a PostgREST stand-in that
 * executes the real SQL, with Resend recorded. That is the automation canary as a test:
 * eligible, one send, a persisted marker, a second run, zero sends.
 *
 * Concurrency is `concurrency/races/welcome-email.mjs`: PGlite is one connection.
 */

const here = dirname(fileURLToPath(import.meta.url));
const welcomeRoot = join(here, '..', '..', 'emails', 'welcome');

let t;

const ledger = async () => (await t.sql(`select * from welcome_emails order by first_claimed_at, user_id`)).rows;

const claim = async (sql = 'welcome_email_claim()', params = []) =>
  (await t.sql(`select * from ${sql}`, params)).rows;

const record = async (user, attempt, outcome, resendId = null, reason = null) =>
  (await t.sql(`select welcome_email_record($1, $2, $3, $4, $5) as r`, [user, attempt, outcome, resendId, reason])).rows[0].r;

let seq = 0;

/** The account's personal invite link, minted by `create_invite_link` as that account. */
const mintInvite = async (id) => {
  await t.actAs(id);
  const { rows } = await t.sql(`select create_invite_link(gen_random_uuid()) as r`);
  await t.actAs(null);
  assert.equal(rows[0].r.status, 'ok');
  return rows[0].r.token;
};

/** The live personal token, read straight from the table. */
const liveToken = async (id) =>
  (await t.sql(`select token from invite_tokens where owner_id = $1 and revoked_at is null`, [id])).rows[0]?.token ?? null;

const tokenCount = async () => Number((await t.sql(`select count(*)::int as n from invite_tokens`)).rows[0].n);

/** An account with a confirmed address that signed up `hoursAgo` hours ago (default: inside the 48h–168h window). */
const person = async ({
  hoursAgo = 60,
  email,
  confirmed = true,
  status = 'active',
  banned = false,
  deleted = false,
  anonymous = false,
  displayName,
  invite = true,
} = {}) => {
  seq += 1;
  const username = `welcome_${seq}`;
  const id = await t.createUser({ username });
  // Through the shipped writer, exactly as tapping Invite friends does, so the token the
  // email carries is provably the one the app would share.
  if (invite) await mintInvite(id);
  const address = email === undefined ? `Person.${seq}@Example.com` : email;
  await t.sql(
    `update auth.users
        set email = $2,
            email_confirmed_at = case when $3 then now() - interval '1 hour' end,
            banned_until = case when $4 then now() + interval '1 year' end,
            deleted_at = case when $5 then now() end,
            is_anonymous = $6
      where id = $1`,
    [id, address, confirmed, banned, deleted, anonymous],
  );
  await t.sql(
    `update profiles set created_at = now() - make_interval(hours => $2), status = $3::profile_status,
            display_name = coalesce($4, display_name)
      where id = $1`,
    [id, hoursAgo, status, displayName ?? null],
  );
  return { id, username, email: address?.toLowerCase() ?? null };
};

before(async () => {
  t = await createTestDb();
  await t.exec(AUTH_COLUMNS_SQL);
  const sql = await welcomeSqlToApply();
  if (sql) await t.exec(sql);
});

after(async () => {
  await t?.close();
});

/**
 * Each test starts from an empty ledger, no suppressions, and the switches at the values
 * the file installs. People from earlier tests stay, and are deliberately aged out of
 * every window so they cannot leak into a later count.
 */
beforeEach(async () => {
  await t.exec(`
    delete from welcome_emails;
    delete from email_suppressions;
    update profiles set created_at = now() - interval '400 days' where username like 'welcome\\_%';
    update app_config set value = 'false'::jsonb where key = 'welcome.delivery_enabled';
    update app_config set value = '"2099-01-01T00:00:00Z"'::jsonb where key = 'welcome.start_after';
    update app_config set value = '48'::jsonb where key = 'welcome.delay_hours';
    update app_config set value = '168'::jsonb where key = 'welcome.max_age_hours';
    update app_config set value = '25'::jsonb where key = 'welcome.max_per_run';
    update app_config set value = '[]'::jsonb where key = 'welcome.canary_addresses';
  `);
});

describe('welcome email: applying the file', () => {
  it('installs every switch at a value that sends nothing to nobody', async () => {
    const { rows } = await t.sql(`select key, value from app_config where key like 'welcome.%' order by key`);
    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.key, r.value])), {
      'welcome.canary_addresses': [],
      'welcome.delay_hours': 48,
      'welcome.delivery_enabled': false,
      'welcome.max_age_hours': 168,
      'welcome.max_per_run': 25,
      'welcome.start_after': '2099-01-01T00:00:00Z',
    });
  });

  it('never re-arms a switch somebody turned off when its insert runs again', async () => {
    await t.exec(`update app_config set value = 'true'::jsonb where key = 'welcome.delivery_enabled'`);
    const insert = (await welcomeSource()).match(/insert into app_config \(key, value\) values[\s\S]*?on conflict \(key\) do nothing;/);
    assert.ok(insert, 'the switches insert is where this test expects it');
    await t.exec(insert[0]);
    const { rows } = await t.sql(`select value from app_config where key = 'welcome.delivery_enabled'`);
    assert.equal(rows[0].value, true);
  });

  it('hides every switch from clients, which read only public.% keys', async () => {
    const rows = await t.asAnon(async () => (await t.sql(`select key from app_config where key like 'welcome.%'`)).rows);
    assert.equal(rows.length, 0);
  });
});

describe('welcome email: who can call it', () => {
  for (const role of ['anon', 'authenticated']) {
    it(`refuses ${role} every function and both tables`, async () => {
      const someone = await person();
      const as = (fn) => t.asRole(role, role === 'authenticated' ? someone.id : null, fn);
      for (const query of [
        `select welcome_email_preview()`,
        `select * from welcome_email_claim()`,
        `select welcome_email_record('${someone.id}', 1, 'sent')`,
        `select * from _welcome_email_candidates(1)`,
        `select _welcome_email_can_receive('${someone.id}')`,
        `select _welcome_email_in_scope('${someone.id}', null, null)`,
        `select _welcome_email_invite_token('${someone.id}')`,
        `select _welcome_email_ensure_invite_token('${someone.id}')`,
        `select * from welcome_emails`,
        `select * from email_suppressions`,
        `insert into email_suppressions (email, reason) values ('x@example.com', 'requested')`,
      ]) {
        const error = await as(() => t.errorFrom(query));
        assert.ok(error, `${role} ran: ${query}`);
        assert.equal(error.code, '42501', `${query} failed for a reason other than permission: ${error.message}`);
      }
    });
  }

  it('lets the service role call the three entry points and not the candidate list', async () => {
    await t.asRole('service_role', null, async () => {
      assert.equal(await t.errorFrom(`select welcome_email_preview()`), null);
      assert.equal(await t.errorFrom(`select * from welcome_email_claim()`), null);
      for (const helper of [`select * from _welcome_email_candidates(1)`, `select _welcome_email_can_receive(gen_random_uuid())`, `select _welcome_email_in_scope(gen_random_uuid(), null, null)`, `select _welcome_email_invite_token(gen_random_uuid())`, `select _welcome_email_invite_usable(gen_random_uuid())`, `select _welcome_email_ensure_invite_token(gen_random_uuid())`]) {
        assert.equal((await t.errorFrom(helper))?.code, '42501', helper);
      }
    });
  });
});

describe('welcome email: the switches hold', () => {
  it('claims nobody and writes nothing while delivery is off, and the preview still shows who is waiting', async () => {
    await t.exec(OPEN_COHORT_SQL);
    await t.exec(`update app_config set value = 'false'::jsonb where key = 'welcome.delivery_enabled'`);
    const waiting = await person();

    assert.deepEqual(await claim(), []);
    assert.deepEqual(await ledger(), []);

    const preview = (await t.sql(`select welcome_email_preview() as p`)).rows[0].p;
    assert.equal(preview.delivery_enabled, false);
    assert.deepEqual(preview.candidates.map((c) => c.id), [waiting.id]);
    assert.equal(JSON.stringify(preview).includes('@'), false, 'the preview is printed to logs and must carry no address');
  });

  it('claims nobody with delivery on while the cutoff is still at its 2099 default', async () => {
    await t.exec(`update app_config set value = 'true'::jsonb where key = 'welcome.delivery_enabled'`);
    await person();
    assert.deepEqual(await claim(), []);
    assert.deepEqual(await ledger(), []);
  });

  it('never reaches an account created before the cutoff, however long ago it signed up', async () => {
    await person({ hoursAgo: 60 });
    await t.exec(`
      update app_config set value = 'true'::jsonb where key = 'welcome.delivery_enabled';
      update app_config set value = to_jsonb((now() - interval '1 hour')::text) where key = 'welcome.start_after';
    `);
    assert.deepEqual(await claim(), []);

    // The same account on the other side of the cutoff is selected, so the window above
    // refused it for the cutoff and not for anything else.
    await t.exec(`update app_config set value = to_jsonb((now() - interval '61 hours')::text) where key = 'welcome.start_after'`);
    assert.equal((await claim()).length, 1);
  });

  it('waits delay_hours after signup, and gives up after max_age_hours', async () => {
    await t.exec(OPEN_COHORT_SQL);
    await t.exec(`update app_config set value = to_jsonb((now() - interval '400 hours')::text) where key = 'welcome.start_after'`);
    const tooSoon = await person({ hoursAgo: 47 });
    const due = await person({ hoursAgo: 49 });
    const tooLate = await person({ hoursAgo: 169 });

    const taken = (await claim()).map((r) => r.recipient_id);
    assert.deepEqual(taken, [due.id]);
    const rows = await ledger();
    assert.equal(rows.some((r) => r.user_id === tooSoon.id || r.user_id === tooLate.id), false, 'neither is consumed');
  });

  it('caps a run at max_per_run whatever the caller asks for', async () => {
    await t.exec(OPEN_COHORT_SQL);
    await t.exec(`update app_config set value = '3'::jsonb where key = 'welcome.max_per_run'`);
    for (let i = 0; i < 5; i += 1) await person();
    assert.equal((await claim(`welcome_email_claim(100)`)).length, 3);
    assert.equal((await claim(`welcome_email_claim(1)`)).length, 1);
    assert.equal((await ledger()).length, 4);
  });

  it('fails the whole run, before any claim, on a malformed switch', async () => {
    await t.exec(OPEN_COHORT_SQL);
    await person();
    await t.exec(`update app_config set value = '"next tuesday"'::jsonb where key = 'welcome.start_after'`);
    assert.ok(await t.errorFrom(`select * from welcome_email_claim()`));
    assert.deepEqual(await ledger(), []);
  });
});

describe('welcome email: exactly once', () => {
  it('claims an eligible account once, returns its address lower-cased, and never again', async () => {
    await t.exec(OPEN_COHORT_SQL);
    const ada = await person({ email: 'Ada.Lovelace@Example.COM', displayName: 'Ada Lovelace' });

    const first = await claim();
    assert.equal(first.length, 1);
    assert.deepEqual(first[0], {
      recipient_id: ada.id,
      recipient_email: 'ada.lovelace@example.com',
      display_name: 'Ada Lovelace',
      username: ada.username,
      attempt: 1,
      invite_token: await liveToken(ada.id),
    });

    assert.deepEqual(await claim(), [], 'a second run finds the claim');
    assert.equal(await record(ada.id, 1, 'sent', 're_1'), true);
    assert.deepEqual(await claim(), [], 'and a third finds the send');

    const [row] = await ledger();
    assert.equal(row.status, 'sent');
    assert.equal(row.resend_id, 're_1');
    assert.ok(row.sent_at);
    assert.equal(row.canary, false);
  });

  it('never retries a claim whose outcome was not recorded, because it may have gone out', async () => {
    await t.exec(OPEN_COHORT_SQL);
    await person();
    assert.equal((await claim()).length, 1);
    await t.exec(`update welcome_emails set claimed_at = now() - interval '10 hours', first_claimed_at = now() - interval '10 hours'`);
    assert.deepEqual(await claim(), []);
    assert.equal((await ledger())[0].status, 'claimed');
  });

  it('retries a recorded failure with the next attempt number, at most three attempts', async () => {
    await t.exec(OPEN_COHORT_SQL);
    const bo = await person();

    assert.equal((await claim())[0].attempt, 1);
    assert.equal(await record(bo.id, 1, 'failed', null, '500 {}'), true);

    const second = await claim();
    assert.deepEqual(second.map((r) => [r.recipient_id, r.attempt]), [[bo.id, 2]]);
    assert.equal(await record(bo.id, 1, 'sent', 're_stale'), false, 'a stale attempt cannot record over a newer one');
    assert.equal(await record(bo.id, 2, 'failed', null, '429 {}'), true);

    assert.equal((await claim())[0].attempt, 3);
    assert.equal(await record(bo.id, 3, 'failed', null, '500 {}'), true);

    assert.deepEqual(await claim(), [], 'three attempts is the ceiling');
    const [row] = await ledger();
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 3);
    assert.equal(row.failed_reason, '500 {}');
  });

  it('does not retry a failure first claimed 20 or more hours ago, past what Resend deduplicates', async () => {
    await t.exec(OPEN_COHORT_SQL);
    const cy = await person();
    await claim();
    await record(cy.id, 1, 'failed', null, '0 timeout');
    await t.exec(`update welcome_emails set first_claimed_at = now() - interval '21 hours'`);
    assert.deepEqual(await claim(), []);
  });

  it('never lets a cohort run retry a canary failure, even for an account the cohort would not select', async () => {
    const tester = await person({ hoursAgo: 24 * 30 });
    await allowCanary(tester.email);
    await claim(`welcome_email_claim(null, $1, $2)`, [tester.id, tester.email]);
    await record(tester.id, 1, 'failed', null, '500 {}');

    await t.exec(OPEN_COHORT_SQL);
    await t.exec(`update app_config set value = to_jsonb((now() - interval '60 days')::text) where key = 'welcome.start_after'`);
    assert.deepEqual(await claim(), [], 'the cohort does not retry what a canary claimed');
    assert.deepEqual((await claim(`welcome_email_claim(null, $1, $2)`, [tester.id, tester.email])).map((r) => r.attempt), [2]);
  });

  it('never lets a canary run retry a cohort failure', async () => {
    await t.exec(OPEN_COHORT_SQL);
    const due = await person();
    await claim();
    await record(due.id, 1, 'failed', null, '500 {}');
    await allowCanary(due.email);
    assert.deepEqual(await claim(`welcome_email_claim(null, $1, $2)`, [due.id, due.email]), []);
  });

  it('stops retrying once the cutoff is moved back to 2099, or the account can no longer receive', async () => {
    await t.exec(OPEN_COHORT_SQL);
    const one = await person();
    const two = await person();
    await claim();
    await record(one.id, 1, 'failed', null, '500 {}');
    await record(two.id, 1, 'failed', null, '500 {}');

    await t.exec(`update app_config set value = '"2099-01-01T00:00:00Z"'::jsonb where key = 'welcome.start_after'`);
    assert.deepEqual(await claim(), [], 'the second switch stops retries too');

    await t.exec(OPEN_COHORT_SQL);
    await t.sql(`update auth.users set is_anonymous = true where id = $1`, [one.id]);
    await t.sql(`update auth.users set email_confirmed_at = null where id = $1`, [two.id]);
    assert.deepEqual(await claim(), []);
  });

  it('cannot move a sent row, and refuses an outcome that is not sent or failed', async () => {
    await t.exec(OPEN_COHORT_SQL);
    const di = await person();
    await claim();
    assert.equal(await record(di.id, 1, 'sent', 're_9'), true);
    assert.equal(await record(di.id, 1, 'failed', null, 'late'), false);
    assert.equal((await ledger())[0].status, 'sent');
    assert.equal((await t.errorFrom(`select welcome_email_record($1, 1, 'claimed')`, [di.id]))?.code, '22023');
  });

  it('skips a person excluded by hand, whatever the row says', async () => {
    await t.exec(OPEN_COHORT_SQL);
    const ed = await person();
    await t.sql(`insert into welcome_emails (user_id, status) values ($1, 'excluded')`, [ed.id]);
    assert.deepEqual(await claim(), []);
  });

  it('leaves nothing behind when the account is deleted, before or after the send', async () => {
    await t.exec(OPEN_COHORT_SQL);
    const fay = await person();
    await claim();
    await record(fay.id, 1, 'sent', 're_2');
    await t.sql(`delete from auth.users where id = $1`, [fay.id]);
    assert.deepEqual(await ledger(), []);
    assert.deepEqual(await claim(), []);
  });
});

describe('welcome email: the invite link', () => {
  /**
   * Row counts for every table in public, so a test can say which tables a claim changed
   * without having to know every table that might have been touched by accident.
   */
  const tableCounts = async () => {
    const { rows } = await t.sql(
      `select c.relname as name from pg_class c where c.relkind = 'r' and c.relnamespace = 'public'::regnamespace order by 1`,
    );
    const counts = {};
    for (const { name } of rows) {
      counts[name] = Number((await t.sql(`select count(*)::int as n from "${name}"`)).rows[0].n);
    }
    return counts;
  };

  const changedTables = (before, after) =>
    Object.keys(after).filter((name) => before[name] !== after[name]).sort();

  it('gives an account with no link exactly one personal token, and touches no table but the ledger and invite_tokens', async () => {
    await t.exec(OPEN_COHORT_SQL);
    const fresh = await person({ invite: false });
    assert.equal(await liveToken(fresh.id), null);

    const before = await tableCounts();
    const [row] = await claim();
    const after = await tableCounts();

    assert.equal(row.recipient_id, fresh.id);
    assert.match(row.invite_token, /^[0-9a-f]{32}$/);
    assert.deepEqual(changedTables(before, after), ['invite_tokens', 'welcome_emails'],
      'no invite_link_creations, attribution, notification, feed, push, award or operation row');
    assert.equal(after.invite_tokens - before.invite_tokens, 1);

    const { rows } = await t.sql(`select token, short_code, env, kind, revoked_at from invite_tokens where owner_id = $1`, [fresh.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].token, row.invite_token);
    assert.match(rows[0].short_code, /^[0-9A-F]{8}$/);
    assert.equal(rows[0].kind, 'personal');
    assert.equal(rows[0].revoked_at, null);
    const env = (await t.sql(`select environment_name() as e`)).rows[0].e;
    assert.equal(rows[0].env, env, 'stamped with this environment, so the resolver accepts it');
  });

  it('mints the link the app then shares: create_invite_link returns the same token afterwards', async () => {
    await t.exec(OPEN_COHORT_SQL);
    const fresh = await person({ invite: false });
    const [row] = await claim();
    const shared = await mintInvite(fresh.id);
    assert.equal(shared, row.invite_token);
    assert.equal(Number((await t.sql(`select count(*)::int as n from invite_tokens where owner_id = $1`, [fresh.id])).rows[0].n), 1);
  });

  it('reuses an existing link rather than minting a second', async () => {
    await t.exec(OPEN_COHORT_SQL);
    const sharer = await person();
    const existing = await liveToken(sharer.id);
    const tokens = await tokenCount();
    const [row] = await claim();
    assert.equal(row.invite_token, existing);
    assert.equal(await tokenCount(), tokens);
  });

  it('carries the same token on a retry', async () => {
    await t.exec(OPEN_COHORT_SQL);
    const retried = await person({ invite: false });
    const [first] = await claim();
    await record(retried.id, 1, 'failed', null, '500 {}');
    const tokens = await tokenCount();
    const [second] = await claim();
    assert.deepEqual([second.attempt, second.invite_token], [2, first.invite_token]);
    assert.equal(await tokenCount(), tokens);
  });

  it('ensures a link again on a retry when the one the first attempt carried was revoked outright', async () => {
    await t.exec(OPEN_COHORT_SQL);
    const lost = await person({ invite: false });
    const [first] = await claim();
    await record(lost.id, 1, 'failed', null, '500 {}');
    await t.sql(`update invite_tokens set revoked_at = now() where owner_id = $1`, [lost.id]);

    const [second] = await claim();
    assert.equal(second.attempt, 2);
    assert.match(second.invite_token, /^[0-9a-f]{32}$/);
    assert.notEqual(second.invite_token, first.invite_token);
    assert.equal(await liveToken(lost.id), second.invite_token);
  });

  it('does not retry an account whose live token became one this email cannot use', async () => {
    await t.exec(OPEN_COHORT_SQL);
    const moved = await person();
    await claim();
    await record(moved.id, 1, 'failed', null, '500 {}');
    await t.sql(`update invite_tokens set env = 'somewhere-else' where owner_id = $1`, [moved.id]);
    const tokens = await tokenCount();
    assert.deepEqual(await claim(), []);
    assert.equal((await ledger())[0].status, 'failed');
    assert.equal(await tokenCount(), tokens);
  });

  it('carries the replacement after a revocation, never the revoked token', async () => {
    await t.exec(OPEN_COHORT_SQL);
    const rotated = await person();
    const old = await liveToken(rotated.id);
    await t.actAs(rotated.id);
    const { rows } = await t.sql(`select revoke_invite_link(gen_random_uuid()) as r`);
    await t.actAs(null);
    assert.equal(rows[0].r.status, 'ok');
    const [row] = await claim();
    assert.equal(row.invite_token, rows[0].r.token);
    assert.notEqual(row.invite_token, old);
  });

  it('holds, writing nothing, an account whose live token is from another environment or not personal', async () => {
    await t.exec(OPEN_COHORT_SQL);
    const elsewhere = await person();
    await t.sql(`update invite_tokens set env = 'somewhere-else' where owner_id = $1`, [elsewhere.id]);
    const referral = await person();
    await t.sql(`update invite_tokens set kind = 'referral' where owner_id = $1`, [referral.id]);
    const tokens = await tokenCount();
    assert.deepEqual(await claim(), []);
    assert.deepEqual(await ledger(), []);
    assert.equal(await tokenCount(), tokens, 'never replaces somebody else-shaped token');
  });

  it('never mints for a suppressed, held or out-of-window account, or in a dry run', async () => {
    await t.exec(OPEN_COHORT_SQL);
    const suppressed = await person({ invite: false, email: 'nope@example.com' });
    await t.sql(`insert into email_suppressions (email, reason) values ('nope@example.com', 'unsubscribed')`);
    await person({ invite: false, confirmed: false });
    await person({ invite: false, hoursAgo: 2 });
    const due = await person({ invite: false });
    const tokens = await tokenCount();

    const preview = (await t.sql(`select welcome_email_preview() as p`)).rows[0].p;
    assert.equal(preview.invite_links_to_create, 1);
    assert.equal(await tokenCount(), tokens, 'the dry run mints nothing');

    const taken = await claim();
    assert.deepEqual(taken.map((r) => r.recipient_id), [due.id]);
    assert.equal(await tokenCount(), tokens + 1, 'one token, for the one account mailed');
    assert.equal(await liveToken(suppressed.id), null);
  });
});

describe('welcome email: who is not mailed', () => {
  it('holds, without writing anything, every account that is not in a state to receive it', async () => {
    await t.exec(OPEN_COHORT_SQL);
    await person({ confirmed: false });
    await person({ email: null });
    await person({ email: '' });
    await person({ banned: true });
    await person({ deleted: true });
    await person({ anonymous: true });
    await person({ status: 'suspended' });

    assert.deepEqual(await claim(), []);
    assert.deepEqual(await ledger(), [], 'held, not consumed: a fix to any of these can still be welcomed');
  });

  it('records a suppressed address as suppressed, sends it nothing, and stops considering it', async () => {
    await t.exec(OPEN_COHORT_SQL);
    const gil = await person({ email: 'Gil@Example.com' });
    const hal = await person();
    await t.sql(`insert into email_suppressions (email, reason) values ('gil@example.com', 'unsubscribed')`);

    const taken = await claim();
    assert.deepEqual(taken.map((r) => r.recipient_id), [hal.id]);
    const rows = Object.fromEntries((await ledger()).map((r) => [r.user_id, r.status]));
    assert.equal(rows[gil.id], 'suppressed');

    await t.sql(`delete from email_suppressions`);
    assert.deepEqual(await claim(), [], 'removing the suppression later does not resurrect a welcome');
  });

  it('refuses a suppression address that is not lower-cased, so matching cannot miss by case', async () => {
    assert.equal((await t.errorFrom(`insert into email_suppressions (email, reason) values ('Gil@Example.com', 'requested')`))?.code, '23514');
  });

  it('does not retry a failure once the address is suppressed', async () => {
    await t.exec(OPEN_COHORT_SQL);
    const ivy = await person();
    await claim();
    await record(ivy.id, 1, 'failed', null, '500 {}');
    await t.sql(`insert into email_suppressions (email, reason) values ($1, 'complained')`, [ivy.email]);
    assert.deepEqual(await claim(), []);
  });
});

/**
 * A collection in whatever state onboarding would have left it in. `ranked` titles get a
 * `rankings` row as well as a `user_media` row, which is what "ranked" means (a bucket is
 * a band, a position is a ranking); the rest get the collection row only.
 *
 * Written straight in rather than driven through `rank_start`/`rank_answer`, because what
 * is under test is whether the claim *looks* at any of this, and the honest way to ask
 * that is to vary the state as widely as possible and expect no difference at all.
 */
let mediaSeq = 0;
const withCollection = async (owner, { ranked = 0, logged = 0 } = {}) => {
  for (let i = 0; i < ranked + logged; i += 1) {
    mediaSeq += 1;
    const media = await t.createMovie(`Welcome Onboarding ${owner.username} ${i}`, 900000 + mediaSeq);
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`,
      [owner.id, media],
    );
    if (i < ranked) {
      await t.sql(
        `insert into rankings (user_id, media_item_id, category, bucket, position)
         values ($1, $2, 'movies', 'loved', $3)`,
        [owner.id, media, i + 1],
      );
    }
  }
};

/**
 * THE EMAIL IS TRIGGERED BY THE ACCOUNT, NOT BY THE ONBOARDING FLOW.
 *
 * The founder's rule (2026-09-17): somebody who signed up and never finished the first-run
 * flow is exactly the person this note is for, so onboarding state must not gate it, and
 * completing the flow must not gate it either. No ranking is required.
 *
 * The implementation honours that by *omission* — `_welcome_email_in_scope` reads
 * `profiles.created_at` and nothing else, and `_welcome_email_can_receive` reads the
 * profile's status and the auth user. Omission is exactly the kind of rule a later change
 * deletes without noticing, because there is no line to delete. These two tests are that
 * line: the first says the three populations are treated alike, and the second says the
 * eligibility SQL does not so much as mention the tables it would have to read to differ.
 */
describe('welcome email: onboarding state does not decide who is mailed', () => {
  it('mails the account that never started, the one that paused midway, and the one that finished', async () => {
    await t.exec(OPEN_COHORT_SQL);

    // Never opened the first-run flow: an account and nothing else.
    const never = await person({ displayName: 'Never Started' });

    // Paused inside the five-title run — two of five placed, one more logged but unranked.
    // This is the population the note exists to reach, and it must not be held back for
    // being unfinished.
    const paused = await person({ displayName: 'Paused Midway' });
    await withCollection(paused, { ranked: 2, logged: 1 });

    // Finished the run. Eligible on exactly the same terms, and not twice.
    const finished = await person({ displayName: 'Finished' });
    await withCollection(finished, { ranked: 5 });

    const taken = (await claim()).map((r) => r.recipient_id).sort();
    assert.deepEqual(
      taken,
      [never.id, paused.id, finished.id].sort(),
      'all three are claimed, whatever onboarding did',
    );

    // And once each: a second run finds nobody, so "finished" did not earn a second note.
    assert.deepEqual(await claim(), []);
    assert.equal((await ledger()).length, 3);
  });

  it('decides eligibility without reading a single table onboarding writes', async () => {
    const source = await welcomeSource();
    const eligibility = source.match(
      /create function _welcome_email_in_scope[\s\S]*?\$fn\$;|create function _welcome_email_can_receive[\s\S]*?\$fn\$;/g,
    );
    assert.equal(eligibility?.length, 2, 'both eligibility functions are where this test expects them');

    for (const table of ['rankings', 'user_media', 'onboarding', 'taste', 'ranking_sessions']) {
      assert.doesNotMatch(
        eligibility.join('\n'),
        new RegExp(`\\b${table}\\b`),
        `eligibility reads "${table}", so onboarding state now gates the welcome email`,
      );
    }
  });
});

/** Puts addresses on welcome.canary_addresses, the only inboxes a canary may mail. */
const allowCanary = (...addresses) =>
  t.sql(`update app_config set value = $1::jsonb where key = 'welcome.canary_addresses'`, [JSON.stringify(addresses)]);

describe('welcome email: the canary', () => {
  it('claims exactly the named account at the named, allowlisted address with delivery off and the cutoff in 2099', async () => {
    const bystander = await person();
    const canary = await person({ hoursAgo: 1 });
    await allowCanary(canary.email);

    const taken = await claim(`welcome_email_claim(null, $1, $2)`, [canary.id, canary.email.toUpperCase()]);
    assert.deepEqual(taken.map((r) => r.recipient_id), [canary.id]);
    const rows = await ledger();
    assert.deepEqual(rows.map((r) => [r.user_id, r.canary]), [[canary.id, true]]);
    assert.equal(rows.some((r) => r.user_id === bystander.id), false);

    assert.deepEqual(await claim(`welcome_email_claim(null, $1, $2)`, [canary.id, canary.email]), [], 'the second run sends nothing');
  });

  it('claims nobody, and writes nothing, when the address is not on welcome.canary_addresses', async () => {
    const real = await person();
    assert.deepEqual(await claim(`welcome_email_claim(null, $1, $2)`, [real.id, real.email]), [], 'a real account is not a canary');
    assert.deepEqual(await ledger(), []);
    await allowCanary('someone.else@example.com');
    assert.deepEqual(await claim(`welcome_email_claim(null, $1, $2)`, [real.id, real.email]), []);
    assert.deepEqual(await ledger(), []);
  });

  it('claims nobody, and writes nothing, when the address does not match the account', async () => {
    const canary = await person();
    const other = await person();
    await allowCanary(canary.email, other.email);
    assert.deepEqual(await claim(`welcome_email_claim(null, $1, $2)`, [canary.id, other.email]), []);
    assert.deepEqual(await ledger(), []);
  });

  it('refuses half a canary rather than falling back to the cohort', async () => {
    await t.exec(OPEN_COHORT_SQL);
    const due = await person();
    assert.equal((await t.errorFrom(`select * from welcome_email_claim(null, $1, null)`, [due.id]))?.code, '22023');
    assert.equal((await t.errorFrom(`select * from welcome_email_claim(null, null, $1)`, [due.email]))?.code, '22023');
    assert.deepEqual(await ledger(), []);
  });

  it('still refuses a canary account that is not in a state to receive mail', async () => {
    const unconfirmed = await person({ confirmed: false });
    await allowCanary(unconfirmed.email);
    assert.deepEqual(await claim(`welcome_email_claim(null, $1, $2)`, [unconfirmed.id, unconfirmed.email]), []);
  });
});

// ---------------------------------------------------------------------------
// The worker, end to end
// ---------------------------------------------------------------------------

/**
 * PostgREST, as far as the worker uses it: `POST /rest/v1/rpc/<name>` with named
 * arguments, run as the service role, answering a set-returning function with an array
 * and a scalar function with its value. An argument the function does not declare is a
 * 404, as it is in PostgREST, so a renamed parameter fails here and not in production.
 */
const SIGNATURES = {
  welcome_email_preview: { args: ['p_limit', 'p_canary_user', 'p_canary_email'], sql: `select welcome_email_preview($1::int, $2::uuid, $3::text) as r`, set: false },
  welcome_email_claim: { args: ['p_limit', 'p_canary_user', 'p_canary_email'], sql: `select * from welcome_email_claim($1::int, $2::uuid, $3::text)`, set: true },
  welcome_email_record: { args: ['p_user', 'p_attempt', 'p_outcome', 'p_resend_id', 'p_reason'], sql: `select welcome_email_record($1::uuid, $2::int, $3::text, $4::text, $5::text) as r`, set: false },
};

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function world({ resendReplies = [], failRecord = false } = {}) {
  const resend = [];
  const rpcs = [];
  const fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(init.body);

    if (url.hostname === 'api.resend.com') {
      resend.push({ headers: init.headers, body });
      const reply = resendReplies.shift();
      if (reply instanceof Error) throw reply;
      return reply ? json(reply.status, reply.body) : json(200, { id: `re_${resend.length}` });
    }

    const name = url.pathname.replace('/rest/v1/rpc/', '');
    rpcs.push(name);
    const signature = SIGNATURES[name];
    if (!signature || Object.keys(body).some((key) => !signature.args.includes(key))) {
      return json(404, { code: 'PGRST202', message: `no function ${name}(${Object.keys(body)})` });
    }
    if (init.headers.apikey !== 'service-key') return json(401, { message: 'no key' });
    if (name === 'welcome_email_record' && failRecord) return json(503, { message: 'unavailable' });

    const { rows } = await t.asRole('service_role', null, () =>
      t.sql(signature.sql, signature.args.map((a) => body[a] ?? null)),
    );
    return json(200, signature.set ? rows : rows[0].r);
  };
  return { fetch, resend, rpcs };
}

const ENV = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  RESEND_API_KEY: 're_test',
  // Supplied by the workflow from a repository secret. Obviously fake here, which is
  // also the documented staging value.
  WELCOME_POSTAL_ADDRESS: '1 Example Street, Sampleton EX1 2MP',
};

/**
 * A copy of the welcome directory with the copy approved, built by the real `build.mjs`,
 * so the worker reads a manifest and a template it did not have a hand in faking. The
 * postal address is not here: it is an environment variable now, so it is in `ENV`.
 */
async function approvedRoot(change = () => {}) {
  const dir = await mkdtemp(join(tmpdir(), 'welcome-approved-'));
  const copy = JSON.parse(await readFile(join(welcomeRoot, 'copy.json'), 'utf8'));
  copy.letter.status = 'APPROVED';
  change(copy);
  await writeFile(join(dir, 'copy.json'), JSON.stringify(copy, null, 2));
  for (const file of ['targets.json', 'build.mjs']) {
    await writeFile(join(dir, file), await readFile(join(welcomeRoot, file), 'utf8'));
  }
  await execFileAsync(process.execPath, [join(dir, 'build.mjs')]);
  return dir;
}

describe('welcome email: the worker, against the real SQL', () => {
  let root;
  const quiet = () => {};
  const go = (w, argv = [], extra = {}) => run({ argv, env: ENV, fetch: w.fetch, log: quiet, root, pauseMs: 0, ...extra });

  before(async () => {
    root = await approvedRoot();
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('eligible, one send, a persisted marker, a second run, zero sends', async () => {
    await t.exec(OPEN_COHORT_SQL);
    const ada = await person({ displayName: 'Ada Lovelace' });
    const w = world();

    const tokensBefore = await tokenCount();
    const first = await go(w);
    assert.equal(first.code, 0);
    assert.deepEqual([first.claimed, first.sent, first.failed, first.unrecorded], [1, 1, 0, 0]);
    assert.equal(w.resend.length, 1);

    const [{ headers, body }] = w.resend;
    assert.equal(headers['Idempotency-Key'], `welcome-v1-${ada.id}`);
    assert.deepEqual(body.to, [ada.email]);
    assert.equal(body.from, 'Suraj from bingd <suraj@bingd.app>');
    assert.equal(body.reply_to, 'suraj@bingd.app');
    assert.equal(body.subject, 'Welcome to bingd, let me know what you think');
    assert.deepEqual(body.headers, { 'List-Unsubscribe': '<mailto:suraj@bingd.app?subject=Unsubscribe>' });
    assert.match(body.html, /Hey Ada,/);
    assert.match(body.text, /^Hey Ada,/);
    assert.doesNotMatch(body.html + body.text, /\{\{/);
    // The footer address, filled from the environment rather than from copy.json.
    assert.ok(body.html.includes(ENV.WELCOME_POSTAL_ADDRESS), 'the HTML footer carries the address');
    assert.ok(body.text.includes(ENV.WELCOME_POSTAL_ADDRESS), 'the text footer carries the address');

    // The recipient's own invite link, the exact token create_invite_link minted for them,
    // in both parts; and the founder's profile. The run minted nothing.
    const token = await liveToken(ada.id);
    assert.match(token, /^[0-9a-f]{32}$/);
    assert.ok(body.html.includes(`href="https://bingd.app/i/${token}"`), 'HTML carries the recipient invite link');
    assert.ok(body.text.includes(`https://bingd.app/i/${token}`), 'text carries the recipient invite link');
    assert.ok(body.html.includes('href="https://bingd.app/u/saisurajkan"'));

    // THE SENT TEXT IS THE APPROVED LETTER, paragraph for paragraph — read from copy.json
    // rather than restated here, so this proves the payload and cannot drift from the copy.
    // Whitespace is collapsed because the text part is word-wrapped at 72 columns.
    const approved = JSON.parse(await readFile(join(welcomeRoot, 'copy.json'), 'utf8'));
    const flat = (v) => v.replace(/\s+/g, ' ').trim();
    const sentText = flat(body.text);
    for (const paragraph of approved.letter.paragraphs) {
      const words = Array.isArray(paragraph)
        ? paragraph.map((piece) => (typeof piece === 'string' ? piece : piece.link ?? piece.bold)).join('')
        : paragraph;
      // A link in the text part is followed by its URL in brackets, so compare the prose
      // either side of each link rather than the joined sentence.
      for (const run of flat(words).split(/invite link|follow me on bingd/)) {
        if (run.trim()) assert.ok(sentText.includes(flat(run)), `the sent text is the approved letter: missing "${run.slice(0, 50)}"`);
      }
    }
    assert.ok(sentText.includes('Happy binging, Suraj'), 'the signoff');
    assert.equal(body.subject, approved.subject.chosen, 'the sent subject is the approved one');

    // And none of the 2026-09-13 letter survived into what is actually sent.
    assert.doesNotMatch(
      body.html + body.text,
      // The 2026-09-13 letter, then the first 2026-09-18 draft the founder revised after reading it.
      /Post-watch Ranking|Pre-vetted Watchlist|Smooth Planning|Avengers|Emoji Movie|Tell me what you think|hit reply to this email|Rank your latest binge|post-watch experience|hit reply\. It comes/,
      'text from the retired letter is in the sent payload',
    );
    assert.ok(body.text.includes('https://bingd.app/u/saisurajkan'));
    assert.equal(await tokenCount(), tokensBefore, 'the send job never mints an invite token');

    const [row] = await ledger();
    assert.deepEqual([row.status, row.resend_id, row.attempts], ['sent', 're_1', 1]);

    const second = await go(w);
    assert.deepEqual([second.code, second.claimed, second.sent], [0, 0, 0]);
    assert.equal(w.resend.length, 1, 'no second message');
  });

  it('greets an account with no usable first name as "Hey," in the sent payload', async () => {
    // The default fixture display name is its handle, welcome_<n>, which is exactly the
    // case: a handle is never used as a name, so the greeting falls back to the bare word.
    await t.exec(OPEN_COHORT_SQL);
    await person();
    const w = world();
    const result = await go(w);
    assert.equal(result.code, 0);
    assert.equal(w.resend.length, 1);
    const [{ body }] = w.resend;
    assert.match(body.text, /^Hey,\n\nThanks for giving bingd a shot!/, 'the text part falls back to Hey,');
    assert.match(body.html, />Hey,<\/p>/, 'the HTML part falls back to Hey,');
    assert.doesNotMatch(body.html + body.text, /Hey welcome_|\{\{firstName\}\}/, 'a handle or a raw token reached the greeting');
  });

  it('sends a recipient who never tapped Invite friends their newly ensured link, once', async () => {
    await t.exec(OPEN_COHORT_SQL);
    const newcomer = await person({ invite: false, displayName: 'Bo Diddley' });
    const w = world();
    const tokens = await tokenCount();

    const first = await go(w);
    assert.deepEqual([first.code, first.sent], [0, 1]);
    const token = await liveToken(newcomer.id);
    assert.match(token, /^[0-9a-f]{32}$/);
    assert.equal(await tokenCount(), tokens + 1);
    assert.ok(w.resend[0].body.html.includes(`href="https://bingd.app/i/${token}"`));
    assert.ok(w.resend[0].body.text.includes(`https://bingd.app/i/${token}`));

    const second = await go(w);
    assert.deepEqual([second.claimed, second.sent], [0, 0]);
    assert.equal(await tokenCount(), tokens + 1, 'a second run mints nothing');
  });

  it('touches nothing and calls Resend never while delivery is off', async () => {
    await t.exec(OPEN_COHORT_SQL);
    await t.exec(`update app_config set value = 'false'::jsonb where key = 'welcome.delivery_enabled'`);
    await person();
    const w = world();
    const result = await go(w);
    assert.deepEqual([result.code, result.claimed], [0, 0]);
    assert.equal(w.resend.length, 0);
    assert.deepEqual(await ledger(), []);
  });

  it('retries a Resend failure on the next run with the same idempotency key', async () => {
    await t.exec(OPEN_COHORT_SQL);
    const bo = await person();
    const w = world({ resendReplies: [{ status: 500, body: { message: 'boom' } }] });

    const first = await go(w);
    assert.deepEqual([first.code, first.failed], [1, 1]);
    assert.equal((await ledger())[0].status, 'failed');

    const second = await go(w);
    assert.deepEqual([second.code, second.sent], [0, 1]);
    assert.equal(w.resend.length, 2);
    assert.equal(w.resend[0].headers['Idempotency-Key'], w.resend[1].headers['Idempotency-Key']);
    assert.equal(w.resend[1].headers['Idempotency-Key'], `welcome-v1-${bo.id}`);
    assert.deepEqual((await ledger()).map((r) => [r.status, r.attempts]), [['sent', 2]]);
  });

  it('treats a network failure as a failure, not a success', async () => {
    await t.exec(OPEN_COHORT_SQL);
    await person();
    const w = world({ resendReplies: [new Error('socket hang up')] });
    const result = await go(w);
    assert.deepEqual([result.code, result.sent, result.failed], [1, 0, 1]);
    assert.match((await ledger())[0].failed_reason, /socket hang up/);
  });

  it('leaves an unrecordable send claimed, reports it, and never sends it again', async () => {
    await t.exec(OPEN_COHORT_SQL);
    await person();
    const broken = world({ failRecord: true });
    const first = await go(broken);
    assert.deepEqual([first.code, first.sent, first.unrecorded], [1, 1, 1]);
    assert.equal((await ledger())[0].status, 'claimed');

    const healthy = world();
    const second = await go(healthy);
    assert.equal(second.claimed, 0);
    assert.equal(healthy.resend.length, 0);
  });

  /**
   * One gate per test, so a case cannot pass because some *other* gate stopped the run.
   * The postal address left this table when it left `copy.json` — it is the suite below.
   */
  for (const [label, change, reason] of [
    ['is not approved', (copy) => { copy.letter.status = 'DRAFT'; }, /APPROVED/],
  ]) {
    it(`refuses the cohort, before claiming anybody, while the copy ${label}`, async () => {
      await t.exec(OPEN_COHORT_SQL);
      await person();
      const blocked = await approvedRoot(change);
      try {
        const w = world();
        const result = await go(w, [], { root: blocked });
        assert.equal(result.code, 1);
        assert.match(result.reason, reason);
        assert.deepEqual(w.rpcs, []);
        assert.deepEqual(await ledger(), []);
      } finally {
        await rm(blocked, { recursive: true, force: true });
      }
    });
  }

  /**
   * THE POSTAL ADDRESS GATE, AND WHAT MATTERS IS *WHEN* IT REFUSES.
   *
   * `postalAddressFrom` is unit-tested in `emails/welcome/email.test.mjs`; what can only be
   * said here, against the real SQL, is that the refusal happens **before a single claim**.
   * That is the difference between a forgotten secret costing nothing and it costing every
   * account in the window their one chance at this note — a claimed row is never re-offered,
   * so a run that claimed and then failed to render would burn the cohort silently.
   *
   * Asserted as `rpcs: []` and an empty ledger, not as an exit code.
   */
  for (const [label, postal] of [
    ['missing', undefined],
    ['blank', ''],
    ['whitespace only', '   \n  '],
    ['still a placeholder', '[POSTAL ADDRESS - FOUNDER TO SUPPLY]'],
  ]) {
    it(`refuses the cohort, before claiming anybody, while WELCOME_POSTAL_ADDRESS is ${label}`, async () => {
      await t.exec(OPEN_COHORT_SQL);
      await person();
      const env = { ...ENV };
      if (postal === undefined) delete env.WELCOME_POSTAL_ADDRESS;
      else env.WELCOME_POSTAL_ADDRESS = postal;

      const w = world();
      const result = await go(w, [], { env });
      assert.equal(result.code, 1);
      assert.match(result.reason, /WELCOME_POSTAL_ADDRESS/);
      assert.deepEqual(w.rpcs, [], 'nothing was claimed');
      assert.deepEqual(await ledger(), [], 'nobody was consumed');
      assert.equal(w.resend.length, 0);
    });
  }

  it('renders the supplied address into both parts, escaped in the HTML, and never logs it', async () => {
    await t.exec(OPEN_COHORT_SQL);
    await person();

    // An ampersand is ordinary in a building name; the tag is the hostile case. This value
    // arrives from outside the repository, so it is the one part of the letter that could
    // inject markup into every message.
    const address = 'Suite <b>4</b> & Co, 5 Test Road, Testville TS1 2AB';
    const lines = [];
    const w = world();
    const result = await go(w, [], {
      env: { ...ENV, WELCOME_POSTAL_ADDRESS: address },
      log: (line) => lines.push(line),
    });

    assert.equal(result.code, 0);
    assert.equal(w.resend.length, 1);
    const sent = w.resend[0].body;

    assert.match(sent.text, /Suite <b>4<\/b> & Co, 5 Test Road/, 'the text part carries it literally');
    assert.equal(sent.html.includes('<b>4</b>'), false, 'raw markup reached the HTML part');
    assert.match(sent.html, /Suite &lt;b&gt;4&lt;\/b&gt; &amp; Co, 5 Test Road/, 'the HTML part is escaped');

    // A refusal message names the variable; a successful run says nothing about it either.
    const printed = lines.join(String.fromCharCode(10));
    assert.equal(printed.includes('Test Road'), false, 'the address was printed to the log');
    assert.equal(printed.includes(address), false, 'the address was printed to the log');
  });

  it('refuses before claiming anybody when dist/ was not rebuilt after a copy edit', async () => {
    await t.exec(OPEN_COHORT_SQL);
    await person();
    const stale = await approvedRoot();
    try {
      const copy = JSON.parse(await readFile(join(stale, 'copy.json'), 'utf8'));
      copy.closer = 'An edit nobody rebuilt.';
      await writeFile(join(stale, 'copy.json'), JSON.stringify(copy));
      const w = world();
      const result = await go(w, [], { root: stale });
      assert.equal(result.code, 1);
      assert.match(result.reason, /stale/);
      assert.deepEqual(w.rpcs, []);
    } finally {
      await rm(stale, { recursive: true, force: true });
    }
  });

  it('dry run: shows who would be claimed, needs no Resend key, and claims nobody', async () => {
    await t.exec(OPEN_COHORT_SQL);
    const due = await person();
    const w = world();
    const lines = [];
    const result = await run({
      argv: ['--dry-run'],
      env: { SUPABASE_URL: ENV.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: ENV.SUPABASE_SERVICE_ROLE_KEY },
      fetch: w.fetch,
      log: (line) => lines.push(line),
      root,
    });
    assert.equal(result.code, 0);
    assert.equal(result.wouldClaim, 1);
    assert.ok(lines.some((l) => l.includes(`@${due.username}`)));
    assert.equal(lines.join('\n').includes(due.email), false, 'no address in the log');

    // WHICH PROJECT, AND NOT THE KEY. The operator rehearsal deliberately shortens the
    // signup window on staging, so the one thing the output has to make unmissable is
    // which backend is being shortened. A project ref is public (it is in every client
    // build); the service-role key on the line below it is not, and must never be echoed.
    const printed = lines.join(String.fromCharCode(10));
    const ref = new URL(ENV.SUPABASE_URL).hostname.split(String.fromCharCode(46))[0];
    assert.match(printed, new RegExp(`project\\s+${ref}`), 'names the project it is about to act on');
    assert.equal(
      printed.includes(ENV.SUPABASE_SERVICE_ROLE_KEY),
      false,
      'the service-role key is never printed',
    );
    assert.deepEqual(w.rpcs, ['welcome_email_preview']);
    assert.equal(w.resend.length, 0);
    assert.deepEqual(await ledger(), []);
  });

  it('canary on the real draft copy: one send to the test account, then zero, with the cohort untouched', async () => {
    await person();
    const canary = await person({ hoursAgo: 1, email: 'Founder.Test@Example.com' });
    await t.sql(`update app_config set value = '["founder.test@example.com"]'::jsonb where key = 'welcome.canary_addresses'`);
    const w = world();
    const argv = ['--canary', canary.id, '--canary-email', 'founder.test@example.com'];

    const first = await go(w, argv, { root: welcomeRoot });
    assert.equal(first.code, 0, first.reason);
    assert.deepEqual([first.claimed, first.sent], [1, 1]);
    assert.deepEqual(w.resend[0].body.to, ['founder.test@example.com']);
    assert.equal(w.resend[0].headers['Idempotency-Key'], `welcome-v1-${canary.id}`);

    const second = await go(w, argv, { root: welcomeRoot });
    assert.deepEqual([second.code, second.claimed, second.sent], [0, 0, 0]);
    assert.equal(w.resend.length, 1);

    const rows = await ledger();
    assert.deepEqual(rows.map((r) => [r.user_id, r.status, r.canary]), [[canary.id, 'sent', true]]);
  });

  it('refuses a canary with half its arguments before touching the network', async () => {
    const w = world();
    for (const argv of [['--canary', '00000000-0000-0000-0000-000000000000'], ['--canary-email', 'a@b.co'], ['--canary', 'nope', '--canary-email', 'a@b.co']]) {
      const result = await go(w, argv);
      assert.equal(result.code, 2, argv.join(' '));
    }
    assert.deepEqual(w.rpcs, []);
  });
});
