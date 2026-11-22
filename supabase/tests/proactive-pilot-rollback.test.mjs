import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createTestDbBefore } from './harness.mjs';

/**
 * **The rollback of 20261130001100, rehearsed.**
 *
 * A database migrated to just before 20261130001100 is the reference. The migration is
 * applied, the pilot runs (a listed reader, two qualifying friends, a cluster), the
 * rollback refuses while generation is on, then runs, and then: every restored function's
 * body, settings, comment and grants are the reference's again; the new helpers, the
 * ledger trigger and the four settings are gone; the reasons vocabulary keeps its three
 * extra words (rows carry them); the cluster made meanwhile is untouched; and the
 * migration can be applied a second time.
 */
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = '20261130001100_a_friend_you_actually_talk_to.sql';
const ROLLBACK = join(
  here,
  '..',
  '..',
  'docs',
  'release',
  'proactive-pilot',
  'rollback-20261130001100.sql',
);
const RESTORED = [
  '_proactive_social_on_activity',
  '_proactive_social_actors',
  '_proactive_invalid',
  '_proactive_tick',
  'proactive_status',
];
const DROPPED = [
  '_proactive_candidates_pilot_scope',
  '_proactive_pilot_allows',
  '_proactive_pilot_recipients',
  '_proactive_friend_qualifies',
  '_proactive_friend_min_affinity',
  '_proactive_social_enabled',
  '_proactive_theatrical_enabled',
];
const KEYS = [
  'proactive.social_enabled',
  'proactive.theatrical_enabled',
  'proactive.friend_min_affinity',
  'proactive.pilot_recipients',
];

let t;
let seq = 0;

const bodies = async (names) => {
  const { rows } = await t.sql(
    `select p.proname, p.prosrc, p.proconfig, p.prosecdef,
            pg_get_function_identity_arguments(p.oid) as args,
            obj_description(p.oid, 'pg_proc') as comment,
            has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
            has_function_privilege('anon', p.oid, 'execute') as anon_exec,
            has_function_privilege('service_role', p.oid, 'execute') as service_exec
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any ($1::text[])
      order by p.proname`,
    [names],
  );
  return rows;
};
const one = async (sql, params) => (await t.sql(`select ${sql} as r`, params)).rows[0].r;
const setConfig = (key, value) =>
  t.sql(
    `insert into app_config (key, value) values ($1, $2::jsonb)
     on conflict (key) do update set value = excluded.value`,
    [key, JSON.stringify(value)],
  );
const keys = async () =>
  (
    await t.sql(`select key from app_config where key = any ($1::text[]) order by key`, [KEYS])
  ).rows.map((r) => r.key);
const trigger = async () =>
  (await t.sql(`select 1 from pg_trigger where tgname = 'proactive_candidates_pilot_scope'`))
    .rows.length;

const user = async (name) => {
  const id = await t.createUser({ username: `${name}${(seq += 1)}` });
  await t.sql(
    `insert into account_context (user_id, timezone, region) values ($1, 'UTC', 'US')`,
    [id],
  );
  return id;
};
const mutual = async (a, b) => {
  for (const [x, y] of [
    [a, b],
    [b, a],
  ]) {
    await t.sql(
      `insert into follows (follower_id, followee_id, state, approved_at) values ($1, $2, 'approved', now())`,
      [x, y],
    );
  }
};
const movie = async () => {
  seq += 1;
  return (
    await t.sql(
      `insert into media_items (kind, tmdb_id, title, provenance) values ('movie', $1, $2, 'tmdb') returning id`,
      [1_840_000_000 + seq, `Rollback ${seq}`],
    )
  ).rows[0].id;
};
const event = async (actor, type, m) =>
  (
    await t.sql(
      `insert into feed_events (actor_id, type, media_item_id) values ($1, $2, $3) returning id`,
      [actor, type, m],
    )
  ).rows[0].id;

before(async () => {
  t = await createTestDbBefore(MIGRATION);
});

after(async () => t?.close());

describe('rollback-20261130001100.sql', () => {
  it('restores every rebuilt function exactly, drops the pilot, keeps the vocabulary and the data, and can be re-applied', async () => {
    const reference = await bodies(RESTORED);
    assert.equal(reference.length, RESTORED.length);
    const referenceReasons = await one(`_proactive_reasons()`);

    await t.applyMigration(MIGRATION);
    const migrated = await bodies(RESTORED);
    assert.notDeepEqual(migrated, reference, 'the migration rebuilt them');
    assert.equal((await bodies(DROPPED)).length, DROPPED.length);
    for (const row of await bodies(DROPPED)) {
      assert.equal(row.auth_exec, false, row.proname);
      assert.equal(row.anon_exec, false, row.proname);
    }

    // The pilot, briefly: one listed reader, two friends they talk to, a cluster.
    const r = await user('rbr');
    const m = await movie();
    await t.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [r, m]);
    await setConfig('proactive.generation_enabled', true);
    await setConfig('proactive.social_enabled', true);
    await setConfig('proactive.pilot_recipients', [r]);
    for (const name of ['rbf', 'rbg']) {
      const f = await user(name);
      await mutual(r, f);
      await t.sql(
        `insert into comments (feed_event_id, author_id, body) values ($1, $2, 'yes')`,
        [await event(f, 'watchlist_added', await movie()), r],
      );
      await event(f, 'title_ranked', m);
    }
    const before = (
      await t.sql(
        `select id, state, eligible_at from proactive_candidates where recipient_id = $1`,
        [r],
      )
    ).rows;
    assert.equal(before.length, 1);
    assert.notEqual(before[0].eligible_at, null);

    // Refused while generation is on: it would turn the pilot into a general rollout.
    let refused = null;
    try {
      await t.exec(await readFile(ROLLBACK, 'utf8'));
    } catch (error) {
      refused = error;
      await t.exec('rollback');
    }
    assert.ok(refused, 'the rollback refuses while generation is on');
    assert.match(String(refused.message), /generation_enabled is true/);
    assert.deepEqual(await bodies(RESTORED), migrated, 'and changed nothing');
    assert.equal(await trigger(), 1);

    await setConfig('proactive.generation_enabled', false);
    await t.exec(await readFile(ROLLBACK, 'utf8'));

    assert.deepEqual(
      await bodies(RESTORED),
      reference,
      'every rebuilt function is the reference again',
    );
    assert.deepEqual(await bodies(DROPPED), [], 'the helpers are gone');
    assert.deepEqual(await keys(), [], 'the four settings are gone');
    assert.equal(await trigger(), 0, 'the ledger trigger is gone');
    const reasons = await one(`_proactive_reasons()`);
    assert.deepEqual(reasons.slice(0, referenceReasons.length), referenceReasons);
    for (const word of ['social_disabled', 'theatrical_disabled', 'outside_pilot']) {
      assert.ok(reasons.includes(word), `the vocabulary keeps ${word}`);
    }
    const afterRows = (
      await t.sql(
        `select id, state, eligible_at from proactive_candidates where recipient_id = $1`,
        [r],
      )
    ).rows;
    assert.deepEqual(afterRows, before, 'the cluster made meanwhile is untouched');
    // proactive_status answers as it did before the migration.
    const status = await one(`proactive_status()`);
    assert.equal('social_enabled' in status, false);

    await t.applyMigration(MIGRATION);
    assert.deepEqual(await bodies(RESTORED), migrated, 're-applied cleanly');
    assert.deepEqual(await keys(), [...KEYS].sort());
    assert.equal(await trigger(), 1);
  });
});
