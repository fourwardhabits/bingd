import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Environment identity, 20260826000100.
 *
 * WHAT IS ACTUALLY BEING PROTECTED
 *
 * `app_config['env.name']` is not a tuning value. `create_invite_link` stamps it onto every
 * token it mints (20260817001300) and `redeem_invite` refuses a token from the other
 * environment, which is PRD §17. So the key decides, for every invitation anybody is
 * holding, which database it is an invitation to.
 *
 * A replay from zero seeds `nonprod`. That is correct for the harness and for the friend
 * Beta and it is a **trap for production**, which comes up believing it is nonprod unless
 * something says otherwise. This file is the contract for the thing that says otherwise,
 * and the tests that matter are the refusals.
 */

let t;

const envName = async () => (await t.sql(`select environment_name() as e`)).rows[0].e;

const setEnv = async (name) =>
  (await t.sql(`select set_environment_name($1) as r`, [name])).rows[0].r;

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

/**
 * Back to what a replay from zero produces. One database for the file, because replaying
 * seventy-odd migrations per test costs more than these three statements — and because the
 * first assertion below is precisely that this state is what a bare replay leaves behind.
 */
beforeEach(async () => {
  await t.sql(`delete from invite_tokens`);
  await t.sql(`delete from profiles`);
  await t.sql(`update app_config set value = '"nonprod"'::jsonb where key = 'env.name'`);
});

// ---------------------------------------------------------------------------

describe('environment_name', () => {
  /**
   * The trap itself, asserted rather than described. If this ever comes back `prod` from a
   * bare replay, the bootstrap step below has been quietly made unnecessary by a migration
   * edit — which is exactly the history rewrite `20260826000100` refused to make.
   */
  it('a database replayed from zero calls itself nonprod', async () => {
    assert.equal(await envName(), 'nonprod');
  });

  it('is readable signed out, because the release gate has no other credential', async () => {
    await t.asAnon(async () => {
      const { rows } = await t.sql(`select environment_name() as e`);
      assert.equal(rows[0].e, 'nonprod');
    });
  });

  /**
   * The key itself stays closed. `app_config`'s read policy is `key like 'public.%'`, and
   * one named function returning one scalar is a smaller surface than a public config key
   * whose neighbours would then also have to be audited.
   */
  it('does not open app_config to a client', async () => {
    await t.asAnon(async () => {
      const { rows } = await t.sql(`select count(*)::int as n from app_config where key = 'env.name'`);
      assert.equal(rows[0].n, 0, 'env.name is readable as a config row');
    });
  });
});

// ---------------------------------------------------------------------------

describe('set_environment_name', () => {
  it('names an empty database, and says what it was', async () => {
    const result = await setEnv('prod');
    assert.equal(result.status, 'ok');
    assert.equal(result.was, 'nonprod');
    assert.equal(await envName(), 'prod');
  });

  /**
   * A bootstrap step that cannot be re-run is one somebody runs once, wrongly, and then
   * works around. Re-running it has to be free.
   */
  it('is idempotent', async () => {
    await setEnv('prod');
    const again = await setEnv('prod');
    assert.equal(again.status, 'unchanged');
    assert.equal(await envName(), 'prod');
  });

  it('refuses anything that is not one of the two environments', async () => {
    for (const bad of ['production', 'PROD', 'staging', '']) {
      assert.ok(await t.errorFrom(`select set_environment_name($1)`, [bad]), `${bad} was accepted`);
    }
    assert.ok(await t.errorFrom(`select set_environment_name(null)`));
    assert.equal(await envName(), 'nonprod', 'a refused call still changed the answer');
  });

  /**
   * **The refusal this function exists for.**
   *
   * Renaming the friend-Beta database `prod` would make every invite token it has already
   * minted — stamped `nonprod` — start resolving as a production token, and would make a
   * database full of Beta accounts pass every check written to keep the two apart. It is
   * one `update` away if identity is an ordinary config write, which is why it is not one.
   */
  it('refuses to rename a database that already has people in it', async () => {
    await t.createUser({ username: 'already_here' });

    const error = await t.errorFrom(`select set_environment_name('prod')`);
    assert.ok(error, 'a live database was renamed');
    assert.match(String(error.message ?? error), /already in use/i);
    assert.equal(await envName(), 'nonprod');
  });

  /**
   * And it says which of the two counts stopped it, because "refused" with no number is a
   * message somebody overrides rather than reads.
   */
  it('names what it found', async () => {
    const owner = await t.createUser({ username: 'token_owner' });
    await t.sql(
      `insert into invite_tokens (owner_id, token, short_code, env)
       values ($1, 'deadbeefdeadbeefdeadbeefdeadbeef', 'AAAAAAAA', 'nonprod')`,
      [owner],
    );

    const error = await t.errorFrom(`select set_environment_name('prod')`);
    assert.match(String(error.message ?? error), /1 profiles, 1 invite tokens/);
  });

  it('is unreachable by a client role', async () => {
    for (const as of ['asAnon', 'asUser']) {
      const user = as === 'asUser' ? await t.createUser({ username: 'nosy' }) : null;
      const run = (fn) => (user ? t.asUser(user, fn) : t.asAnon(fn));
      const error = await run(() => t.errorFrom(`select set_environment_name('prod')`));
      assert.ok(error, `${as} could rename the database`);
    }
  });
});

// ---------------------------------------------------------------------------

describe('the invite stamp follows the environment', () => {
  /**
   * The consequence, end to end, so that nothing above is only true of a config key.
   * `create_invite_link` reads `env.name` at mint time — so a production database that was
   * never bootstrapped mints tokens a production client will refuse.
   */
  it('mints a token stamped with whatever the database says it is', async () => {
    await setEnv('prod');
    const user = await t.createUser({ username: 'inviter' });

    await t.asUser(user, async () => {
      await t.sql(`select create_invite_link(gen_random_uuid(), null)`);
    });

    const { rows } = await t.sql(`select env from invite_tokens where owner_id = $1`, [user]);
    assert.equal(rows[0].env, 'prod');
  });
});
