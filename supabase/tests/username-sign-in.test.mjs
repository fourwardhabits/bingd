import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Username sign-in, the database half (20261117000100). The Edge Function's own tests
 * cover the response shape and timing; these cover what the function cannot see:
 * who may touch the tables, which accounts a name resolves to, and the limits.
 *
 * Every call to the four functions is made as `service_role`, which is the only role
 * that holds EXECUTE, so a privilege regression fails here and not only in the sweep.
 */

const hex = (s) => createHash('sha256').update(s).digest('hex');
let seq = 0;
const fresh = (label = 'x') => hex(`${label}:${++seq}:${Math.random()}`);

let t;

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

beforeEach(async () => {
  await t.sql(`delete from auth_username_attempts`);
  await t.sql(`delete from auth_username_challenges`);
});

/** An ordinary, eligible account: confirmed email, active, not banned. */
async function account(username, email = `${username}@example.test`) {
  const id = await t.createUser({ username });
  await t.sql(`update auth.users set email = $2, email_confirmed_at = now() where id = $1`, [
    id,
    email,
  ]);
  return id;
}

const asService = (query, params) => t.asRole('service_role', null, () => t.sql(query, params));

async function send(username, { identifier = hex(`id:${username}`), ip = hex('ip:1'), challenge = fresh('c') } = {}) {
  const { rows } = await asService(`select username_sign_in_send($1, $2, $3, $4) as r`, [
    username,
    identifier,
    ip,
    challenge,
  ]);
  return { ...rows[0].r, challenge };
}

async function begin(challenge, ip = hex('ip:1')) {
  const { rows } = await asService(`select username_sign_in_verify_begin($1, $2) as r`, [
    challenge,
    ip,
  ]);
  return rows[0].r;
}

async function finish(challenge, userId) {
  const { rows } = await asService(`select username_sign_in_verify_finish($1, $2) as r`, [
    challenge,
    userId,
  ]);
  return rows[0].r;
}

describe('who can reach the tables', () => {
  for (const table of ['auth_username_challenges', 'auth_username_attempts']) {
    it(`${table} has RLS on and no policy`, async () => {
      const { rows } = await t.sql(
        `select c.relrowsecurity as rls,
                (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
           from pg_class c where c.relname = $1 and c.relnamespace = 'public'::regnamespace`,
        [table],
      );
      assert.deepEqual(rows[0], { rls: true, policies: 0 });
    });

    for (const role of ['anon', 'authenticated', 'service_role']) {
      it(`${table} grants nothing to ${role}`, async () => {
        const { rows } = await t.sql(
          `select p from unnest(array['select','insert','update','delete','truncate','references','trigger']) p
            where has_table_privilege($1, $2, p)`,
          [role, `public.${table}`],
        );
        assert.deepEqual(rows, [], `${role} holds a privilege on ${table}`);
      });
    }

    for (const role of ['anon', 'authenticated']) {
      it(`${table} cannot be read or written by ${role}`, async () => {
        const read = await t.asRole(role, null, () => t.errorFrom(`select * from ${table}`));
        assert.ok(read, `${role} read ${table}`);
        assert.match(read.message, /permission denied/);
        const write = await t.asRole(role, null, () =>
          t.errorFrom(`delete from ${table}`),
        );
        assert.ok(write, `${role} wrote ${table}`);
      });
    }
  }
});

describe('who can call the functions', () => {
  const signatures = [
    'username_sign_in_send(text,text,text,text)',
    'username_sign_in_verify_begin(text,text)',
    'username_sign_in_verify_finish(text,uuid)',
    'username_sign_in_purge()',
  ];

  for (const sig of signatures) {
    it(`${sig} is service role only`, async () => {
      const { rows } = await t.sql(
        `select has_function_privilege('anon', $1, 'execute') as anon,
                has_function_privilege('authenticated', $1, 'execute') as authenticated,
                has_function_privilege('service_role', $1, 'execute') as service`,
        [sig],
      );
      assert.deepEqual(rows[0], { anon: false, authenticated: false, service: true });
    });
  }

  it('the resolver is callable by nobody but its owner', async () => {
    const { rows } = await t.sql(
      `select has_function_privilege(r, '_username_sign_in_account(uuid,text)', 'execute') as ok
         from unnest(array['anon','authenticated','service_role']) r`,
    );
    assert.deepEqual(rows.map((r) => r.ok), [false, false, false]);
  });

  it('a signed-in client is refused send outright', async () => {
    const user = await account('caller_x');
    const err = await t.asUser(user, () =>
      t.errorFrom(`select username_sign_in_send('caller_x', $1, $1, $1)`, [hex('a')]),
    );
    assert.ok(err);
    assert.match(err.message, /permission denied/);
  });
});

