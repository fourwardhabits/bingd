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
 * It has been 3, then 10, and is now 1. `20260818000100` raised it on the argument that
 * three strangers is not an app-wide opinion; `20260910000100` lowered it on the
 * observation that the argument was about a crowded app, and that before launch almost
 * every title has one rating or none — so a threshold of ten withheld not a weak number
 * but every number there was, including from the reader whose own rating it counted.
 *
 * Asserted on the shipped row rather than on behaviour, because `social-notes.test.mjs`
 * lowers this value for its own population tests and would otherwise be the only place
 * the number is visible — which would make lowering it there indistinguishable from
 * changing it here.
 */
test('the Bingd aggregate shows from the first rating', async () => {
  const t = await createTestDb();
  try {
    const { rows } = await t.sql(
      `select (value)::integer as n from app_config where key = 'score.community_min_ratings'`,
    );
    assert.equal(rows.length, 1, 'the row exists rather than being left to a fallback');
    assert.equal(rows[0].n, 1);
  } finally {
    await t.close();
  }
});

/**
 * The discovery floor, which is the *other* question and therefore the other row.
 *
 * `score.community_min_ratings` above decides whether a title page may print a number at
 * all, and the answer before launch is "from the first rating", because withholding is
 * worse than a thin number the reader can see the sample size of. Top Rated asks
 * something different: whether a title is worth putting in front of somebody on the
 * strength of that number. One person's 10.0 is a true score and a false recommendation.
 *
 * Asserted separately, and the pairing is the point: a future pass that moves one of them
 * has to notice it is not moving the other.
 */
test('Top Rated starts at five ratings, and is not the display threshold', async () => {
  const t = await createTestDb();
  try {
    const { rows } = await t.sql(
      `select key, (value)::integer as n
         from app_config
        where key in ('discovery.top_rated_min_ratings', 'score.community_min_ratings')
        order by key`,
    );
    assert.deepEqual(
      rows.map((row) => [row.key, row.n]),
      [
        ['discovery.top_rated_min_ratings', 5],
        ['score.community_min_ratings', 1],
      ],
    );
  } finally {
    await t.close();
  }
});

/**
 * The invitation bar, and the reason it is in this file rather than only in
 * `invite.test.mjs`.
 *
 * `_maybe_activate_invite` reads `invite.activation_rankings` with a written fallback,
 * which is the exact shape this file exists to police. `20260916000100` moved the bar
 * from ten to five — the completed *Your First Five*, which is where onboarding stops
 * asking — and it moved it in **both** homes: the configured row, and the literal in
 * the function. Changing only the row leaves a function whose source says one thing and
 * whose behaviour says another, and a database that lost the row would then silently
 * revert to the old contract.
 *
 * So the row is deleted and the boundary is exercised against the fallback alone.
 */
test('an invitation still activates at five when the bar is not configured', async () => {
  const t = await createTestDb();
  try {
    await t.sql(`delete from app_config where key = 'invite.activation_rankings'`);

    const inviter = await t.createUser({ username: 'fallback_inviter' });
    const invitee = await t.createUser({ username: 'fallback_invitee' });

    await t.actAs(inviter);
    const minted = (await t.sql(`select create_invite_link(gen_random_uuid()) as r`)).rows[0].r;
    assert.equal(minted.status, 'ok');

    await t.actAs(invitee);
    const redeemed = (
      await t.sql(`select redeem_invite(gen_random_uuid(), $1) as r`, [minted.token])
    ).rows[0].r;
    assert.equal(redeemed.status, 'ok');

    const activatedAt = async () =>
      (
        await t.sql(`select activated_at from invite_attributions where invitee_id = $1`, [invitee])
      ).rows[0].activated_at;

    let seq = 94000;
    for (let i = 0; i < 4; i += 1) {
      const film = await t.createMovie(`fallback_${i}`, seq++);
      await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    }
    // Previously: with the row gone the coalesce still said ten, so four was four short
    // rather than one — and an environment missing this key activated nobody at five.
    assert.equal(await activatedAt(), null, 'four is not activation');

    const fifth = await t.createMovie('fallback_fifth', seq++);
    await t.rankToCompletion(fifth, 'loved', async (pivot) => pivot);
    assert.ok(await activatedAt(), 'the documented default of five should apply');
  } finally {
    await t.close();
  }
});
