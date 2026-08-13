import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Reporting, suspension, and the guard that makes suspension mean something.
 *
 * The last two suites matter most. A suspended account that is merely hidden
 * still ranks, follows and tags into a void, and everything it did appears at
 * once the moment the suspension lifts — so the tests here check that writes are
 * actually refused, and that every write RPC invokes the guard rather than
 * merely coexisting with it.
 */

let t;
let reporter;
let offender;
let bystander;

let seq = 60000;

before(async () => {
  t = await createTestDb();
  reporter = await t.createUser({ username: 'reporter' });
  offender = await t.createUser({ username: 'offender' });
  bystander = await t.createUser({ username: 'bystander' });
  await t.actAs(reporter);
});

after(async () => {
  await t?.close();
});

const rpc = async (query, params) => (await t.sql(query, params)).rows[0].r;

describe('filing a report', () => {
  it('records one, resolving the owner server-side', async () => {
    await t.actAs(reporter);
    const r = await rpc(`select report('profile', $1, 'harassment', 'said a mean thing') as r`, [
      offender,
    ]);
    assert.equal(r.received, true);

    const { rows } = await t.sql(
      `select reporter_id, subject_owner, state, reason from reports where subject_id = $1`,
      [offender],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reporter_id, reporter);
    assert.equal(rows[0].subject_owner, offender, 'the owner must be resolved, not supplied');
    assert.equal(rows[0].state, 'open');
  });

  it('is idempotent, so reporting twice cannot be used to pile on', async () => {
    await t.actAs(bystander);
    await rpc(`select report('profile', $1, 'spam') as r`, [offender]);
    await rpc(`select report('profile', $1, 'spam') as r`, [offender]);
    const { rows } = await t.sql(
      `select count(*)::integer as n from reports where reporter_id = $1 and subject_id = $2`,
      [bystander, offender],
    );
    assert.equal(rows[0].n, 1);
  });

  it('refuses a report of your own content', async () => {
    await t.actAs(reporter);
    await assert.rejects(
      () => t.sql(`select report('profile', $1, 'spam') as r`, [reporter]),
      /your own content/i,
    );
  });

  it('refuses an unknown subject without revealing whether it exists', async () => {
    await t.actAs(reporter);
    await assert.rejects(
      () => t.sql(`select report('list', gen_random_uuid(), 'spam') as r`),
      /no such subject/i,
    );
  });

  it('rejects a reason outside the taxonomy', async () => {
    await t.actAs(reporter);
    await assert.rejects(
      () => t.sql(`select report('profile', $1, 'i just do not like them') as r`, [offender]),
      /reports_known_reason/i,
    );
  });

  it('enforces the daily ceiling', async () => {
    const spammer = await t.createUser({ username: 'over_reporter' });
    await t.sql(`update app_config set value = '2'::jsonb where key = 'report.max_per_day'`);
    await t.actAs(spammer);

    for (let i = 0; i < 2; i += 1) {
      const target = await t.createUser({ username: `target_${i}` });
      await rpc(`select report('profile', $1, 'spam') as r`, [target]);
    }

    const last = await t.createUser({ username: 'one_too_many' });
    await assert.rejects(
      () => t.sql(`select report('profile', $1, 'spam') as r`, [last]),
      /limit reached/i,
    );

    await t.sql(`update app_config set value = '20'::jsonb where key = 'report.max_per_day'`);
  });

  it('resolves the owner of a reported list rather than trusting the caller', async () => {
    const { rows } = await t.sql(
      `insert into lists (owner_id, title, visibility) values ($1, 'Bad List', 'public') returning id`,
      [offender],
    );
    await t.actAs(reporter);
    await rpc(`select report('list_title', $1, 'hate_speech') as r`, [rows[0].id]);
    const { rows: got } = await t.sql(
      `select subject_owner from reports where subject_id = $1`,
      [rows[0].id],
    );
    assert.equal(got[0].subject_owner, offender);
  });
});

describe('who can see a report', () => {
  it('shows a reporter only their own', async () => {
    const { rows } = await t.asUser(reporter, () => t.sql(`select subject_id from reports`));
    assert.ok(rows.length > 0, 'the reporter must see what they filed');
    assert.ok(
      rows.every((r) => r.subject_id !== null),
      'sanity',
    );
    const { rows: others } = await t.asUser(reporter, () =>
      t.sql(`select id from reports where reporter_id <> $1`, [reporter]),
    );
    assert.equal(others.length, 0, 'a reporter must not see other people reports');
  });

  it('never tells the reported user they were reported', async () => {
    const { rows } = await t.asUser(offender, () => t.sql(`select id from reports`));
    assert.equal(rows.length, 0);
  });

  it('keeps the moderation log operator-only', async () => {
    await t.sql(
      `insert into moderation_actions (subject_type, subject_id, action, rationale)
       values ('profile', $1, 'warn', 'first offence')`,
      [offender],
    );
    const { rows } = await t.asUser(reporter, () => t.sql(`select id from moderation_actions`));
    assert.equal(rows.length, 0);
  });
});

