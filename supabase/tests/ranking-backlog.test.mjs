import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The unranked backlog (unified Backlog + Refine, `20261019000100` §9–§10).
 *
 * What this file has to prove:
 *
 *   1. **One definition of "rankable and unranked"**, in the approved order: an open
 *      first-ranking session, then a bucket chosen in bingd, then seen-but-unranked by
 *      watch date and then by when it was added. Series, seasons still being watched,
 *      watchlist-only and ranked titles are never in it.
 *   2. **Resume, never duplicate.** A native session left mid-comparison comes back as
 *      itself with its answers, from the backlog AND from the ordinary rank_start; a
 *      backlog session comes back from the ordinary rank_start too.
 *   3. **A backlog placement posts nothing** (founder decision 2), while finishing an
 *      abandoned native ranking keeps the native behaviour.
 *   4. **An abandoned sitting leaves an incomplete placement:** the "How was it?" answer
 *      is a real bucket, so next time the title comes back in tier 1.
 */

let t;
let user;
let seq = 0;
let tmdb = 900_000;

before(async () => {
  t = await createTestDb();
  await setConfig('ranking.backlog_enabled', true);
});

after(async () => {
  await t?.close();
});

beforeEach(async () => {
  seq += 1;
  user = await t.createUser({ username: `backlog_${seq}` });
  await t.actAs(user);
});

async function setConfig(key, value) {
  await t.sql(
    `insert into app_config (key, value) values ($1, $2::jsonb)
     on conflict (key) do update set value = excluded.value`,
    [key, JSON.stringify(value)],
  );
}

const op = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
const call = async (sql, params) => (await t.sql(`select ${sql} as r`, params)).rows[0].r;
const movie = (title) => t.createMovie(title, (tmdb += 1));

/** Seen and unranked: a collection row with an optional bucket, date and age. */
async function seen(id, { bucket = null, watchedOn = null, addedDaysAgo = 0 } = {}) {
  await t.sql(
    `insert into user_media (user_id, media_item_id, bucket, created_at)
     values ($1, $2, $3::taste_bucket, now() - make_interval(days => $4::int))`,
    [user, id, bucket, addedDaysAgo],
  );
  if (watchedOn) {
    await t.sql(
      `insert into watch_events (user_id, media_item_id, watched_on, basis)
       values ($1, $2, $3::date, 'reader')`,
      [user, id, watchedOn],
    );
  }
}

/** Three ranked films in `loved`, best first, so a new placement has something to meet. */
async function rankedBand() {
  const ids = [];
  for (const name of ['Top', 'Middle', 'Bottom']) ids.push(await movie(`${name} ${seq}`));
  const truth = [...ids];
  for (const id of ids) {
    await t.rankToCompletion(id, 'loved', (pivot, subject) =>
      truth.indexOf(subject) < truth.indexOf(pivot) ? subject : pivot,
    );
  }
  return truth;
}

const backlog = (skip = [], limit = 20) =>
  call(`ranking_backlog('movies', $1, $2::uuid[])`, [limit, skip]);

const sessions = async (id) =>
  (
    await t.sql(
      `select id, kind, bucket from ranking_sessions where user_id = $1 and media_item_id = $2`,
      [user, id],
    )
  ).rows;

const feedCount = async () =>
  (await t.sql(`select count(*)::int as n from feed_events where actor_id = $1`, [user]))
    .rows[0].n;

/** Answers to completion from `truth` (best first). */
async function finish(first, id, truth) {
  let r = first;
  let guard = 0;
  while (!r.done) {
    const winner = truth.indexOf(id) < truth.indexOf(r.pivot) ? id : r.pivot;
    r = await call(`rank_answer($1, $2, $3)`, [r.session_id, winner, await op()]);
    if ((guard += 1) > 32) throw new Error('did not converge');
  }
  return r;
}

// ---------------------------------------------------------------------------

describe('gating', () => {
  it('is disabled while its flag is off, and refuses to start', async () => {
    await setConfig('ranking.backlog_enabled', false);
    try {
      const id = await movie('Gated');
      await seen(id, { bucket: 'fine' });
      const r = await backlog();
      assert.equal(r.status, 'disabled');
      assert.deepEqual(r.targets, []);
      const e = await t.errorFrom(`select rank_backlog_start($1, null, $2)`, [id, await op()]);
      assert.equal(e?.code, '0A000');
    } finally {
      await setConfig('ranking.backlog_enabled', true);
    }
  });

  it('keeps every threshold in a config row', async () => {
    // Tunable from real use, not code (founder, 2026-09-21).
    const { rows } = await t.sql(
      `select count(*)::int as n from app_config
        where key in ('ranking.backlog_enabled', 'ranking.refine_enabled',
                      'ranking.refine_crossed_min', 'ranking.refine_cta_min_priority',
                      'ranking.refine_cta_min_candidates', 'ranking.refine_resurface_placements',
                      'ranking.backlog_checkpoint')`,
    );
    assert.equal(rows[0].n, 7, 'every threshold is a config row');
  });

  it('is not reachable signed out', async () => {
    const e = await t.asAnon(() => t.errorFrom(`select ranking_backlog('movies')`));
    assert.ok(e, 'anon must be refused');
  });
});

