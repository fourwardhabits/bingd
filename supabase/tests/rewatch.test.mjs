import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * T3 — the rewatch server (`20261005000100`, §D.5, §K).
 *
 * The contract, and the one sentence that makes it testable: **one viewing, one
 * activity**, whichever order the reader does the two halves in. Logging a rewatch and
 * then re-checking the placement is one act with two parts, not two acts, and the
 * founder's 2026-09-07 report — two "ranked" rows in the feed for one watch — is what
 * happens when a product forgets that.
 */

let t;
let user;
let seq = 0;

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

beforeEach(async () => {
  seq += 1;
  user = await t.createUser({ username: `rewatch_${seq}` });
  await t.actAs(user);
});

const movie = (title) => t.createMovie(title, (seq += 1) + 60000);
const op = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
const call = async (sql, params) => (await t.sql(`select ${sql} as r`, params)).rows[0].r;

const band = async (n, label) => {
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const m = await movie(`${label} ${i}`);
    ids.push(m);
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`,
      [user, m],
    );
    await t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       values ($1, $2, 'movies', 'loved', $3)`,
      [user, m, i + 1],
    );
    // No explicit watch event: `_seen_implies_a_watch` gives the row its undated one at
    // commit, and inserting a second here left every title with two viewings before the
    // test had logged anything — which is what made the first run of this file report
    // three watches where the rewatch had produced two.
    await t.sql(
      `insert into ranking_placements (user_id, media_item_id, category, kind, outcome,
         bucket, position, band_rank, band_size, category_size, score)
       values ($1, $2, 'movies', 'backfill', 'placed', 'loved', $3, $3, $4, $3, 8.0)`,
      [user, m, i + 1, n],
    );
  }
  return ids;
};

const posts = async (mediaItemId) => {
  const { rows } = await t.sql(
    `select id, payload from feed_events
      where actor_id = $1 and media_item_id = $2 and type = 'title_ranked'
      order by created_at, id`,
    [user, mediaItemId],
  );
  return rows;
};

const watchCount = async (mediaItemId) =>
  (
    await t.sql(
      `select count(*)::int as n from watch_events where user_id = $1 and media_item_id = $2`,
      [user, mediaItemId],
    )
  ).rows[0].n;

const valid = async () => {
  await t.sql(`select assert_watch_history_valid($1)`, [user]);
  await t.sql(`select assert_placements_valid($1)`, [user]);
};

describe('log_rewatch records a viewing, and changes no ranking', () => {
  it('adds an event, reports the count, and leaves the position alone', async () => {
    const ids = await band(10, 'Keep');
    const target = ids[4];
    const r = await call(`log_rewatch($1, $2, current_date, 'today_default')`, [
      await op(),
      target,
    ]);

    assert.equal(r.status, 'ok');
    assert.equal(r.watch_count, 2);
    assert.equal(await watchCount(target), 2);

    const { rows } = await t.sql(
      `select position from rankings where user_id = $1 and media_item_id = $2`,
      [user, target],
    );
    assert.equal(rows[0].position, 5, 'Save and close is a complete act');
    await valid();
  });

  it('refuses a title that is not in the collection', async () => {
    const m = await movie('Never seen');
    const err = await t.errorFrom(
      `select log_rewatch($1, $2, current_date, 'today_default')`,
      [await op(), m],
    );
    assert.equal(err?.code, 'P0002');
  });

  it('allows a same-day duplicate, which the client confirms rather than the server', async () => {
    const ids = await band(6, 'Twice');
    await call(`log_rewatch($1, $2, current_date, 'today_default')`, [await op(), ids[1]]);
    const r = await call(`log_rewatch($1, $2, current_date, 'today_default')`, [
      await op(),
      ids[1],
    ]);
    assert.equal(r.watch_count, 3);
    await valid();
  });

  it('replays to the same answer and logs no second viewing', async () => {
    const ids = await band(6, 'Replay');
    const id = await op();
    const first = await call(`log_rewatch($1, $2, current_date, 'today_default')`, [id, ids[1]]);
    const again = await call(`log_rewatch($1, $2, current_date, 'today_default')`, [id, ids[1]]);
    assert.deepEqual(again, first);
    assert.equal(await watchCount(ids[1]), 2);
  });
});