describe('which accounts a name resolves to', () => {
  it('a current username with a confirmed email resolves, server-side only', async () => {
    await account('alice_r', 'alice.r@example.test');
    const r = await send('alice_r');
    assert.equal(r.outcome, 'send');
    assert.equal(r.email, 'alice.r@example.test');
  });

  it('normalises like create_profile: trim and case', async () => {
    await account('casey_r');
    assert.equal((await send('  CaSeY_R ')).outcome, 'send');
  });

  it('an unknown name is a miss and stores a decoy with no account', async () => {
    const r = await send('nobody_here');
    assert.deepEqual({ outcome: r.outcome, email: r.email }, { outcome: 'miss', email: undefined });
    const { rows } = await t.sql(`select user_id, sent_at from auth_username_challenges where id_hash = $1`, [
      r.challenge,
    ]);
    assert.deepEqual(rows, [{ user_id: null, sent_at: null }]);
  });

  it('a malformed name is a miss, not an error', async () => {
    for (const bad of ['ab', 'a'.repeat(25), 'has space', 'semi;colon', '', null]) {
      assert.equal((await send(bad, { identifier: fresh('i') })).outcome, 'miss', String(bad));
    }
  });

  for (const [what, patch] of [
    ['an unconfirmed email', `email_confirmed_at = null`],
    ['a banned account', `banned_until = now() + interval '1 day'`],
    ['a soft-deleted account', `deleted_at = now()`],
    ['an anonymous account', `is_anonymous = true`],
    ['an empty email', `email = ''`],
    ['no email at all', `email = null`],
  ]) {
    it(`${what} is a miss`, async () => {
      const name = `inel_${seq++}`;
      const id = await account(name);
      await t.sql(`update auth.users set ${patch} where id = $1`, [id]);
      const r = await send(name);
      assert.equal(r.outcome, 'miss');
      assert.equal(r.email, undefined);
    });
  }

  it('an expired ban resolves again', async () => {
    const id = await account('was_banned');
    await t.sql(`update auth.users set banned_until = now() - interval '1 minute' where id = $1`, [id]);
    assert.equal((await send('was_banned')).outcome, 'send');
  });

  it('a suspended profile is a miss', async () => {
    const id = await account('suspended_r');
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [id]);
    assert.equal((await send('suspended_r')).outcome, 'miss');
  });

  it('an Apple private-relay address resolves to the relay address', async () => {
    await account('relay_user', 'abc123xyz@privaterelay.appleid.com');
    const r = await send('relay_user');
    assert.equal(r.outcome, 'send');
    assert.equal(r.email, 'abc123xyz@privaterelay.appleid.com');
  });

  it('after a rename the old name never resolves, even inside redirect_until, and the new one does', async () => {
    const id = await account('old_name');
    await t.sql(`update profiles set username = 'new_name' where id = $1`, [id]);
    const { rows } = await t.sql(
      `select redirect_until > now() as open from username_history where username = 'old_name'`,
    );
    assert.deepEqual(rows, [{ open: true }], 'fixture: the redirect window should still be open');

    assert.equal((await send('old_name')).outcome, 'miss');
    assert.equal((await send('new_name')).outcome, 'send');
  });
});