describe('what is in it, and in what order', () => {
  it('open session, then chosen bucket, then by watch date, then by when added', async () => {
    await rankedBand();

    const abandoned = await movie('Abandoned');
    const bucketed = await movie('Bucketed');
    const recent = await movie('Watched recently');
    const older = await movie('Watched long ago');
    const undated = await movie('Undated, newest');
    const undatedOld = await movie('Undated, oldest');

    // A native first ranking left after one answer.
    const opened = await call(`rank_start($1, 'loved', $2)`, [abandoned, await op()]);
    assert.equal(opened.done, false);
    await call(`rank_answer($1, $2, $3)`, [opened.session_id, opened.pivot, await op()]);

    await seen(bucketed, { bucket: 'fine', addedDaysAgo: 30 });
    await seen(recent, { watchedOn: '2026-08-01', addedDaysAgo: 40 });
    await seen(older, { watchedOn: '2020-01-01', addedDaysAgo: 1 });
    await seen(undated, { addedDaysAgo: 2 });
    await seen(undatedOld, { addedDaysAgo: 90 });

    // Never in it.
    const series = await t.createSeries(`Series ${seq}`, (tmdb += 1));
    const watching = await t.createSeason(series, 1, 'Season 1');
    await t.sql(`insert into user_media (user_id, media_item_id) values ($1, $2)`, [
      user,
      series,
    ]);
    await t.sql(
      `insert into user_media (user_id, media_item_id, progress) values ($1, $2, 'watching')`,
      [user, watching],
    );
    const saved = await movie('Saved for later');
    await t.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [
      user,
      saved,
    ]);

    const r = await backlog();
    assert.equal(r.status, 'ready');
    assert.deepEqual(
      r.targets.map((x) => x.media_item_id),
      [abandoned, bucketed, recent, older, undated, undatedOld],
    );
    assert.equal(r.total, 6);
    assert.deepEqual(
      r.targets.map((x) => [x.tier, x.resume]),
      [
        [1, true],
        [1, false],
        [2, false],
        [2, false],
        [2, false],
        [2, false],
      ],
    );
    assert.equal(r.checkpoint_every, 10);

    // TV is its own session: the watching season is excluded there too.
    const tv = await call(`ranking_backlog('tv_seasons', 20, '{}'::uuid[])`);
    assert.equal(tv.status, 'empty');
  });

  it('skips only for the sitting that asked, and says when everything left was skipped', async () => {
    const a = await movie('A');
    const b = await movie('B');
    await seen(a, { addedDaysAgo: 1 });
    await seen(b, { addedDaysAgo: 2 });

    const skipped = await backlog([a]);
    assert.deepEqual(
      skipped.targets.map((x) => x.media_item_id),
      [b],
    );
    assert.equal(skipped.total, 2);
    assert.equal(skipped.remaining, 1);

    const all = await backlog([a, b]);
    assert.equal(all.status, 'skipped');
    assert.equal(all.total, 2);

    // Nothing was stored: a fresh sitting sees both again.
    assert.equal((await backlog()).targets.length, 2);
  });

  it('is only ever the caller’s own collection', async () => {
    const mine = await movie('Mine');
    await seen(mine);
    const other = await t.createUser({ username: `backlog_other_${seq}` });
    await t.actAs(other);
    try {
      assert.equal((await backlog()).status, 'empty');
    } finally {
      await t.actAs(user);
    }
  });
});

describe('opening a placement', () => {
  it('asks for a bucket when none was chosen, and keeps the answer as a real one', async () => {
    await rankedBand();
    const id = await movie('No opinion yet');
    await seen(id);

    const refused = await t.errorFrom(`select rank_backlog_start($1, null, $2)`, [
      id,
      await op(),
    ]);
    assert.equal(refused?.code, '22023');

    const r = await call(`rank_backlog_start($1, 'loved', $2)`, [id, await op()]);
    assert.equal(r.done, false);
    assert.ok(r.pivot_card, 'the first comparison travels with the opening');
    assert.deepEqual(
      (await sessions(id)).map((s) => s.kind),
      ['import'],
    );

    // Left now: an incomplete native placement next time, straight back in tier 1.
    const { rows } = await t.sql(
      `select bucket from user_media where user_id = $1 and media_item_id = $2`,
      [user, id],
    );
    assert.equal(rows[0].bucket, 'loved');
    const next = await backlog();
    assert.deepEqual(
      [next.targets[0].media_item_id, next.targets[0].tier, next.targets[0].resume],
      [id, 1, true],
    );
  });

  it('refuses a title outside the collection and one already ranked', async () => {
    const [top] = await rankedBand();
    const stranger = await movie('Not seen');
    assert.equal(
      (await t.errorFrom(`select rank_backlog_start($1, 'fine', $2)`, [stranger, await op()]))
        ?.code,
      'P0002',
    );
    assert.equal(
      (await t.errorFrom(`select rank_backlog_start($1, 'loved', $2)`, [top, await op()]))
        ?.code,
      '23505',
    );
  });

  it('is idempotent under one operation id', async () => {
    await rankedBand();
    const id = await movie('Twice');
    await seen(id);
    const opId = await op();
    const a = await call(`rank_backlog_start($1, 'loved', $2)`, [id, opId]);
    const b = await call(`rank_backlog_start($1, 'loved', $2)`, [id, opId]);
    assert.equal(a.session_id, b.session_id);
    assert.equal((await sessions(id)).length, 1);
  });
});

