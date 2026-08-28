import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Annual goal completion — `20260829000200`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS ACTUALLY GUARDING
 *
 * A celebration is a thing other people see and a push notification on somebody's lock
 * screen. So the interesting assertions are almost all **negative**: the founder listed
 * six situations that must produce nothing, and every one of them is a way a naive
 * implementation would spam a beta.
 *
 *   · opening Profile, a query recalculating, a relaunch — reads, not writes
 *   · a goal edited downward below a count already reached
 *   · a migration shipping to somebody already past their goal
 *   · a goal edited upward after a completion, then crossed again
 *   · a rewatch
 *   · a series
 *
 * The one positive case — 24 becomes 25 against a target of 25 — is a single test. The
 * rest of this file is about not firing.
 *
 * `asUser` is not used for most of it: the trigger is what is under test and it runs
 * inside the write regardless of role. Where a *policy* is the claim (who may read the
 * ledger, who sees the feed event), the role matters and the test says so.
 */

const here = dirname(fileURLToPath(import.meta.url));

let t;
let alice;
let seq = 97000;

const movie = (title) => t.createMovie(title, seq++);

/** Logs a watch directly, which is what the trigger keys on. */
const watch = (user, item, on) =>
  t.sql(
    `insert into user_media (user_id, media_item_id, bucket, watched_on)
     values ($1, $2, 'loved', $3::date)
     on conflict (user_id, media_item_id) do update set watched_on = excluded.watched_on`,
    [user, item, on],
  );

const setGoal = (user, year, category, target) =>
  t.sql(
    `insert into watch_goals (user_id, year, category, target) values ($1, $2, $3, $4)
     on conflict (user_id, year, category) do update set target = excluded.target`,
    [user, year, category, target],
  );

const completions = async (user) => {
  const { rows } = await t.sql(
    `select year, category, target_at_completion, count_at_completion
       from goal_completions where user_id = $1 order by year, category`,
    [user],
  );
  return rows;
};

const feedPosts = async (user) => {
  const { rows } = await t.sql(
    `select payload from feed_events where actor_id = $1 and type = 'goal_completed'`,
    [user],
  );
  return rows.map((r) => r.payload);
};

const congrats = async (user) => {
  const { rows } = await t.sql(
    `select payload from notifications where recipient_id = $1 and type = 'goal_completed'`,
    [user],
  );
  return rows.map((r) => r.payload);
};

/** Everything this account has earned, wiped between tests. */
const reset = async (user) => {
  await t.sql(`delete from goal_completions where user_id = $1`, [user]);
  await t.sql(`delete from feed_events where actor_id = $1 and type = 'goal_completed'`, [user]);
  await t.sql(`delete from notifications where recipient_id = $1 and type = 'goal_completed'`, [user]);
  await t.sql(`delete from user_media where user_id = $1`, [user]);
  await t.sql(`delete from watch_goals where user_id = $1`, [user]);
};

before(async () => {
  t = await createTestDb();
  alice = await t.createUser({ username: 'gc_alice' });
});

after(async () => {
  await t.close();
});

beforeEach(() => reset(alice));

// ---------------------------------------------------------------------------

