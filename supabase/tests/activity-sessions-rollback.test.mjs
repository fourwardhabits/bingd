import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createTestDbBefore } from './harness.mjs';

/**
 * **The rollback of 20261130000900, rehearsed.**
 *
 * A database migrated to just before 20261130000900 is the reference. The migration is
 * applied, a mixed session forms (a save, then two rankings), the rollback script runs, and
 * then: every restored writer's body, settings, comment and grants are the reference's
 * again; the helpers and the session consolidation are gone; the readers stay, so the
 * session formed meanwhile still reads as one card with all of its titles; families group
 * as they did before; the rollback refuses while a session-consolidation batch is logged;
 * and the migration can be applied a second time.
 */
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = '20261130000900_an_activity_session_is_one_post.sql';
const ROLLBACK = join(
  here,
  '..',
  '..',
  'docs',
  'release',
  'activity-sessions',
  'rollback-20261130000900.sql',
);
const RESTORED = [
  'rank_group_note',
  'rank_batch_finalize',
  'rank_batch_note',
  '_post_watchlist_activity',
  '_unpresent',
  '_watchlist_group_keeps_its_post',
];
const DROPPED = [
  '_session_refresh',
  '_open_session',
  '_lock_activity_session',
  '_activity_session_window',
  '_activity_sessions_enabled',
  'consolidate_feed_sessions',
  'revert_feed_session_consolidation',
  '_session_consolidation_plan',
];

let t;
let user;
let friend;
let tmdb = 3_400_000;

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
const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
const call = async (sql, params) => (await t.sql(`select ${sql} as r`, params)).rows[0].r;

async function rank(name) {
  const id = await t.createMovie(name, (tmdb += 1));
  await t.sql(`insert into user_media (user_id, media_item_id) values ($1, $2)`, [user, id]);
  await t.rankToCompletion(id, 'loved', (pivot, subject) => subject);
  return { id, result: await call(`rank_group_note($1, $2)`, [await uuid(), id]) };
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
            `select id, type, payload from feed_events where actor_id = $1 order by causal_at`,
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
  user = await t.createUser({ username: 'asr_user' });
  friend = await t.createUser({ username: 'asr_friend' });
  await t.sql(
    `insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`,
    [friend, user],
  );
  await t.actAs(user);
});

after(async () => t?.close());

describe('rollback-20261130000900.sql', () => {
  it('restores every writer exactly, keeps the readers and the sessions made meanwhile, and can be re-applied', async () => {
    const reference = await bodies(RESTORED);
    assert.equal(reference.length, RESTORED.length);
    const referenceReaders = await bodies(['ranking_batch_titles', 'feed_group_previews']);

    await t.applyMigration(MIGRATION);
    const migrated = await bodies(RESTORED);
    assert.notDeepEqual(migrated, reference, 'the migration rebuilt the writers');

    const saved = await save('ASR saved');
    const first = await rank('ASR one');
    assert.equal(first.result.status, 'joined', 'a ranking joins the watchlist session');
    await rank('ASR two');
    const [session] = await seen();
    assert.equal(session.type, 'ranking_batch');
    assert.equal(session.payload.count, 3);

    // A logged session-consolidation batch blocks the rollback.
    await t.sql(
      `insert into feed_consolidation_log (batch, kind, group_event_id, member_event_id, created_group)
       values ('asr-block', 'session', $1, null, false)`,
      [session.id],
    );
    let refused = null;
    try {
      await t.exec(await readFile(ROLLBACK, 'utf8'));
    } catch (error) {
      refused = error;
      await t.exec('rollback');
    }
    assert.ok(refused, 'the rollback refuses while a session batch is logged');
    assert.match(String(refused.message), /revert them first/);
    assert.equal((await bodies(['_session_refresh'])).length, 1, 'and changed nothing');
    await t.sql(`delete from feed_consolidation_log where batch = 'asr-block'`);

    await t.exec(await readFile(ROLLBACK, 'utf8'));

    assert.deepEqual(await bodies(RESTORED), reference, 'every writer is the reference again');
    assert.deepEqual(await bodies(DROPPED), [], 'the helpers and the consolidation are gone');
    const { rows: flag } = await t.sql(
      `select 1 from app_config where key = 'feed.activity_sessions_enabled'`,
    );
    assert.deepEqual(flag, []);
    assert.notDeepEqual(
      await bodies(['ranking_batch_titles', 'feed_group_previews']),
      referenceReaders,
      'the readers stay',
    );

    // The session formed meanwhile still reads as one card holding all three titles.
    const after = await seen();
    assert.deepEqual(
      after.map((p) => p.id),
      [session.id],
    );
    const sheet = await t.asUser(
      friend,
      async () =>
        (
          await t.sql(`select media_item_id, action from ranking_batch_titles($1)`, [
            session.id,
          ])
        ).rows,
    );
    await t.actAs(user);
    assert.equal(sheet.length, 3);
    assert.ok(sheet.some((r) => r.media_item_id === saved && r.action === 'saved'));

    // Families group as before: a new save after the window is its own watchlist post.
    await t.sql(
      `update feed_events set causal_at = causal_at - interval '2 hours',
              created_at = created_at - interval '2 hours',
              payload = payload || jsonb_build_object('started_at', now() - interval '2 hours')
        where actor_id = $1`,
      [user],
    );
    await save('ASR after');
    const types = (await seen()).map((p) => p.type);
    assert.deepEqual(types, ['ranking_batch', 'watchlist_added']);

    await t.applyMigration(MIGRATION);
    assert.deepEqual(await bodies(RESTORED), migrated, 're-applied cleanly');
  });
});
