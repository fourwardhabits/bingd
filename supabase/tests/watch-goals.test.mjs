import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Yearly watch goals, 20260816000800.
 *
 * The founder decision this implements is one line -- "one row per (user_id, year,
 * medium); movies and TV goals are independently optional/editable" -- and almost
 * everything that could go wrong is a way of failing *independently*:
 *
 *   - setting a TV goal disturbing a movie goal, or vice versa
 *   - clearing one medium clearing the year
 *   - a second year overwriting the first
 *
 * The rest is the shape every write path in this schema has to hold: the row
 * belongs to the caller, another account cannot read it, and a suspended one
 * cannot write it.
 */

let t;
let alice;
let bob;

const goalsOf = async (user) => {
  const { rows } = await t.sql(
    `select year, category, target from watch_goals
      where user_id = $1 order by year, category`,
    [user],
  );
  return rows;
};

const setGoal = (year, category, target) =>
  t.sql(`select set_watch_goal($1, $2::ranking_category, $3) as r`, [
    year,
    category,
    target ?? null,
  ]);

before(async () => {
  t = await createTestDb();
  alice = await t.createUser({ username: 'alice_goals' });
  bob = await t.createUser({ username: 'bob_goals' });
  await t.actAs(alice);
});

after(async () => {
  await t?.close();
});

describe('a goal per year per medium', () => {
  it('sets one', async () => {
    const { rows } = await setGoal(2026, 'movies', 52);

    assert.equal(rows[0].r.status, 'ok');
    assert.equal(rows[0].r.target, 52);
    assert.deepEqual(await goalsOf(alice), [{ year: 2026, category: 'movies', target: 52 }]);
  });

  it('leaves the other medium alone', async () => {
    await setGoal(2026, 'tv_seasons', 12);

    assert.deepEqual(await goalsOf(alice), [
      { year: 2026, category: 'movies', target: 52 },
      { year: 2026, category: 'tv_seasons', target: 12 },
    ]);
  });

  it('changes rather than duplicating', async () => {
    await setGoal(2026, 'movies', 60);

    const rows = await goalsOf(alice);
    assert.equal(rows.filter((r) => r.category === 'movies').length, 1);
    assert.equal(rows.find((r) => r.category === 'movies').target, 60);
    // The edit did not reach across the medium boundary.
    assert.equal(rows.find((r) => r.category === 'tv_seasons').target, 12);
  });

  it('keeps years apart', async () => {
    await setGoal(2025, 'movies', 30);

    assert.deepEqual(await goalsOf(alice), [
      { year: 2025, category: 'movies', target: 30 },
      { year: 2026, category: 'movies', target: 60 },
      { year: 2026, category: 'tv_seasons', target: 12 },
    ]);
  });
});

describe('clearing', () => {
  it('removes the row rather than zeroing it', async () => {
    const { rows } = await setGoal(2025, 'movies', null);

    assert.equal(rows[0].r.status, 'cleared');
    // Absence is the representation of "no goal". A row with target 0 would be a
    // second way to say it, and the check constraint forbids one.
    assert.equal((await goalsOf(alice)).some((r) => r.year === 2025), false);
  });

  it('is idempotent', async () => {
    const { rows } = await setGoal(2025, 'movies', null);
    assert.equal(rows[0].r.status, 'cleared');
  });

  it('clears one medium without clearing the year', async () => {
    await setGoal(2026, 'tv_seasons', null);

    assert.deepEqual(await goalsOf(alice), [{ year: 2026, category: 'movies', target: 60 }]);
  });
});

describe('what a goal will not hold', () => {
  it('refuses zero and negatives', async () => {
    for (const target of [0, -1]) {
      const error = await t.errorFrom(`select set_watch_goal(2026, 'movies', $1)`, [target]);
      assert.ok(error, `target ${target} should be refused`);
      assert.equal(error.code, '22023');
    }
  });

  it('refuses an absurd target', async () => {
    const error = await t.errorFrom(`select set_watch_goal(2026, 'movies', 10001)`);
    assert.equal(error?.code, '22023');
  });

  it('refuses a year that is really a date', async () => {
    // The failure this guards is a client sending 20260816 where a year was wanted.
    const error = await t.errorFrom(`select set_watch_goal(20260816, 'movies', 10)`);
    assert.equal(error?.code, '23514');
  });

  it('refuses a medium that is not one', async () => {
    const error = await t.errorFrom(`select set_watch_goal(2026, 'books', 10)`);
    assert.ok(error, 'an unknown category should not be storable');
  });

  it('survives the failed writes intact', async () => {
    assert.deepEqual(await goalsOf(alice), [{ year: 2026, category: 'movies', target: 60 }]);
  });
});

describe('a goal belongs to one account', () => {
  it('is invisible to another signed-in user', async () => {
    const rows = await t.asUser(bob, async () => {
      const { rows } = await t.sql(`select year, target from watch_goals`);
      return rows;
    });

    assert.deepEqual(rows, []);
  });

  it('is invisible signed out', async () => {
    const rows = await t.asAnon(async () => {
      const { rows } = await t.sql(`select year, target from watch_goals`);
      return rows;
    });

    assert.deepEqual(rows, []);
  });

  it('is written for the caller, not for whoever is named', async () => {
    // set_watch_goal takes no user id, which is the point: there is no argument a
    // client could use to spend a goal against somebody else's account.
    await t.asUser(bob, async () => {
      await t.sql(`select set_watch_goal(2026, 'movies', 5)`);
    });
    await t.actAs(alice);

    assert.deepEqual(await goalsOf(bob), [{ year: 2026, category: 'movies', target: 5 }]);
    assert.deepEqual(await goalsOf(alice), [{ year: 2026, category: 'movies', target: 60 }]);
  });

  it('refuses a suspended account', async () => {
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [bob]);

    const error = await t.asUser(bob, () =>
      t.errorFrom(`select set_watch_goal(2027, 'movies', 10)`),
    );

    assert.equal(error?.code, '42501');
    await t.sql(`update profiles set status = 'active' where id = $1`, [bob]);
  });

  it('goes with the profile', async () => {
    await t.sql(`delete from profiles where id = $1`, [bob]);
    assert.deepEqual(await goalsOf(bob), []);
  });
});
