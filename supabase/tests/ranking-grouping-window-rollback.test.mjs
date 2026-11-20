import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createTestDbBefore } from './harness.mjs';

/**
 * **The rollback of 20261130000200, rehearsed.**
 *
 * A database migrated to just before 20261130000200 is the reference. The migration is
 * applied, groups are made under the half-hour rule, the rollback script runs, and then:
 * every rebuilt function's body is byte-for-byte the reference's again, the removed rule and
 * setting are back, the groups made in the meantime are untouched and still read as one card,
 * and the migration can be applied a second time.
 */
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = '20261130000200_a_half_hour_of_first_rankings_is_one_post.sql';
const ROLLBACK = join(
  here,
  '..',
  '..',
  'docs',
  'release',
  'ranking-grouping-window',
  'rollback-20261130000200.sql',
);
const FUNCTIONS = [
  'rank_group_note',
  'rank_batch_finalize',
  'consolidate_feed_history',
  '_ranking_is_historical',
];

let t;
let user;
let friend;
let tmdb = 1_400_000;

const bodies = async () => {
  const { rows } = await t.sql(
    `select p.proname, p.prosrc, p.proconfig, p.prosecdef,
            pg_get_function_identity_arguments(p.oid) as args,
            has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
            has_function_privilege('anon', p.oid, 'execute') as anon_exec
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any ($1::text[])
      order by p.proname`,
    [FUNCTIONS],
  );
  return rows;
};
const backfillDays = async () =>
  (await t.sql(`select value from app_config where key = 'feed.ranking_backfill_days'`)).rows[0]
    ?.value;
const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
const call = async (sql, params) => (await t.sql(`select ${sql} as r`, params)).rows[0].r;

async function rankToday(name) {
  const id = await t.createMovie(`${name}`, (tmdb += 1));
  await t.sql(`insert into user_media (user_id, media_item_id) values ($1, $2)`, [user, id]);
  await t.sql(
    `insert into watch_events (user_id, media_item_id, watched_on, basis)
     values ($1, $2, current_date, 'today_default')`,
    [user, id],
  );
  await t.rankToCompletion(id, 'loved', (pivot, subject) => subject);
  return call(`rank_group_note($1, $2)`, [await uuid(), id]);
}

before(async () => {
  t = await createTestDbBefore(MIGRATION);
  user = await t.createUser({ username: 'rb_user' });
  friend = await t.createUser({ username: 'rb_friend' });
  await t.sql(
    `insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`,
    [friend, user],
  );
  await t.actAs(user);
});

after(async () => t?.close());

describe('rollback-20261130000200.sql', () => {
  it('restores every rebuilt function exactly, keeps the groups made meanwhile, and can be re-applied', async () => {
    const reference = await bodies();
    assert.equal(reference.length, FUNCTIONS.length, 'the reference has all four functions');
    assert.equal(await backfillDays(), 7);

    await t.applyMigration(MIGRATION);
    const migrated = await bodies();
    assert.ok(
      !migrated.some((f) => f.proname === '_ranking_is_historical'),
      'the date rule is gone',
    );
    assert.equal(await backfillDays(), undefined);

    assert.equal((await rankToday('RB 1')).status, 'solo');
    assert.equal((await rankToday('RB 2')).status, 'grouped', 'the half-hour rule is live');

    await t.exec(await readFile(ROLLBACK, 'utf8'));

    assert.deepEqual(
      await bodies(),
      reference,
      'bodies, settings and grants are the reference again',
    );
    assert.equal(await backfillDays(), 7);
    assert.equal(
      (await rankToday('RB 3')).reason,
      'after_watch',
      'the restored function applies its date rule again',
    );
    const seen = await t.asUser(
      friend,
      async () =>
        (
          await t.sql(
            `select type, payload from feed_events where actor_id = $1 order by causal_at`,
            [user],
          )
        ).rows,
    );
    assert.deepEqual(
      seen.map((p) => p.type),
      ['ranking_batch', 'title_ranked'],
      'the group made under the new rule still reads as one card; nothing was unhidden',
    );
    assert.equal(seen[0].payload.count, 2);

    await t.applyMigration(MIGRATION);
    assert.deepEqual(
      await bodies(),
      migrated,
      'the migration applies again on top of the rollback',
    );
  });
});