describe('§K which rewatches reach the feed', () => {
  it('a rewatch dated today posts once, marked again', async () => {
    const ids = await band(10, 'Post');
    const r = await call(`log_rewatch($1, $2, current_date, 'today_default')`, [
      await op(),
      ids[3],
    ]);
    assert.equal(r.posted, true);

    const rows = await posts(ids[3]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.again, true);
    assert.equal(rows[0].payload.watch_event_id, r.watch_event_id);
    assert.equal(typeof rows[0].payload.score, 'number');
  });

  it('a BACKDATED rewatch posts nothing', async () => {
    // A post is a statement about now, and the feed has no other tense.
    const ids = await band(10, 'Backdated');
    const r = await call(`log_rewatch($1, $2, current_date - 400, 'reader')`, [
      await op(),
      ids[3],
    ]);
    assert.equal(r.posted, false);
    assert.deepEqual(await posts(ids[3]), []);
    assert.equal(await watchCount(ids[3]), 2, 'but the viewing is recorded');
  });

  it('an UNDATED rewatch posts nothing', async () => {
    const ids = await band(10, 'Undated');
    const r = await call(`log_rewatch($1, $2, null, 'none')`, [await op(), ids[3]]);
    assert.equal(r.posted, false);
    assert.deepEqual(await posts(ids[3]), []);
  });

  it('a rewatch of an UNRANKED seen title posts nothing, because there is no score', async () => {
    const m = await movie('Seen, unranked');
    await call(`log_title($1, $2, 'fine', null, 'none')`, [await op(), m]);
    const r = await call(`log_rewatch($1, $2, current_date, 'today_default')`, [await op(), m]);
    assert.equal(r.posted, false);
    assert.equal(await watchCount(m), 2);
    await valid();
  });

  it('the payload carries NO movement, so no client can ever render it', async () => {
    // §K, §E.2: the privacy rule lives in the data rather than in a template.
    const ids = await band(10, 'Private');
    const r = await call(`log_rewatch($1, $2, current_date, 'today_default')`, [
      await op(),
      ids[3],
    ]);
    const payload = (await posts(ids[3]))[0].payload;
    assert.equal(payload.from_position, undefined);
    assert.equal(payload.from_score, undefined);
    assert.equal(payload.outcome, undefined);
    assert.equal(payload.watched_on, undefined, 'and never the date');
    assert.ok(r.watch_event_id);
  });

  it('the flag stops the posting without stopping the recording', async () => {
    const ids = await band(10, 'Flagged');
    await t.sql(`update app_config set value = 'false'::jsonb where key = 'feed.rewatch_posts'`);
    try {
      const r = await call(`log_rewatch($1, $2, current_date, 'today_default')`, [
        await op(),
        ids[3],
      ]);
      assert.equal(r.posted, false);
      assert.equal(await watchCount(ids[3]), 2, 'the viewing is the reader’s, not the feed’s');
    } finally {
      await t.sql(`update app_config set value = 'true'::jsonb where key = 'feed.rewatch_posts'`);
    }
  });
});