describe('resume, never duplicate', () => {
  it('resumes a native session left mid-comparison, with its answers, and it still posts', async () => {
    const truth = await rankedBand();
    const id = await movie('Left halfway');
    truth.splice(1, 0, id); // belongs second

    const opened = await call(`rank_start($1, 'loved', $2)`, [id, await op()]);
    const first = await call(`rank_answer($1, $2, $3)`, [
      opened.session_id,
      truth.indexOf(id) < truth.indexOf(opened.pivot) ? id : opened.pivot,
      await op(),
    ]);
    const answered = (
      await t.sql(`select count(*)::int as n from comparisons where session_id = $1`, [
        opened.session_id,
      ])
    ).rows[0].n;
    assert.equal(answered, 1);

    const resumed = await call(`rank_backlog_start($1, null, $2)`, [id, await op()]);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.session_id, opened.session_id, 'the same session, not a second');
    assert.equal(resumed.pivot, first.pivot, 'back at the comparison that was on screen');
    assert.deepEqual(
      (await sessions(id)).map((s) => s.kind),
      ['first'],
    );

    const before = await feedCount();
    const placed = await finish(resumed, id, truth);
    assert.equal(placed.done, true);
    assert.equal(placed.movement.kind, 'first');
    assert.equal(await feedCount(), before + 1, 'a native ranking finished late still posts');
  });

  it('the ordinary rank_start resumes a backlog session instead of restarting it', async () => {
    const truth = await rankedBand();
    const id = await movie('Started in the backlog');
    await seen(id);
    truth.push(id); // belongs last

    const opened = await call(`rank_backlog_start($1, 'loved', $2)`, [id, await op()]);
    const first = await call(`rank_answer($1, $2, $3)`, [
      opened.session_id,
      opened.pivot,
      await op(),
    ]);
    assert.equal(first.done, false);

    // + / Rank on the title page: #196's resume path.
    const again = await call(`rank_start($1, 'loved', $2)`, [id, await op()]);
    assert.equal(again.resumed, true);
    assert.equal(again.session_id, opened.session_id);
    assert.equal((await sessions(id)).length, 1);

    const before = await feedCount();
    const placed = await finish(again, id, truth);
    assert.equal(placed.movement.kind, 'import');
    assert.equal(await feedCount(), before, 'still a backlog placement: nothing posted');
  });

  it('a different answer to "How was it?" is a different search', async () => {
    await rankedBand();
    const id = await movie('Changed my mind');
    await seen(id);
    const opened = await call(`rank_backlog_start($1, 'loved', $2)`, [id, await op()]);
    const moved = await call(`rank_start($1, 'fine', $2)`, [id, await op()]);
    assert.notEqual(moved.session_id ?? null, opened.session_id);
    const rows = await sessions(id);
    assert.ok(rows.length <= 1, 'never two sessions for one title');
    assert.ok(rows.every((s) => s.bucket === 'fine'));
  });
});

describe('the feed', () => {
  it('a backlog placement updates the ranking and posts nothing', async () => {
    const truth = await rankedBand();
    const id = await movie('Old favourite');
    await seen(id, { watchedOn: '2019-05-01' });
    truth.unshift(id); // belongs first

    const before = await feedCount();
    const placed = await finish(
      await call(`rank_backlog_start($1, 'loved', $2)`, [id, await op()]),
      id,
      truth,
    );
    assert.equal(placed.done, true);
    assert.equal(placed.position, 1);
    assert.equal(await feedCount(), before, 'no feed activity');

    const { rows } = await t.sql(
      `select kind, outcome from ranking_placements where user_id = $1 and media_item_id = $2`,
      [user, id],
    );
    assert.deepEqual(rows, [{ kind: 'import', outcome: 'placed' }]);
    await t.assertValid(user);
    assert.equal((await backlog()).status, 'empty');
  });

  it('a first title in an empty band places at once, silently', async () => {
    const id = await movie('Alone');
    await seen(id);
    const before = await feedCount();
    const r = await call(`rank_backlog_start($1, 'not_for_me', $2)`, [id, await op()]);
    assert.equal(r.done, true);
    assert.equal(await feedCount(), before);
  });
});
