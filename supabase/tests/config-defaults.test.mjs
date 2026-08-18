import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Tuning values read from `app_config`, and what happens when one is absent.
 *
 * Three functions read a configured value with a written fallback. All three wrote
 * it the same wrong way:
 *
 *     select coalesce((value)::integer, 20) into v_cap
 *       from app_config where key = 'report.max_per_day';
 *
 * With no matching row the query returns no rows at all, so the coalesce is never
 * evaluated and the variable stays NULL. The fallback is decoration. Two of the
 * three consequences are a limit silently ceasing to exist, which is the kind of
 * failure that shows up as a support ticket months later.
 *
 * These tests delete the row and assert the documented default still applies.
 */

test('a rename still works when the redirect window is not configured', async () => {
  const t = await createTestDb();
  try {
    await t.sql(`delete from app_config where key = 'username.redirect_days'`);

    const alice = await t.createUser({ username: 'alice' });
    const err = await t.errorFrom(`update profiles set username = 'alice_moved' where id = $1`, [
      alice,
    ]);

    // Previously: redirect_until received NULL and the NOT NULL constraint rejected
    // the whole rename.
    assert.equal(err, null, 'a missing config row must not break renaming');

    const { rows } = await t.sql(
      `select redirect_until > now() + interval '89 days' as ok
         from username_history where username = 'alice'`,
    );
    assert.equal(rows[0].ok, true, 'the documented 90-day default should apply');
  } finally {
    await t.close();
  }
});

test('the skip cap still applies when it is not configured', async () => {
  const t = await createTestDb();
  try {
    await t.sql(`delete from app_config where key = 'ranking.max_skips'`);

    const user = await t.createUser({ username: 'skipper' });
    await t.actAs(user);

    let seq = 91000;
    for (let i = 0; i < 6; i += 1) {
      const id = await t.createMovie(`cap_base_${i}`, seq++);
      await t.rankToCompletion(id, 'loved', async (pivot) => pivot);
    }

    const subject = await t.createMovie('cap_subject', seq++);
    let result = (await t.sql(`select rank_start($1, 'loved') as r`, [subject])).rows[0].r;

    // Previously: `skips + 1 >= NULL` is never true, so this ran until the walk
    // exhausted the band rather than stopping at the configured ceiling.
    let skips = 0;
    while (!result.done && skips < 25) {
      result = (await t.sql(`select rank_skip($1) as r`, [result.session_id])).rows[0].r;
      skips += 1;
    }

    assert.equal(result.done, true, 'the session must end');
    assert.ok(skips <= 3, `the default cap of 3 should apply, took ${skips} skips`);
  } finally {
    await t.close();
  }
});

test('the daily report cap still applies when it is not configured', async () => {
  const t = await createTestDb();
  try {
    await t.sql(`delete from app_config where key = 'report.max_per_day'`);

    const reporter = await t.createUser({ username: 'reporter' });

    // Twenty distinct subjects, because one open report per reporter per subject is
    // held by an index and would otherwise mask the cap entirely.
    const subjects = [];
    for (let i = 0; i < 21; i += 1) {
      subjects.push(await t.createUser({ username: `subject${i}` }));
    }

    await t.asUser(reporter, async () => {
      let accepted = 0;
      let refused = null;

      for (const subject of subjects) {
        const err = await t.errorFrom(`select report('profile', $1, 'spam', null)`, [subject]);
        if (err) {
          refused = err;
          break;
        }
        accepted += 1;
      }

      assert.ok(refused, 'the default cap of 20 should refuse the twenty-first report');
      assert.equal(refused.code, '53400', 'and refuse it as a ceiling, not some other error');
      assert.equal(accepted, 20, 'after accepting exactly twenty');
    });
  } finally {
    await t.close();
  }
});

/**
 * The Bingd aggregate's sample size, which is a product decision and not a fallback.
 *
 * It was 3 from `20260816000000` until the founder moved it to 10 on 2026-08-18. Three
 * strangers is not an app-wide opinion; it is three people, and putting their mean
 * under the product's own name lends it an authority it has not earned.
 *
 * Asserted on the shipped row rather than on behaviour, because `social-notes.test.mjs`
 * lowers this value for its own population tests and would otherwise be the only place
 * the number is visible — which would make lowering it there indistinguishable from
 * changing it here.
 */
test('the Bingd aggregate waits for ten ratings', async () => {
  const t = await createTestDb();
  try {
    const { rows } = await t.sql(
      `select (value)::integer as n from app_config where key = 'score.community_min_ratings'`,
    );
    assert.equal(rows.length, 1, 'the row exists rather than being left to a fallback');
    assert.equal(rows[0].n, 10);
  } finally {
    await t.close();
  }
});