describe('§K Re-check enriches the SAME activity', () => {
  const recheck = async (ids, at, truth, watchEvent) => {
    let r = await call(`rank_again($1, 'loved', $2, true, $3)`, [ids[at], await op(), watchEvent]);
    let guard = 0;
    while (!r.done) {
      const rival = ids.indexOf(r.pivot);
      const rivalExcluded = rival < at ? rival : rival - 1;
      const winner = truth <= rivalExcluded ? ids[at] : r.pivot;
      r = await call(`rank_answer($1, $2, $3)`, [r.session_id, winner, await op()]);
      if ((guard += 1) > 64) throw new Error('did not converge');
    }
    return r;
  };

  it('one viewing produces ONE post, whose score follows the re-check', async () => {
    const ids = await band(20, 'Enrich');
    const at = 10;
    const logged = await call(`log_rewatch($1, $2, current_date, 'today_default')`, [
      await op(),
      ids[at],
    ]);
    const before = await posts(ids[at]);
    assert.equal(before.length, 1);
    const scoreBefore = before[0].payload.score;

    const r = await recheck(ids, at, 1, logged.watch_event_id);
    assert.equal(r.position, 2, 'it moved a long way up');

    const after = await posts(ids[at]);
    assert.equal(after.length, 1, '**one activity for one viewing**');
    assert.equal(after[0].id, before[0].id, 'and it is the same row');
    assert.equal(after[0].payload.position, 2);
    assert.notEqual(after[0].payload.score, scoreBefore, 'the score followed the re-check');
    assert.equal(after[0].payload.again, true);
    assert.equal(after[0].payload.from_position, undefined, 'still no movement in the feed');
    await valid();
  });

  it('the placement links to the viewing that prompted it', async () => {
    const ids = await band(20, 'Linked');
    const logged = await call(`log_rewatch($1, $2, current_date, 'today_default')`, [
      await op(),
      ids[8],
    ]);
    const r = await recheck(ids, 8, 8, logged.watch_event_id);
    const { rows } = await t.sql(
      `select watch_event_id, kind from ranking_placements where id = $1`,
      [r.placement_id],
    );
    assert.equal(rows[0].watch_event_id, logged.watch_event_id);
    assert.equal(rows[0].kind, 'rewatch');
  });

  it('a re-check of a BACKDATED rewatch still posts nothing', async () => {
    // Nothing to enrich, and nothing earned a post: the viewing was not contemporaneous
    // and the re-check is not a separate act.
    const ids = await band(20, 'BackRecheck');
    const logged = await call(`log_rewatch($1, $2, current_date - 400, 'reader')`, [
      await op(),
      ids[8],
    ]);
    await recheck(ids, 8, 4, logged.watch_event_id);
    assert.deepEqual(await posts(ids[8]), [], 'the feed has no past tense');
    await valid();
  });

  it('refuses a watch event that is not this reader’s, or not this title’s', async () => {
    const ids = await band(8, 'Wrong');
    const logged = await call(`log_rewatch($1, $2, current_date, 'today_default')`, [
      await op(),
      ids[1],
    ]);
    const err = await t.errorFrom(`select rank_again($1, 'loved', $2, true, $3)`, [
      ids[2],
      await op(),
      logged.watch_event_id,
    ]);
    assert.equal(err?.code, 'P0002');
  });
});

describe('§D.6 path 15 — an installed client’s rewatch', () => {
  it('gets an UNDATED event, no fabricated date, and posts as it always did', async () => {
    // The four-argument call an iOS 1.0.1 build makes. That client offered the reader no
    // date control, so the server has nothing to date it with, and now() would be the
    // fabricated watch date §B.2 forbids.
    const ids = await band(20, 'Legacy');
    const at = 9;
    let r = await call(`rank_again($1, 'loved', $2, true)`, [ids[at], await op()]);
    let guard = 0;
    while (!r.done) {
      const rival = ids.indexOf(r.pivot);
      const rivalExcluded = rival < at ? rival : rival - 1;
      const winner = at <= rivalExcluded ? ids[at] : r.pivot;
      r = await call(`rank_answer($1, $2, $3)`, [r.session_id, winner, await op()]);
      if ((guard += 1) > 64) throw new Error('did not converge');
    }

    assert.equal(await watchCount(ids[at]), 2, 'the rewatch is recorded');
    const { rows } = await t.sql(
      `select watched_on, basis from watch_events
        where user_id = $1 and media_item_id = $2 order by recorded_at desc limit 1`,
      [user, ids[at]],
    );
    assert.equal(rows[0].watched_on, null, '**no fabricated date**');
    assert.equal(rows[0].basis, 'none');

    const { rows: cache } = await t.sql(
      `select watched_on from user_media where user_id = $1 and media_item_id = $2`,
      [user, ids[at]],
    );
    assert.equal(cache[0].watched_on, null);

    const p = await posts(ids[at]);
    assert.equal(p.length, 1, 'one activity, as that client produces today');
    assert.equal(p[0].payload.again, true);
    await valid();
  });

  it('while Update your rating from the same client posts nothing and records nothing', async () => {
    const ids = await band(20, 'LegacyCorrect');
    const at = 9;
    let r = await call(`rank_again($1, 'loved', $2, false)`, [ids[at], await op()]);
    let guard = 0;
    while (!r.done) {
      const rival = ids.indexOf(r.pivot);
      const rivalExcluded = rival < at ? rival : rival - 1;
      const winner = 3 <= rivalExcluded ? ids[at] : r.pivot;
      r = await call(`rank_answer($1, $2, $3)`, [r.session_id, winner, await op()]);
      if ((guard += 1) > 64) throw new Error('did not converge');
    }
    assert.equal(await watchCount(ids[at]), 1, 'a correction is not a watch');
    assert.deepEqual(await posts(ids[at]), []);
    await valid();
  });
});

