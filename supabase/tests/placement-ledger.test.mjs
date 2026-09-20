import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb, one } from './harness.mjs';

/**
 * T2 — the placement ledger (`20261004000100`, §E).
 *
 * The ledger's whole value is that it is **complete and honest**: every current ranking
 * has a row explaining it, every row's `from_position` is the live ordinal immediately
 * before rather than the one a previous row recorded, and no row claims a movement that
 * no answer produced.
 *
 * §E.2 is the assertion this file exists for. After twelve films were ranked above Heat
 * it sits at #30, not the #18 its last placement recorded, and printing "moved 11" when
 * it really moved 23 is a false statement about the reader's own list.
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
  user = await t.createUser({ username: `ledger_${seq}` });
  await t.actAs(user);
});

const movie = (title) => t.createMovie(title, (seq += 1) + 50000);
const op = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
const call = async (sql, params) => (await t.sql(`select ${sql} as r`, params)).rows[0].r;

const placements = async (mediaItemId) => {
  const { rows } = await t.sql(
    `select kind, outcome, position, from_position, from_score, score, band_rank,
            band_size, category_size, strategy, comparisons, adjustable, watch_event_id
       from ranking_placements
      where user_id = $1 and media_item_id = $2
      order by created_at, id`,
    [user, mediaItemId],
  );
  return rows;
};

const valid = async () => {
  await t.sql(`select assert_placements_valid($1)`, [user]);
  await t.sql(`select assert_ranking_valid($1, 'movies')`, [user]);
};

/** A band of `n` loved movies in a known order, inserted directly. */
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
    await t.sql(
      `insert into ranking_placements (user_id, media_item_id, category, kind, outcome,
         bucket, position, band_rank, band_size, category_size, score)
       values ($1, $2, 'movies', 'backfill', 'placed', 'loved', $3, $3, $4, $3, 8.0)`,
      [user, m, i + 1, n],
    );
  }
  return ids;
};

/** Re-checks `ids[at]`, answering as if `truth` is where it belongs. */
const recheck = async (ids, at, truth, { newWatch = false, watchEvent = null } = {}) => {
  let r = await call(`rank_again($1, 'loved', $2, $3, $4)`, [
    ids[at],
    await op(),
    newWatch,
    watchEvent,
  ]);
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

describe('§E.2 from_position is the LIVE ordinal, not the one a previous row recorded', () => {
  it('after twelve titles were ranked above it, the movement is from where it IS', async () => {
    // Heat is placed at #18 of 34. Twelve films are then ranked above it, so it sits at
    // #30 without anybody touching it. A re-check that moves it to #7 moved it 23
    // places, not 11 — and the previous ledger row still says #18, truthfully, about
    // a list that no longer exists.
    const ids = await band(34, 'Base');
    const heat = ids[17];
    assert.equal((await placements(heat))[0].position, 18);

    for (let i = 0; i < 12; i += 1) {
      const m = await movie(`Above ${i}`);
      await t.sql(
        `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`,
        [user, m],
      );
      await t.sql(
        `update rankings set position = position + 1 where user_id = $1 and position >= 1`,
        [user],
      );
      await t.sql(
        `insert into rankings (user_id, media_item_id, category, bucket, position)
         values ($1, $2, 'movies', 'loved', 1)`,
        [user, m],
      );
      await t.sql(
        `insert into ranking_placements (user_id, media_item_id, category, kind, outcome,
           bucket, position, band_rank, band_size, category_size, score)
         values ($1, $2, 'movies', 'first', 'placed', 'loved', 1, 1, 34, 34, 9.9)`,
        [user, m],
      );
      ids.unshift(m);
    }

    const { rows: now } = await t.sql(
      `select position from rankings where user_id = $1 and media_item_id = $2`,
      [user, heat],
    );
    assert.equal(now[0].position, 30, 'it moved without being touched');

    const at = ids.indexOf(heat);
    const r = await recheck(ids, at, 6);

    assert.equal(r.position, 7);
    assert.equal(r.movement.from_position, 30, '**the live ordinal**, not the stored 18');
    assert.equal(r.movement.outcome, 'moved');

    const rows = await placements(heat);
    assert.equal(rows.at(-1).from_position, 30);
    assert.equal(rows[0].position, 18, 'and the older row still says 18, about then');
    await valid();
  });
});

describe('§E.3 the no-op finalize', () => {
  it('an unchanged re-check leaves rankings entirely alone', async () => {
    // No delete, no insert, no trigger churn, no created_at change. T0 had to carry
    // created_at across a delete-and-insert by hand; not opening the gap is better.
    const ids = await band(20, 'NoOp');
    const at = 10;
    const { rows: before } = await t.sql(
      `select created_at, position from rankings where user_id = $1 and media_item_id = $2`,
      [user, ids[at]],
    );

    const r = await recheck(ids, at, at);
    assert.equal(r.movement.outcome, 'unchanged');

    const { rows: after } = await t.sql(
      `select created_at, position from rankings where user_id = $1 and media_item_id = $2`,
      [user, ids[at]],
    );
    assert.equal(after[0].position, before[0].position);
    assert.equal(
      after[0].created_at.getTime(),
      before[0].created_at.getTime(),
      'the instant the ranking already had',
    );

    // And the ledger still records the visit: "we checked, and it was right" is a fact
    // worth keeping, and §G reads it as `last_confirmed_at`.
    assert.equal((await placements(ids[at])).at(-1).outcome, 'unchanged');
    await valid();
  });

  it('records a row even though nothing moved, so confidence has something to read', async () => {
    const ids = await band(20, 'Confirm');
    const before = (await placements(ids[5])).length;
    await recheck(ids, 5, 5);
    assert.equal((await placements(ids[5])).length, before + 1);
  });
});

describe('§E.1 outcomes', () => {
  it('placed: a first ranking has no prior', async () => {
    await band(6, 'First');
    const fresh = await movie('Fresh one');
    let r = await one(t.db, `select rank_start($1, 'loved') as r`, [fresh]);
    while (!r.done) {
      r = await one(t.db, `select rank_answer($1, $2) as r`, [r.session_id, fresh]);
    }
    const rows = await placements(fresh);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'first');
    assert.equal(rows[0].outcome, 'placed');
    assert.equal(rows[0].from_position, null);
    assert.equal(rows[0].strategy, 'bisect');
    await valid();
  });

  it('kept: three Too toughs resolve at the prior, and say so', async () => {
    const ids = await band(30, 'Tough');
    const at = 15;
    let r = await call(`rank_again($1, 'loved', $2, false, null)`, [ids[at], await op()]);
    while (!r.done) {
      r = await call(`rank_skip($1, $2)`, [r.session_id, await op()]);
    }
    assert.equal(r.position, at + 1, 'a reader who could not call it has not moved it');
    assert.equal(r.movement.outcome, 'kept');
    assert.equal((await placements(ids[at])).at(-1).adjustable, true);
    await valid();
  });

  it('moved: the bucket changing is a movement even at the same ordinal', async () => {
    const ids = await band(8, 'Rebucket');
    const r0 = await call(`rank_rebucket($1, 'fine', $2)`, [ids[3], await op()]);
    let r = r0;
    while (!r.done) {
      r = await call(`rank_answer($1, $2, $3)`, [r.session_id, ids[3], await op()]);
    }
    const row = (await placements(ids[3])).at(-1);
    assert.equal(row.kind, 'correction');
    assert.equal(row.outcome, 'moved');
    await valid();
  });
});

