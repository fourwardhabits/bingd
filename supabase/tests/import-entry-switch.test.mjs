import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * **The importer's server-side entry switch** (release review 84, 2026-09-14).
 *
 * `unschedule_import_drain()` stops the worker, but a client can still create, stage and
 * hand over new jobs, which would then sit on "Importing" until the drain came back. The
 * entry switch is the grant: revoking `authenticated`'s EXECUTE on the three entry RPCs
 * refuses every new import at the database, for every client version and every device
 * already mid-flow, while `import_status` and `import_discard` keep working so nobody's
 * screen dead-ends. Granting them back re-opens the importer. The exact SQL is in
 * `docs/release/letterboxd-production-promotion.md` §8; this pins that it works, including
 * that PUBLIC holds no EXECUTE that would make the revoke a no-op.
 */

const ENTRY = ['import_create()', 'import_stage(uuid, jsonb)', 'import_ready(uuid)'];
const KEPT = ['import_status(uuid)', 'import_discard(uuid)'];

// From PUBLIC and anon too (review 84b). They hold nothing today, because 20260813001800 revokes
// PUBLIC's default EXECUTE on every function created in `public`, but the switch must not
// depend on that staying true.
const OFF = `revoke execute on function import_create(), import_stage(uuid, jsonb), import_ready(uuid) from public, anon, authenticated`;
const ON = `grant execute on function import_create(), import_stage(uuid, jsonb), import_ready(uuid) to authenticated`;

let t;

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

const can = async (role, fn) =>
  (await t.sql(`select has_function_privilege($1, $2, 'EXECUTE') as ok`, [role, fn])).rows[0]
    .ok;

describe('the importer entry switch', () => {
  it('starts open for a signed-in reader and closed to PUBLIC and anon', async () => {
    for (const fn of [...ENTRY, ...KEPT]) {
      assert.equal(await can('authenticated', fn), true, `${fn} for authenticated`);
      assert.equal(await can('anon', fn), false, `${fn} for anon`);
      assert.equal(await can('public', fn), false, `${fn} for PUBLIC`);
    }
  });

  it('refuses every new import when switched off, and keeps status and discard', async () => {
    const reader = await t.createUser({ username: 'entry_switch_reader' });

    // A job created while the importer was open, so status and discard have something.
    await t.actAs(reader);
    const { rows } = await t.sql(`select import_create() as id`);
    const openJob = rows[0].id;
    await t.actAs(null);

    await t.sql(OFF);

    // As the real `authenticated` role, which is what PostgREST runs a client as; `actAs`
    // stays the table owner and would not see a grant at all.
    await t.asUser(reader, async () => {
      for (const [label, query, params] of [
        ['create', `select import_create()`, []],
        ['stage', `select import_stage($1, '[]'::jsonb)`, [openJob]],
        ['ready', `select import_ready($1)`, [openJob]],
      ]) {
        const error = await t.errorFrom(query, params);
        assert.ok(error, `${label} was not refused`);
        assert.match(error.message, /permission denied/i, label);
      }
      // The screen can still ask where its job is, and let it go.
      await t.sql(`select * from import_status($1)`, [openJob]);
      await t.sql(`select import_discard($1)`, [openJob]);
    });

    await t.sql(ON);

    await t.asUser(reader, async () => {
      const { rows: again } = await t.sql(`select import_create() as id`);
      assert.ok(again[0].id, 'switching it back on re-opens the importer');
    });
  });
});