describe('the crossing', () => {
  it('A — a goal of 25 at 24 completes on the 25th', async () => {
    await setGoal(alice, 2026, 'movies', 25);
    const films = [];
    for (let i = 0; i < 25; i += 1) films.push(await movie(`Goal Film ${seq}`));

    for (let i = 0; i < 24; i += 1) await watch(alice, films[i], '2026-03-01');
    assert.deepEqual(await completions(alice), [], 'not finished at 24 of 25');

    await watch(alice, films[24], '2026-03-02');

    const done = await completions(alice);
    assert.equal(done.length, 1);
    assert.equal(done[0].target_at_completion, 25);
    assert.equal(done[0].count_at_completion, 25);
  });

  it('B — produces exactly one feed event and one notification', async () => {
    await setGoal(alice, 2026, 'movies', 2);
    await watch(alice, await movie('One'), '2026-01-01');
    await watch(alice, await movie('Two'), '2026-01-02');

    const posts = await feedPosts(alice);
    const inbox = await congrats(alice);
    assert.equal(posts.length, 1);
    assert.equal(inbox.length, 1);
    assert.deepEqual(posts[0], { year: 2026, category: 'movies', target: 2 });
    assert.deepEqual(inbox[0], { year: 2026, category: 'movies', target: 2 });
  });

  it('keeps counting past the target without celebrating again', async () => {
    // The `(count - added) >= target` half of the condition. Without it every watch for
    // the rest of the year would try to celebrate.
    await setGoal(alice, 2026, 'movies', 2);
    await watch(alice, await movie('One'), '2026-01-01');
    await watch(alice, await movie('Two'), '2026-01-02');
    await watch(alice, await movie('Three'), '2026-01-03');
    await watch(alice, await movie('Four'), '2026-01-04');

    assert.equal((await completions(alice)).length, 1);
    assert.equal((await feedPosts(alice)).length, 1);
  });

  it('K — Movies and TV goals are independent', async () => {
    await setGoal(alice, 2026, 'movies', 1);
    await setGoal(alice, 2026, 'tv_seasons', 1);

    await watch(alice, await movie('A Film'), '2026-02-01');
    assert.deepEqual((await completions(alice)).map((r) => r.category), ['movies']);

    const show = await t.createSeries('A Show', seq++);
    await watch(alice, await t.createSeason(show, 1, 'A Show S1'), '2026-02-02');

    assert.deepEqual(
      (await completions(alice)).map((r) => r.category).sort(),
      ['movies', 'tv_seasons'],
    );
    assert.equal((await feedPosts(alice)).length, 2);
  });

  it('J — the next year is independently eligible', async () => {
    await setGoal(alice, 2026, 'movies', 1);
    await setGoal(alice, 2027, 'movies', 1);
    await watch(alice, await movie('In 2026'), '2026-05-05');
    await watch(alice, await movie('In 2027'), '2027-05-05');

    assert.deepEqual((await completions(alice)).map((r) => r.year), [2026, 2027]);
    assert.equal((await feedPosts(alice)).length, 2);
  });

  /**
   * **The case that forced the trigger to be statement-level**, and it caught a real
   * defect on the first draft.
   *
   * Postgres queues AFTER ROW triggers until the statement finishes, so all five rows
   * are already visible when the first one fires. A per-row trigger therefore sees a
   * count of seven and an "added" of one on every firing — `7 - 1 >= 3` — and a crossing
   * that plainly happened produces nothing at all. Transition tables are what let the
   * trigger know how many rows it actually moved.
   */
  it('completes when one write carries the count several past the target', async () => {
    await setGoal(alice, 2026, 'movies', 3);
    const films = [];
    for (let i = 0; i < 5; i += 1) films.push(await movie(`Batch ${seq}`));
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket, watched_on)
       select $1, unnest($2::uuid[]), 'loved', '2026-06-01'::date`,
      [alice, films],
    );

    assert.equal((await completions(alice)).length, 1);
    assert.equal((await feedPosts(alice)).length, 1);
  });
});

// ---------------------------------------------------------------------------

describe('the six things that must produce nothing', () => {
  it('G — a goal edited downward below an existing count', async () => {
    // No goal while watching, so nothing crossed. Then a goal set below the count.
    for (let i = 0; i < 10; i += 1) await watch(alice, await movie(`Before ${seq}`), '2026-04-01');
    await setGoal(alice, 2026, 'movies', 5);

    assert.deepEqual(await completions(alice), [], 'moving the finish line is not finishing');
    assert.deepEqual(await feedPosts(alice), []);
  });

  it('G2 — and stays silent on the next watch after such an edit', async () => {
    for (let i = 0; i < 10; i += 1) await watch(alice, await movie(`Before ${seq}`), '2026-04-01');
    await setGoal(alice, 2026, 'movies', 5);
    await watch(alice, await movie('After the edit'), '2026-04-02');

    assert.deepEqual(await completions(alice), [], 'they were already past it');
  });

  it('H — an account already above its goal when the feature shipped', async () => {
    // The rollout shape: history exists, a goal exists, and this file contains no
    // backfill. The next watch finds `before >= target` and produces nothing.
    await setGoal(alice, 2026, 'movies', 3);
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket, watched_on)
       select $1, unnest($2::uuid[]), 'loved', '2026-01-01'::date`,
      [alice, [await movie('H1'), await movie('H2'), await movie('H3'), await movie('H4')]],
    );
    await reset(alice);

    // Re-stage the same state, this time as pre-existing history with the ledger clear.
    await t.sql(
      `insert into watch_goals (user_id, year, category, target) values ($1, 2026, 'movies', 3)`,
      [alice],
    );
    await t.sql(`alter table user_media disable trigger goal_on_user_media_insert`);
    for (let i = 0; i < 8; i += 1) await watch(alice, await movie(`History ${seq}`), '2026-01-01');
    await t.sql(`alter table user_media enable trigger goal_on_user_media_insert`);

    assert.deepEqual(await completions(alice), [], 'no historical rollout spam');

    await watch(alice, await movie('One more'), '2026-07-07');
    assert.deepEqual(await completions(alice), [], 'and none on the next watch either');
  });

  it('I — a goal edited upward after a completion, then crossed again', async () => {
    await setGoal(alice, 2026, 'movies', 2);
    await watch(alice, await movie('C1'), '2026-01-01');
    await watch(alice, await movie('C2'), '2026-01-02');
    assert.equal((await feedPosts(alice)).length, 1);

    await setGoal(alice, 2026, 'movies', 4);
    await watch(alice, await movie('C3'), '2026-01-03');
    await watch(alice, await movie('C4'), '2026-01-04');

    assert.equal((await completions(alice)).length, 1, 'one per account, year and medium');
    assert.equal((await feedPosts(alice)).length, 1, 'no second post from a raised target');
    assert.equal((await congrats(alice)).length, 1);
  });

  it('a rewatch', async () => {
    await setGoal(alice, 2026, 'movies', 2);
    const film = await movie('Watched Twice');
    await watch(alice, film, '2026-01-01');
    await watch(alice, film, '2026-06-01');
    await watch(alice, film, '2026-09-01');

    assert.deepEqual(await completions(alice), [], 'one title is one tick, however often');
  });

  it('a series, which belongs to no goal', async () => {
    await setGoal(alice, 2026, 'tv_seasons', 1);
    const show = await t.createSeries('Whole Show', seq++);
    await watch(alice, show, '2026-01-01');

    assert.deepEqual(await completions(alice), []);
  });

  it('a watch with no date', async () => {
    await setGoal(alice, 2026, 'movies', 1);
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket, watched_on)
       values ($1, $2, 'loved', null)`,
      [alice, await movie('Undated')],
    );
    assert.deepEqual(await completions(alice), []);
  });

  it('a watch in a year with no goal', async () => {
    await setGoal(alice, 2026, 'movies', 1);
    await watch(alice, await movie('Wrong year'), '2025-01-01');
    assert.deepEqual(await completions(alice), []);
  });

  it('an edit to the row that does not move the date', async () => {
    await setGoal(alice, 2026, 'movies', 1);
    const film = await movie('Noted');
    await watch(alice, film, '2026-01-01');
    assert.equal((await completions(alice)).length, 1);
    await reset(alice);

    // Re-stage completed, then write a note. The note write must do no goal arithmetic.
    await setGoal(alice, 2026, 'movies', 2);
    await watch(alice, film, '2026-01-01');
    await t.sql(
      `update user_media set note = 'a thought', note_visibility = 'public'
        where user_id = $1 and media_item_id = $2`,
      [alice, film],
    );
    assert.deepEqual(await completions(alice), [], 'a note is not a watch');
  });
});

// ---------------------------------------------------------------------------

describe('E/F — replay and race', () => {
  it('E — re-running the same write produces no duplicate', async () => {
    await setGoal(alice, 2026, 'movies', 1);
    const film = await movie('Idempotent');
    await watch(alice, film, '2026-01-01');
    await watch(alice, film, '2026-01-01');
    await watch(alice, film, '2026-01-01');

    assert.equal((await completions(alice)).length, 1);
    assert.equal((await feedPosts(alice)).length, 1);
    assert.equal((await congrats(alice)).length, 1);
  });

  it('F — the unique indexes refuse a second post even written directly', async () => {
    // The primary key is the mechanism; these are the backstops that state the invariant
    // where a future writer cannot miss it. Asserted by trying to violate them.
    await setGoal(alice, 2026, 'movies', 1);
    await watch(alice, await movie('Once'), '2026-01-01');

    const dupPost = await t.errorFrom(
      `insert into feed_events (actor_id, type, payload)
       values ($1, 'goal_completed', jsonb_build_object('year', 2026, 'category', 'movies', 'target', 1))`,
      [alice],
    );
    assert.equal(dupPost?.code, '23505');

    const dupNote = await t.errorFrom(
      `insert into notifications (recipient_id, type, payload)
       values ($1, 'goal_completed', jsonb_build_object('year', 2026, 'category', 'movies', 'target', 1))`,
      [alice],
    );
    assert.equal(dupNote?.code, '23505');
  });
});

// ---------------------------------------------------------------------------

describe('C/D — push and preferences', () => {
  it('C — the congratulations is push-eligible', async () => {
    const { rows } = await t.sql(`select _push_eligible('goal_completed') as ok`);
    assert.equal(rows[0].ok, true);
  });

  it('D — switching Awards off suppresses the inbox row, and so the push', async () => {
    // Founder §14: goals ride the awards category rather than growing a settings row of
    // their own. The BEFORE trigger drops the notification, so there is nothing to queue.
    await t.sql(
      `insert into notification_preferences (user_id, category, enabled) values ($1, 'awards', false)
       on conflict (user_id, category) do update set enabled = false`,
      [alice],
    );
    try {
      await setGoal(alice, 2026, 'movies', 1);
      await watch(alice, await movie('Quiet'), '2026-01-01');

      assert.deepEqual(await congrats(alice), [], 'no inbox row when the category is off');
      // The social half is not a notification and is unaffected: a preference is about
      // what reaches *you*, not about what your friends see.
      assert.equal((await feedPosts(alice)).length, 1);
      assert.equal((await completions(alice)).length, 1, 'the ledger records it regardless');
    } finally {
      await t.sql(`delete from notification_preferences where user_id = $1`, [alice]);
    }
  });

  it('maps goal_completed to the awards category rather than inventing one', async () => {
    const { rows } = await t.sql(`select _notification_categories() as cats`);
    assert.ok(!rows[0].cats.includes('goals'), 'no new settings category for one type');
  });
});

// ---------------------------------------------------------------------------

describe('M — who may see it', () => {
  it('shows the feed event to an approved viewer and not to a stranger', async () => {
    const shy = await t.createUser({ username: 'gc_shy', visibility: 'private' });
    const friend = await t.createUser({ username: 'gc_friend' });
    const stranger = await t.createUser({ username: 'gc_stranger' });
    await t.sql(
      `insert into follows (follower_id, followee_id, state, approved_at)
       values ($1, $2, 'approved', now())`,
      [friend, shy],
    );

    await setGoal(shy, 2026, 'movies', 1);
    await watch(shy, await movie('Private Win'), '2026-01-01');

    const seenBy = (who) =>
      t.asUser(who, async () => {
        const { rows } = await t.sql(
          `select id from feed_events where actor_id = $1 and type = 'goal_completed'`,
          [shy],
        );
        return rows.length;
      });

    assert.equal(await seenBy(friend), 1, 'an approved follower sees it');
    assert.equal(await seenBy(stranger), 0, 'a stranger does not');
  });

  it('keeps the ledger to its owner', async () => {
    await setGoal(alice, 2026, 'movies', 1);
    await watch(alice, await movie('Mine'), '2026-01-01');
    const other = await t.createUser({ username: 'gc_other' });

    const rows = await t.asUser(other, async () => {
      const { rows } = await t.sql(`select * from goal_completions where user_id = $1`, [alice]);
      return rows;
    });
    assert.deepEqual(rows, [], 'a completion ledger is bookkeeping, not a public surface');
  });
});

// ---------------------------------------------------------------------------

/**
 * The parity guard.
 *
 * `_goal_qualifying_count` is a second statement of the four rules in
 * `src/features/goals/goals.ts`, which that file says must not happen — the same
 * exception `_award_metric` takes for `tracks.ts`, and for the same reason: display stays
 * derived on the client, and the copy here drives only the ledger and the social loop.
 *
 * A behavioural battery pins the semantics above. This pins the *pairing*: both files
 * must still name the same four rules, so a change to one that forgets the other is
 * visible rather than silent.
 */
describe('parity with goals.ts', () => {
  it('states the same four rules the client does', async () => {
    const sql = await readFile(
      join(here, '..', 'migrations', '20260829000200_a_goal_worth_finishing.sql'),
      'utf8',
    );
    const ts = await readFile(
      join(here, '..', '..', 'src', 'features', 'goals', 'goals.ts'),
      'utf8',
    );

    for (const [name, needle] of [
      ['watch date is the only clock', /watched_on/],
      ['a dateless row counts nowhere', /watched_on is not null|unknown watch date/i],
      ['a series belongs to no goal', /rankable_category|series is not a season/i],
      ['a title counts once', /rewatch/i],
    ]) {
      assert.match(sql, needle, `the migration must still state: ${name}`);
      assert.match(ts, needle, `goals.ts must still state: ${name}`);
    }
  });
});