describe('edit and delete (§D.5, §J.2)', () => {
  it('edit changes the date and never creates a viewing', async () => {
    const ids = await band(6, 'Edit');
    const logged = await call(`log_rewatch($1, $2, current_date, 'today_default')`, [
      await op(),
      ids[1],
    ]);
    await call(`edit_watch_event($1, $2, date '2019-04-04', 'reader')`, [
      await op(),
      logged.watch_event_id,
    ]);
    assert.equal(await watchCount(ids[1]), 2);
    const { rows } = await t.sql(`select watched_on, basis from watch_events where id = $1`, [
      logged.watch_event_id,
    ]);
    assert.equal(new Date(rows[0].watched_on).toISOString().slice(0, 10), '2019-04-04');
    assert.equal(rows[0].basis, 'reader');
    await valid();
  });

  it('edit to no date sets basis none, and the cache comes back down', async () => {
    const ids = await band(6, 'Undate');
    const logged = await call(`log_rewatch($1, $2, current_date, 'today_default')`, [
      await op(),
      ids[1],
    ]);
    await call(`edit_watch_event($1, $2, null, 'none')`, [await op(), logged.watch_event_id]);
    const { rows } = await t.sql(
      `select watched_on from user_media where user_id = $1 and media_item_id = $2`,
      [user, ids[1]],
    );
    assert.equal(rows[0].watched_on, null);
    await valid();
  });

  it('delete removes the viewing AND its post', async () => {
    const ids = await band(6, 'Delete');
    const logged = await call(`log_rewatch($1, $2, current_date, 'today_default')`, [
      await op(),
      ids[1],
    ]);
    assert.equal((await posts(ids[1])).length, 1);

    const r = await call(`delete_watch_event($1, $2)`, [await op(), logged.watch_event_id]);
    assert.equal(r.watch_count, 1);
    assert.equal(await watchCount(ids[1]), 1);
    assert.deepEqual(await posts(ids[1]), [], 'the activity said a viewing happened');
    await valid();
  });

  it('delete refuses the LAST watch with P0001 last_watch', async () => {
    // The §D.0 invariant defended at its only remaining exit. The client turns this into
    // *Remove from collection…*.
    const ids = await band(6, 'Last');
    const { rows } = await t.sql(
      `select id from watch_events where user_id = $1 and media_item_id = $2`,
      [user, ids[1]],
    );
    const err = await t.errorFrom(`select delete_watch_event($1, $2)`, [await op(), rows[0].id]);
    assert.equal(err?.code, 'P0001');
    assert.match(String(err?.message), /last_watch/);
    assert.equal(await watchCount(ids[1]), 1);
  });

  it('delete keeps the placement and only forgets which viewing prompted it', async () => {
    const ids = await band(20, 'Unlink');
    const at = 8;
    const logged = await call(`log_rewatch($1, $2, current_date, 'today_default')`, [
      await op(),
      ids[at],
    ]);
    let r = await call(`rank_again($1, 'loved', $2, true, $3)`, [
      ids[at],
      await op(),
      logged.watch_event_id,
    ]);
    let guard = 0;
    while (!r.done) {
      const rival = ids.indexOf(r.pivot);
      const rivalExcluded = rival < at ? rival : rival - 1;
      r = await call(`rank_answer($1, $2, $3)`, [
        r.session_id,
        at <= rivalExcluded ? ids[at] : r.pivot,
        await op(),
      ]);
      if ((guard += 1) > 64) throw new Error('did not converge');
    }

    await call(`delete_watch_event($1, $2)`, [await op(), logged.watch_event_id]);

    const { rows } = await t.sql(
      `select watch_event_id from ranking_placements where id = $1`,
      [r.placement_id],
    );
    assert.equal(rows.length, 1, 'the placement is still true: the title WAS re-placed');
    assert.equal(rows[0].watch_event_id, null, 'only the prompt is forgotten');
    await valid();
  });

  it('neither writer touches somebody else’s history', async () => {
    const ids = await band(6, 'Mine');
    const { rows } = await t.sql(
      `select id from watch_events where user_id = $1 and media_item_id = $2`,
      [user, ids[0]],
    );
    const other = await t.createUser({ username: `thief_${seq}` });
    await t.actAs(other);
    // Absent rather than forbidden: whether somebody else has a viewing of a film is not
    // a client's business to learn from an error code.
    for (const sql of [
      `edit_watch_event($1, $2, current_date, 'reader')`,
      `delete_watch_event($1, $2)`,
    ]) {
      const err = await t.errorFrom(`select ${sql}`, [await op(), rows[0].id]);
      assert.equal(err?.code, 'P0002');
    }
    await t.actAs(user);
  });
});