describe('§A.3 clean comparison evidence', () => {
  it('Undo withdraws the answer it took back, and it is never linked', async () => {
    const ids = await band(20, 'Undo');
    const at = 10;
    let r = await call(`rank_again($1, 'loved', $2, false, null)`, [ids[at], await op()]);
    const first = r.pivot;
    r = await call(`rank_answer($1, $2, $3)`, [r.session_id, ids[at], await op()]);

    const session = r.session_id;
    await call(`rank_back($1, $2)`, [session, await op()]);

    const { rows } = await t.sql(
      `select withdrawn_at, placement_id from comparisons where session_id = $1`,
      [session],
    );
    assert.equal(rows.length, 1, 'the row stays: "they answered and undid it" is a fact');
    assert.notEqual(rows[0].withdrawn_at, null, 'but it is not evidence');
    assert.equal(rows[0].placement_id, null);

    // Finish it, and the withdrawn answer must still not be linked.
    let r2 = await call(`rank_answer($1, $2, $3)`, [session, first, await op()]);
    let guard = 0;
    while (!r2.done) {
      r2 = await call(`rank_answer($1, $2, $3)`, [r2.session_id, r2.pivot, await op()]);
      if ((guard += 1) > 64) throw new Error('did not converge');
    }

    const { rows: after } = await t.sql(
      `select withdrawn_at, placement_id from comparisons where session_id = $1`,
      [session],
    );
    for (const row of after) {
      if (row.withdrawn_at) assert.equal(row.placement_id, null, 'withdrawn, never linked');
    }
    await valid();
  });

  it('a completed placement links exactly the answers that produced it', async () => {
    const ids = await band(40, 'Link');
    const r = await recheck(ids, 20, 5);
    const { rows } = await t.sql(
      `select count(*)::int as n from comparisons
        where user_id = $1 and placement_id = $2 and withdrawn_at is null`,
      [user, r.placement_id],
    );
    assert.equal(rows[0].n, (await placements(ids[20])).at(-1).comparisons);
    assert.ok(rows[0].n > 0);
  });
});

describe('§E.4 the backfill, and the invariant it establishes', () => {
  it('assert_placements_valid holds for a freshly migrated database', async () => {
    await t.sql(`select assert_placements_valid()`);
  });

  it('P1 catches a ranking with no placement, which is what rank_reorder would leave', async () => {
    const m = await movie('Orphan');
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`,
      [user, m],
    );
    await t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       values ($1, $2, 'movies', 'loved', 1)`,
      [user, m],
    );
    const err = await t.errorFrom(`select assert_placements_valid($1)`, [user]);
    assert.match(String(err?.message), /P1 violated/);
  });
});

describe('T2 writes no watch history (§D.6 paths 3, 4, 12)', () => {
  it('a correction writes no watch event and no date', async () => {
    const ids = await band(20, 'Silent');
    const before = await t.sql(
      `select count(*)::int as n from watch_events where user_id = $1 and media_item_id = $2`,
      [user, ids[9]],
    );
    await recheck(ids, 9, 3);
    const after = await t.sql(
      `select count(*)::int as n from watch_events where user_id = $1 and media_item_id = $2`,
      [user, ids[9]],
    );
    assert.equal(after.rows[0].n, before.rows[0].n, 'ranking says nothing about when');

    const { rows } = await t.sql(
      `select watched_on from user_media where user_id = $1 and media_item_id = $2`,
      [user, ids[9]],
    );
    assert.equal(rows[0].watched_on, null);
    await t.sql(`select assert_watch_history_valid($1)`, [user]);
  });
});