describe('send limits', () => {
  it('three admitted sends per identifier per hour, then limited without being recorded', async () => {
    const identifier = hex('id:limited_name');
    const outcomes = [];
    for (let i = 0; i < 5; i++) {
      outcomes.push((await send('limited_name', { identifier, ip: fresh('ip') })).outcome);
    }
    assert.deepEqual(outcomes, ['miss', 'miss', 'miss', 'limited', 'limited']);
    const { rows } = await t.sql(
      `select count(*)::int as n from auth_username_attempts where identifier_hash = $1`,
      [identifier],
    );
    assert.equal(rows[0].n, 3);
  });

  it('the identifier window slides: an hour later it is admitted again', async () => {
    const identifier = hex('id:sliding');
    for (let i = 0; i < 3; i++) await send('sliding', { identifier, ip: fresh('ip') });
    assert.equal((await send('sliding', { identifier, ip: fresh('ip') })).outcome, 'limited');
    await t.sql(`update auth_username_attempts set at = at - interval '61 minutes'`);
    assert.equal((await send('sliding', { identifier, ip: fresh('ip') })).outcome, 'miss');
  });

  it('ten admitted sends per IP per hour, across different names', async () => {
    const ip = hex('ip:busy');
    const outcomes = [];
    for (let i = 0; i < 12; i++) {
      outcomes.push((await send(`name_${i}`, { identifier: fresh('i'), ip })).outcome);
    }
    assert.deepEqual(outcomes.slice(0, 10), Array(10).fill('miss'));
    assert.deepEqual(outcomes.slice(10), ['limited', 'limited']);
  });

  it('a limited send against a real account stores no challenge and sends nothing', async () => {
    await account('flooded');
    const identifier = hex('id:flooded');
    for (let i = 0; i < 3; i++) {
      await t.sql(
        `insert into auth_username_attempts (kind, identifier_hash, ip_hash) values ('send', $1, $2)`,
        [identifier, fresh('ip')],
      );
    }
    const r = await send('flooded', { identifier, ip: fresh('ip') });
    assert.deepEqual({ outcome: r.outcome, email: r.email }, { outcome: 'limited', email: undefined });
    const { rows } = await t.sql(`select 1 from auth_username_challenges where id_hash = $1`, [
      r.challenge,
    ]);
    assert.equal(rows.length, 0);
  });

  it('one email per account per minute: a second send inside the cooldown shares the code', async () => {
    const id = await account('double_tap');
    const first = await send('double_tap', { ip: fresh('ip') });
    assert.equal(first.outcome, 'send');
    assert.equal((await begin(first.challenge)).outcome, 'check'); // one guess spent

    const second = await send('double_tap', { ip: fresh('ip') });
    assert.equal(second.outcome, 'cooldown');
    assert.equal(second.email, undefined, 'no address when nothing is to be sent');

    const { rows } = await t.sql(
      `select id_hash, consumed_at is not null as dead, attempts, sent_at, expires_at
         from auth_username_challenges where user_id = $1 order by created_at, dead desc`,
      [id],
    );
    const byHash = Object.fromEntries(rows.map((r) => [r.id_hash, r]));
    assert.equal(byHash[first.challenge].dead, true, 'the earlier challenge is superseded');
    assert.equal(byHash[second.challenge].dead, false);
    assert.equal(byHash[second.challenge].attempts, 1, 'spent guesses carry over');
    assert.deepEqual(byHash[second.challenge].expires_at, byHash[first.challenge].expires_at);
    assert.deepEqual(byHash[second.challenge].sent_at, byHash[first.challenge].sent_at);
  });

  it('after the cooldown a new send is a new code with a fresh budget', async () => {
    await account('after_cool');
    const first = await send('after_cool', { ip: fresh('ip') });
    await t.sql(`update auth_username_challenges set sent_at = sent_at - interval '61 seconds'`);
    const second = await send('after_cool', { ip: fresh('ip') });
    assert.equal(second.outcome, 'send');
    assert.equal((await begin(first.challenge)).outcome, 'invalid', 'the old challenge is dead');
    assert.equal((await begin(second.challenge)).outcome, 'check');
  });

  it('rejects a malformed hash rather than storing it', async () => {
    const err = await t.asRole('service_role', null, () =>
      t.errorFrom(`select username_sign_in_send('alice', 'nothex', $1, $1)`, [hex('a')]),
    );
    assert.ok(err);
    assert.match(err.message, /malformed/);
  });
});

