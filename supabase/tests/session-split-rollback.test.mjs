import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createTestDbBefore } from './harness.mjs';

/**
 * **The rollback of 20261130001000, rehearsed.**
 *
 * A database migrated to just before 20261130001000 is the reference. The migration is
 * applied, a window forms its two posts (a save, then two rankings), a split batch is
 * logged, and then: the rollback refuses while the split is logged; once it is reverted the
 * rollback runs, every restored writer's body, settings, comment and grants are the
 * reference's again, the shared-window helpers and the split are gone, the setting and the
 * log columns are gone, the two posts formed meanwhile still read as two posts, and the
 * migration can be applied a second time.
 */
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = '20261130001000_two_posts_per_shared_window.sql';
const ROLLBACK = join(
  here,
  '..',
  '..',
  'docs',
  'release',
  'session-split',
  'rollback-20261130001000.sql',
);
const RESTORED = [
  '_open_session',
  'rank_group_note',
  '_post_watchlist_activity',
  'rank_batch_finalize',
  'consolidate_feed_sessions',
  'revert_feed_session_consolidation',
];
const DROPPED = [
  '_window_posts',
  '_window_anchor',
  '_claim_window_start',
  '_session_split_plan',
  'split_mixed_sessions',
  'revert_session_split',
];
const UNCHANGED = [
  'rank_batch_note',
  '_session_refresh',
  '_unpresent',
  '_watchlist_group_keeps_its_post',
  'ranking_batch_titles',
  'feed_group_previews',
  'watchlist_group_titles',
];

let t;
let user;
let friend;
let tmdb = 3_950_000;

const bodies = async (names) => {
  const { rows } = await t.sql(
    `select p.proname, p.prosrc, p.proconfig, p.prosecdef,
            pg_get_function_identity_arguments(p.oid) as args,
            obj_description(p.oid, 'pg_proc') as comment,
            has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
            has_function_privilege('anon', p.oid, 'execute') as anon_exec
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any ($1::text[])
      order by p.proname`,
    [names],
  );
  return rows;
};
const columns = async () =>
  (
    await t.sql(
      `select column_name, col_description('feed_consolidation_log'::regclass, ordinal_position) as comment
         from information_schema.columns
        where table_name = 'feed_consolidation_log' order by column_name`,
    )
  ).rows;
const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
const call = async (sql, params) => (await t.sql(`select ${sql} as r`, params)).rows[0].r;

async function rank(name) {
  const id = await t.createMovie(name, (tmdb += 1));
  await t.sql(`insert into user_media (user_id, media_item_id) values ($1, $2)`, [user, id]);
  await t.rankToCompletion(id, 'loved', (pivot, subject) => subject);
  return call(`rank_group_note($1, $2)`, [await uuid(), id]);
}
const save = async (name) => {
  const id = await t.createMovie(name, (tmdb += 1));
  await call(`set_watchlist($1, $2, true)`, [await uuid(), id]);
  return id;
};
const seen = async () => {
  try {
    return await t.asUser(
      friend,
      async () =>
        (
          await t.sql(
            `select id, type, payload from feed_events where actor_id = $1 order by type`,
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
  user = await t.createUser({ username: 'ssr_user' });
  friend = await t.createUser({ username: 'ssr_friend' });
  await t.sql(
    `insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`,
    [friend, user],
  );
  await t.actAs(user);
});

after(async () => t?.close());

describe('rollback-20261130001000.sql', () => {
  it('restores every writer exactly, keeps the posts made meanwhile, and can be re-applied', async () => {
    const reference = await bodies(RESTORED);
    assert.equal(reference.length, RESTORED.length);
    const referenceUnchanged = await bodies(UNCHANGED);
    const referenceColumns = await columns();
    const { rows: referenceFlags } = await t.sql(
      `select key, value from app_config where key like 'feed.%' order by key`,
    );

    await t.applyMigration(MIGRATION);
    const migrated = await bodies(RESTORED);
    assert.notDeepEqual(migrated, reference, 'the migration rebuilt the writers');
    assert.deepEqual(await bodies(UNCHANGED), referenceUnchanged, 'and left the rest alone');

    await save('SSR saved');
    assert.equal((await rank('SSR one')).status, 'solo', 'a ranking does not join a save');
    assert.equal((await rank('SSR two')).status, 'grouped');
    const formed = await seen();
    assert.deepEqual(
      formed.map((p) => p.type),
      ['ranking_batch', 'watchlist_added'],
    );

    // A logged split batch blocks the rollback.
    await t.sql(
      `insert into feed_consolidation_log (batch, kind, split_role, group_event_id, created_group)
       values ('ssr-block', 'split', 'post', $1, false)`,
      [formed[0].id],
    );
    let refused = null;
    try {
      await t.exec(await readFile(ROLLBACK, 'utf8'));
    } catch (error) {
      refused = error;
      await t.exec('rollback');
    }
    assert.ok(refused, 'the rollback refuses while a split batch is logged');
    assert.match(String(refused.message), /revert_session_split first/);
    assert.equal((await bodies(['split_mixed_sessions'])).length, 1, 'and changed nothing');
    await t.sql(`delete from feed_consolidation_log where batch = 'ssr-block'`);

    await t.exec(await readFile(ROLLBACK, 'utf8'));

    assert.deepEqual(await bodies(RESTORED), reference, 'every writer is the reference again');
    assert.deepEqual(await bodies(DROPPED), [], 'the helpers and the split are gone');
    assert.deepEqual(await bodies(UNCHANGED), referenceUnchanged);
    assert.deepEqual(await columns(), referenceColumns, 'the log is as it was');
    const { rows: flags } = await t.sql(
      `select key, value from app_config where key like 'feed.%' order by key`,
    );
    assert.deepEqual(flags, referenceFlags, 'the setting is gone');

    // The two posts formed meanwhile still read as two posts.
    assert.deepEqual(
      (await seen()).map((p) => [p.id, p.type]),
      formed.map((p) => [p.id, p.type]),
    );

    await t.applyMigration(MIGRATION);
    assert.deepEqual(await bodies(RESTORED), migrated, 're-applied cleanly');
  });
});
