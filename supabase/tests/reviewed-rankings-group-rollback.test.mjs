import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createTestDbBefore } from './harness.mjs';

/**
 * **The rollback of 20261130000800, rehearsed.**
 *
 * A database migrated to just before 20261130000800 is the reference. The migration is
 * applied, a reviewed first ranking groups, the rollback script runs, and then: every
 * rebuilt function's body, settings and grants are the reference's again, the review
 * trigger is back, the group made in the meantime is untouched and still reads as one
 * card, and the migration can be applied a second time.
 */
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = '20261130000800_a_reviewed_first_ranking_joins_its_half_hour.sql';
const ROLLBACK = join(
  here,
  '..',
  '..',
  'docs',
  'release',
  'reviewed-rankings-group',
  'rollback-20261130000800.sql',
);
const FUNCTIONS = ['rank_group_note', 'rank_batch_finalize', '_unpresent_on_review'];

let t;
let user;
let friend;
let tmdb = 1_600_000;

const bodies = async () => {
  const { rows } = await t.sql(
    `select p.proname, p.prosrc, p.proconfig, p.prosecdef,
            pg_get_function_identity_arguments(p.oid) as args,
            obj_description(p.oid, 'pg_proc') as comment,
            has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
            has_function_privilege('anon', p.oid, 'execute') as anon_exec
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any ($1::text[])
      order by p.proname`,
    [FUNCTIONS],
  );
  return rows;
};
const trigger = async () =>
  (
    await t.sql(
      `select tgname, pg_get_triggerdef(oid) as def from pg_trigger
        where tgname = 'user_media_unpresent_on_review'`,
    )
  ).rows;
const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
const call = async (sql, params) => (await t.sql(`select ${sql} as r`, params)).rows[0].r;

async function rank(name, text = null) {
  const id = await t.createMovie(name, (tmdb += 1));
  await t.sql(
    `insert into user_media (user_id, media_item_id, note, note_visibility)
     values ($1, $2, $3, case when $3::text is null then 'private' else 'public' end::note_visibility)`,
    [user, id, text],
  );
  await t.rankToCompletion(id, 'loved', (pivot, subject) => subject);
  return { id, result: await call(`rank_group_note($1, $2)`, [await uuid(), id]) };
}

const seen = async () => {
  try {
    return await t.asUser(
      friend,
      async () =>
        (
          await t.sql(
            `select type, payload from feed_events where actor_id = $1 order by causal_at`,
            [user],
          )
        ).rows,
    );
  } finally {
    await t.actAs(user);
  }
};

before(async () => {
  t = await createTestDbBefore(MIGRATION);
  user = await t.createUser({ username: 'rrb_user' });
  friend = await t.createUser({ username: 'rrb_friend' });
  await t.sql(
    `insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`,
    [friend, user],
  );
  await t.actAs(user);
});

after(async () => t?.close());

describe('rollback-20261130000800.sql', () => {
  it('restores every rebuilt function and the trigger exactly, keeps the groups made meanwhile, and can be re-applied', async () => {
    const reference = await bodies();
    const referenceTrigger = await trigger();
    assert.equal(reference.length, FUNCTIONS.length, 'the reference has all three functions');
    assert.equal(referenceTrigger.length, 1);

    await t.applyMigration(MIGRATION);
    const migrated = await bodies();
    assert.ok(
      !migrated.some((f) => f.proname === '_unpresent_on_review'),
      'the trigger function is gone',
    );
    assert.deepEqual(await trigger(), [], 'and its trigger');

    assert.equal((await rank('RRB 1')).result.status, 'solo');
    const reviewed = await rank('RRB 2', 'Reviewed and grouped.');
    assert.equal(reviewed.result.status, 'grouped', 'a reviewed first ranking groups');

    await t.exec(await readFile(ROLLBACK, 'utf8'));

    assert.deepEqual(
      await bodies(),
      reference,
      'bodies, comments, settings and grants are the reference again',
    );
    assert.deepEqual(await trigger(), referenceTrigger, 'the trigger is back as it was');
    assert.equal(
      (await rank('RRB 3', 'A review again keeps it apart.')).result.reason,
      'reviewed',
      'the restored function applies its review rule again',
    );
    const after = await seen();
    assert.deepEqual(
      after.map((p) => p.type),
      ['ranking_batch', 'title_ranked'],
      'the group made under the new rule still reads as one card; nothing was unhidden',
    );
    assert.equal(after[0].payload.count, 2);

    await t.applyMigration(MIGRATION);
    assert.deepEqual(
      await bodies(),
      migrated,
      'the migration applies again on top of the rollback',
    );
    assert.deepEqual(await trigger(), []);
  });
});