describe('suspension hides the account everywhere at once', () => {
  let suspended;

  before(async () => {
    suspended = await t.createUser({ username: 'suspended_one' });
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [suspended]);
  });

  it('hides a suspended public profile from other users', async () => {
    const { rows } = await t.asUser(bystander, () =>
      t.sql(`select id from profiles where id = $1`, [suspended]),
    );
    assert.equal(rows.length, 0);
  });

  it('hides it from anonymous readers too', async () => {
    const { rows } = await t.asAnon(() =>
      t.sql(`select id from profiles where id = $1`, [suspended]),
    );
    assert.equal(rows.length, 0, 'the public web pages must not serve a suspended account');
  });

  it('still lets the suspended user load their own profile', async () => {
    // So the interface can explain what happened rather than looking broken.
    const { rows } = await t.asUser(suspended, () =>
      t.sql(`select id from profiles where id = $1`, [suspended]),
    );
    assert.equal(rows.length, 1);
  });

  it('reaches every surface through the one visibility rule', async () => {
    // AD-5: feed, lists and tags all authorize through can_view_profile, so this
    // asserts the single rule rather than seven separate policies.
    const { rows } = await t.sql(`select can_view_profile($1, $2) as ok`, [bystander, suspended]);
    assert.equal(rows[0].ok, false);
  });
});

describe('a suspended account cannot write', () => {
  let suspended;
  let film;

  before(async () => {
    suspended = await t.createUser({ username: 'no_writing' });
    film = await t.createMovie('Suspended Film', seq++);
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [suspended]);
    await t.actAs(suspended);
  });

  after(async () => {
    await t.actAs(reporter);
  });

  it('refuses to start a ranking', async () => {
    await assert.rejects(
      () => t.sql(`select rank_start($1, 'loved') as r`, [film]),
      /suspended/i,
      'suspension must stop ranking, not merely hide it',
    );
  });

  it('refuses to file a report', async () => {
    await assert.rejects(
      () => t.sql(`select report('profile', $1, 'spam') as r`, [offender]),
      /suspended/i,
    );
  });

  it('refuses every other ranking mutation', async () => {
    for (const call of [
      `select rank_answer(gen_random_uuid(), gen_random_uuid()) as r`,
      `select rank_skip(gen_random_uuid()) as r`,
      `select rank_back(gen_random_uuid()) as r`,
      `select rank_unrank(gen_random_uuid()) as r`,
      `select rank_reorder(gen_random_uuid(), 1) as r`,
      `select rank_rebucket(gen_random_uuid(), 'fine') as r`,
    ]) {
      await assert.rejects(() => t.sql(call), /suspended/i, `${call} was not guarded`);
    }
  });

  it('lets the account write again once restored', async () => {
    await t.sql(`update profiles set status = 'active' where id = $1`, [suspended]);
    await t.actAs(suspended);
    const r = await rpc(`select rank_start($1, 'loved') as r`, [film]);
    assert.equal(r.done, true, 'an empty band places directly');
  });
});

describe('the guard is wired in, not merely present', () => {
  /**
   * The first draft of this migration defined assert_can_write and never called
   * it, so suspension stopped nothing while the documentation said otherwise.
   * Asserting the wiring structurally is what stops that returning: a new write
   * RPC that forgets the guard fails here rather than in production.
   */
  it('has every client-facing ranking RPC call assert_can_write', async () => {
    const { rows } = await t.sql(`
      select p.proname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname like 'rank\\_%'
         and p.prosrc not like '%assert_can_write%'
    `);
    assert.deepEqual(
      rows.map((r) => r.proname),
      [],
      'these write RPCs are reachable by a suspended account',
    );
  });

  it('does not expose the unguarded implementations to clients', async () => {
    const { rows } = await t.sql(`
      select p.proname, r.rolname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join unnest(array['anon','authenticated']) as r(rolname)
       where n.nspname = 'public'
         and p.proname like '%\\_unguarded'
         and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
    `);
    assert.deepEqual(
      rows.map((r) => `${r.rolname} can call ${r.proname}`),
      [],
      'the unguarded implementation is directly reachable, which defeats the guard',
    );
  });
});
