import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createTestDbBefore } from './harness.mjs';

/**
 * 20261201000200: the Q1 freeze recorded under the actor's `follow_story:` lock (Codex, #390).
 *
 * The race itself is proved on real PostgreSQL (`concurrency/races/follow-story-engagement.mjs`,
 * FE2). This file pins the two things a single connection can: that the migration changes
 * nothing but the two writers' freeze (same signatures, same grants, same behaviour for every
 * other post), and that its rollback restores 20261201000100's bodies exactly.
 */
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = '20261201000200_a_story_frozen_before_it_grows.sql';
const ROLLBACK = join(here, '..', '..', 'docs', 'release', 'wsc', 'rollback-20261201000200.sql');
const REBUILT = ['set_reaction', '_add_comment'];

let t;

const bodies = async () =>
  (
    await t.sql(
      `select p.proname, p.prosrc, p.proconfig, p.prosecdef,
              pg_get_function_identity_arguments(p.oid) as args,
              has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
              has_function_privilege('anon', p.oid, 'execute') as anon_exec
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any ($1::text[])
        order by p.proname`,
      [REBUILT],
    )
  ).rows;

// PGlite has no `supabase_migrations` schema; the operator's bookkeeping line is the
// script's own business on a real project.
const rollbackSql = async () =>
  (await readFile(ROLLBACK, 'utf8')).replace(
    /^delete from supabase_migrations\.schema_migrations[^\n]*\n/m,
    '',
  );

before(async () => {
  t = await createTestDbBefore(MIGRATION);
});

after(async () => t?.close());

describe('20261201000200 and its rollback', () => {
  it('rebuilds only the two writers, keeps their signatures and grants, and rolls back exactly', async () => {
    const reference = await bodies();
    assert.equal(reference.length, REBUILT.length);

    await t.applyMigration(MIGRATION);
    const migrated = await bodies();
    assert.equal(migrated.length, REBUILT.length);
    for (const [i, row] of migrated.entries()) {
      const ref = reference[i];
      assert.notEqual(row.prosrc, ref.prosrc, `${row.proname} was rebuilt`);
      assert.match(row.prosrc, /follow_story:/, `${row.proname} takes the actor's story lock`);
      for (const k of ['proname', 'args', 'proconfig', 'prosecdef', 'auth_exec', 'anon_exec']) {
        assert.deepEqual(row[k], ref[k], `${row.proname}.${k} unchanged`);
      }
      // Everything but the freeze is 20261201000100's text.
      const strip = (s) => s.replace(/-- 20261201000100 \(Q1\)[\s\S]*?end if;\n/, '');
      const refStrip = (s) =>
        s.replace(/-- 20261201000100 \(Q1\)[\s\S]*?on conflict do nothing;\n(\s*end if;\n)?/, '');
      assert.equal(strip(row.prosrc), refStrip(ref.prosrc), `${row.proname}: nothing else changed`);
    }

    await t.exec(await rollbackSql());
    assert.deepEqual(await bodies(), reference, 'the rollback restores 20261201000100 exactly');

    // And the migration can be applied again after it.
    await t.applyMigration(MIGRATION);
    assert.deepEqual(
      (await bodies()).map((r) => r.prosrc),
      migrated.map((r) => r.prosrc),
    );
  });
});
