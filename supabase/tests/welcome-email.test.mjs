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

/** An account with a confirmed address that signed up `hoursAgo` hours ago. */
const person = async ({
  hoursAgo = 40,
  email,
  confirmed = true,
  status = 'active',
  banned = false,
  deleted = false,
  anonymous = false,
  displayName,
} = {}) => {
  seq += 1;
  const username = `welcome_${seq}`;
  const id = await t.createUser({ username });
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
    update app_config set value = '36'::jsonb where key = 'welcome.delay_hours';
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
      'welcome.delay_hours': 36,
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
      for (const helper of [`select * from _welcome_email_candidates(1)`, `select _welcome_email_can_receive(gen_random_uuid())`, `select _welcome_email_in_scope(gen_random_uuid(), null, null)`]) {
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
    const tooSoon = await person({ hoursAgo: 35 });
    const due = await person({ hoursAgo: 37 });
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
};

/**
 * A copy of the welcome directory with the copy approved and a postal address set, built
 * by the real `build.mjs`, so the worker reads a manifest and a template it did not have
 * a hand in faking.
 */
async function approvedRoot(change = () => {}) {
  const dir = await mkdtemp(join(tmpdir(), 'welcome-approved-'));
  const copy = JSON.parse(await readFile(join(welcomeRoot, 'copy.json'), 'utf8'));
  copy.note.status = 'APPROVED';
  copy.footer.postalAddress = 'PO Box 1, Testville';
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

    const first = await go(w);
    assert.equal(first.code, 0);
    assert.deepEqual([first.claimed, first.sent, first.failed, first.unrecorded], [1, 1, 0, 0]);
    assert.equal(w.resend.length, 1);

    const [{ headers, body }] = w.resend;
    assert.equal(headers['Idempotency-Key'], `welcome-v1-${ada.id}`);
    assert.deepEqual(body.to, [ada.email]);
    assert.equal(body.from, 'Suraj from bingd. <suraj@bingd.app>');
    assert.equal(body.reply_to, 'suraj@bingd.app');
    assert.equal(body.subject, 'I built bingd. Tell me what you think.');
    assert.deepEqual(body.headers, { 'List-Unsubscribe': '<mailto:suraj@bingd.app?subject=Unsubscribe>' });
    assert.match(body.html, /Hi Ada,/);
    assert.match(body.text, /^Hi Ada,/);
    assert.doesNotMatch(body.html + body.text, /\{\{/);
    assert.match(body.html, /PO Box 1, Testville/);

    const [row] = await ledger();
    assert.deepEqual([row.status, row.resend_id, row.attempts], ['sent', 're_1', 1]);

    const second = await go(w);
    assert.deepEqual([second.code, second.claimed, second.sent], [0, 0, 0]);
    assert.equal(w.resend.length, 1, 'no second message');
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
   * One gate per test. The committed copy fails both gates at once, so a test run against
   * it alone passes with either gate deleted; each case below fails exactly one.
   */
  for (const [label, change, reason] of [
    ['has no postal address', (copy) => { copy.footer.postalAddress = null; }, /postalAddress/],
    ['is still a draft', (copy) => { copy.note.status = 'DRAFT - FOUNDER TO EDIT'; }, /APPROVED/],
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
