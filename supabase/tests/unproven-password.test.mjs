import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * **H-2: a password set before the address was proven does not survive its proof**
 * (migration 20261124000100).
 *
 * These hold the trigger's rule: which confirmations replace the password and which leave
 * it alone. The hash itself is pgcrypto's, stubbed here because PGlite has no pgcrypto; the
 * real bcrypt, and Supabase Auth's own sign-in refusing the stranger's password and
 * accepting an operator's, were verified on staging against Auth v2.197.0 (see
 * docs/release/h2-preregistration-takeover.md).
 */

let t;

before(async () => {
  t = await createTestDb();
  await t.exec(`
    alter table auth.users add column if not exists encrypted_password varchar(255);
    alter table auth.users add column if not exists confirmation_sent_at timestamptz;
    alter table auth.users add column if not exists recovery_sent_at timestamptz;

    create schema if not exists extensions;
    create or replace function extensions.gen_random_bytes(integer) returns bytea
      language sql volatile as $$ select decode(md5(random()::text), 'hex') $$;
    create or replace function extensions.gen_salt(text, integer) returns text
      language sql as $$ select '$2a$10$stubsalt' $$;
    create or replace function extensions.crypt(text, text) returns text
      language sql as $$ select $2 || md5($1) $$;
  `);
});

after(async () => {
  await t?.close();
});

const ATTACKER = '$2a$10$the-strangers-own-password-hash';

const account = async ({
  confirmationSent = false,
  recoverySent = false,
  confirmed = false,
} = {}) => {
  const { rows } = await t.sql(
    `insert into auth.users (id, email, encrypted_password, confirmation_sent_at, recovery_sent_at, email_confirmed_at)
     values (gen_random_uuid(), 'someone-' || gen_random_uuid() || '@example.invalid', $1,
             case when $2 then now() end, case when $3 then now() end, case when $4 then now() end)
     returning id`,
    [ATTACKER, confirmationSent, recoverySent, confirmed],
  );
  return rows[0].id;
};

const passwordOf = async (id) =>
  (await t.sql(`select encrypted_password from auth.users where id = $1`, [id])).rows[0]
    .encrypted_password;

const confirm = (id) =>
  t.sql(`update auth.users set email_confirmed_at = now() where id = $1`, [id]);

describe('the owner proving the address with an emailed code', () => {
  it('replaces a password set at sign-up when the sign-up code confirms it', async () => {
    const id = await account({ confirmationSent: true });
    await confirm(id);
    const after = await passwordOf(id);
    assert.notEqual(after, ATTACKER);
    assert.match(after, /^\$2a\$10\$/, 'a bcrypt-shaped hash, as Auth stores');
  });

  it('replaces it when a sign-in (magic link) code confirms it instead', async () => {
    const id = await account({ recoverySent: true });
    await confirm(id);
    assert.notEqual(await passwordOf(id), ATTACKER);
  });

  it('gives two accounts two different random passwords', async () => {
    const a = await account({ confirmationSent: true });
    const b = await account({ confirmationSent: true });
    await confirm(a);
    await confirm(b);
    assert.notEqual(await passwordOf(a), await passwordOf(b));
  });
});

describe('everything else is left alone', () => {
  it('keeps an operator’s password on an account created already confirmed (nothing was sent)', async () => {
    const id = await account();
    await confirm(id);
    assert.equal(await passwordOf(id), ATTACKER);
  });

  it('never touches an address that was already confirmed', async () => {
    const id = await account({ confirmationSent: true, confirmed: true });
    await t.sql(
      `update auth.users set email_confirmed_at = now() + interval '1 minute' where id = $1`,
      [id],
    );
    await t.sql(`update auth.users set encrypted_password = 'changed-later' where id = $1`, [
      id,
    ]);
    assert.equal(await passwordOf(id), 'changed-later');
  });

  it('does nothing on an update that does not confirm the address', async () => {
    const id = await account({ confirmationSent: true });
    await t.sql(`update auth.users set email = email where id = $1`, [id]);
    assert.equal(await passwordOf(id), ATTACKER);
  });

  it('leaves an account with no password without one', async () => {
    const { rows } = await t.sql(
      `insert into auth.users (id, email, confirmation_sent_at)
       values (gen_random_uuid(), 'nopw-' || gen_random_uuid() || '@example.invalid', now())
       returning id`,
    );
    await confirm(rows[0].id);
    assert.equal(await passwordOf(rows[0].id), null);
  });
});

describe('the function itself', () => {
  it('is not callable by any API role', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const { rows } = await t.sql(
        `select has_function_privilege($1, 'public.retire_unproven_password()', 'execute') as can`,
        [role],
      );
      assert.equal(rows[0].can, false, role);
    }
  });
});