describe('verify', () => {
  it('a real challenge checks once per attempt and locks after five', async () => {
    const id = await account('guesser_target');
    const { challenge } = await send('guesser_target');
    for (let i = 0; i < 5; i++) {
      const r = await begin(challenge, fresh('ip'));
      assert.equal(r.outcome, 'check');
      assert.equal(r.user_id, id);
      assert.equal(r.email, 'guesser_target@example.test');
    }
    assert.deepEqual(await begin(challenge, fresh('ip')), { outcome: 'invalid' });
  });

  it('a decoy never verifies and never yields an address', async () => {
    const { challenge } = await send('ghost_user');
    for (let i = 0; i < 6; i++) {
      assert.deepEqual(await begin(challenge, fresh('ip')), { outcome: 'invalid' });
    }
    assert.equal(await finish(challenge, '00000000-0000-0000-0000-000000000000'), false);
  });

  it('an unknown challenge is invalid', async () => {
    assert.deepEqual(await begin(fresh('nothing')), { outcome: 'invalid' });
  });

  it('an expired challenge is invalid', async () => {
    await account('slowpoke');
    const { challenge } = await send('slowpoke');
    await t.sql(`update auth_username_challenges set expires_at = now() - interval '1 second'`);
    assert.deepEqual(await begin(challenge), { outcome: 'invalid' });
  });

  it('finish is single use, and only for the account the challenge belongs to', async () => {
    const id = await account('single_use');
    const other = await account('someone_else');
    const { challenge } = await send('single_use');
    assert.equal((await begin(challenge)).outcome, 'check');
    assert.equal(await finish(challenge, other), false);
    assert.equal(await finish(challenge, id), true);
    assert.equal(await finish(challenge, id), false);
    assert.deepEqual(await begin(challenge), { outcome: 'invalid' });
  });

  it('a ban between send and verify is honoured', async () => {
    const id = await account('banned_later');
    const { challenge } = await send('banned_later');
    await t.sql(`update auth.users set banned_until = now() + interval '1 day' where id = $1`, [id]);
    assert.deepEqual(await begin(challenge), { outcome: 'invalid' });
  });

  it('thirty verifies per IP per hour, then limited without being recorded', async () => {
    const ip = hex('ip:verifier');
    const outcomes = [];
    for (let i = 0; i < 32; i++) outcomes.push((await begin(fresh('c'), ip)).outcome);
    assert.deepEqual(outcomes.slice(0, 30), Array(30).fill('invalid'));
    assert.deepEqual(outcomes.slice(30), ['limited', 'limited']);
    const { rows } = await t.sql(
      `select count(*)::int as n from auth_username_attempts where ip_hash = $1 and kind = 'verify'`,
      [ip],
    );
    assert.equal(rows[0].n, 30);
  });

  it('deleting the account deletes its challenges', async () => {
    const id = await account('leaving');
    const { challenge } = await send('leaving');
    await t.sql(`delete from auth.users where id = $1`, [id]);
    const { rows } = await t.sql(`select 1 from auth_username_challenges where id_hash = $1`, [
      challenge,
    ]);
    assert.equal(rows.length, 0);
  });
});

describe('retention', () => {
  it('purges rows older than 24 hours on the next call, and keeps younger ones', async () => {
    await send('old_one', { identifier: hex('id:old') });
    await t.sql(`update auth_username_attempts set at = now() - interval '25 hours'`);
    await t.sql(`update auth_username_challenges set created_at = now() - interval '25 hours'`);
    await send('young_one', { identifier: hex('id:young') });

    const attempts = await t.sql(`select identifier_hash from auth_username_attempts`);
    assert.deepEqual(attempts.rows.map((r) => r.identifier_hash), [hex('id:young')]);
    const challenges = await t.sql(`select count(*)::int as n from auth_username_challenges`);
    assert.equal(challenges.rows[0].n, 1);
  });

  it('stores no identifier, address or IP in clear', async () => {
    await account('clear_check', 'clear.check@example.test');
    await send('clear_check', { identifier: hex('id:clear_check'), ip: hex('ip:203.0.113.9') });
    const { rows } = await t.sql(
      `select row_to_json(a)::text as j from auth_username_attempts a
       union all select row_to_json(c)::text from auth_username_challenges c`,
    );
    for (const { j } of rows) {
      assert.doesNotMatch(j, /clear_check|clear\.check|example\.test|203\.0\.113/);
    }
  });
});
