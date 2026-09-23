import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { createTestDb, one } from './harness.mjs';
import { nextPivot, settleAt } from '../../scripts/sim/rerank.mjs';

/**
 * T2 — the prior-anchored search (`20261004000100`, §F).
 *
 * Three things are proved here, and the first is the one that keeps the other two
 * honest:
 *
 *   **Policy equivalence** (§O.2). `scripts/sim/rerank.mjs` holds a second
 *   implementation of `next_pivot`, and the §F.3 cost table and the `G` knob are both
 *   read off it. Two implementations of one rule is ordinarily a liability; it is the
 *   instrument here, and the fuzz below is what stops it becoming the liability. A
 *   simulator that has drifted from the database is worse than no simulator, because it
 *   is confidently wrong about a number somebody is about to tune.
 *
 *   **The cost**. §F.3's claim is that a re-check where nothing changed costs 2
 *   comparisons rather than 6–9. Asserted against the real RPCs, not the model.
 *
 *   **The invariants**. A noise-free prior search must equal plain bisection in where it
 *   LANDS, always — the policy chooses cheaper questions, never different answers. And
 *   nothing moves without an answer.
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

const movie = (title) => t.createMovie(title, (seq += 1) + 40000);
const op = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
const call = async (sql, params) => (await t.sql(`select ${sql} as r`, params)).rows[0].r;

describe('§O.2 policy equivalence: the simulator and the database agree', () => {
  it('over 4000 random states, including every degenerate one', async () => {
    // A seeded LCG rather than Math.random: a failure has to be reproducible, and
    // "it failed once in CI" is the least useful bug report this suite could produce.
    let s = 20261004;
    const rnd = (m) => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return Math.floor((s / 2147483648) * m);
    };

    const cases = [];
    // The degenerate states first, explicitly, because random sampling reaches them
    // rarely and they are where an off-by-one lives: empty ranges, the band edges, a
    // prior outside the range on either side, and a zero gallop.
    for (const [lo, hi, p, w, n, g] of [
      [0, 0, 0, 0, 0, 3],
      [0, 1, 0, 0, 1, 3],
      [0, 1, 1, 0, 1, 3],
      [0, 50, 0, 0, 50, 3],
      [0, 50, 50, 0, 50, 3],
      [0, 50, 25, 0, 50, 0],
      [25, 25, 25, 0, 50, 3],
      [0, 10, 25, 0, 50, 3],
      [40, 50, 25, 0, 50, 3],
      [0, 50, 25, 7, 50, 3],
      [10, 12, 11, 7, 50, 3],
    ]) {
      cases.push([lo, hi, p, w, n, g]);
    }

    for (let i = 0; i < 4000; i += 1) {
      const n = rnd(400) + 1;
      const lo = rnd(n + 1);
      const hi = lo + rnd(n + 1 - lo);
      const p = rnd(n + 1);
      const w = rnd(9);
      const g = rnd(7);
      cases.push([lo, hi, p, w, n, g]);
    }

    // One round trip for the lot. Four thousand `select next_pivot(...)` calls through
    // PGlite is a minute of wall clock and this is milliseconds; the assertion is
    // identical either way.
    //
    // Passed as jsonb rather than `integer[][]`, because `unnest` on a multidimensional
    // array FLATTENS it to scalars -- there is no "unnest the outer dimension" -- and
    // subscripting the scalar it hands back is the error this first produced.
    const { rows } = await t.sql(
      `select i,
              next_pivot((c ->> 0)::int, (c ->> 1)::int, (c ->> 2)::int,
                         (c ->> 3)::int, (c ->> 4)::int, (c ->> 5)::int) as sql_answer
         from jsonb_array_elements($1::jsonb) with ordinality as u(c, i)`,
      [JSON.stringify(cases)],
    );

    assert.equal(rows.length, cases.length, 'every case came back');
    for (const row of rows) {
      const [lo, hi, p, w, n, g] = cases[row.i - 1];
      assert.equal(
        row.sql_answer,
        nextPivot(lo, hi, p, w, n, g),
        `next_pivot(${lo}, ${hi}, ${p}, ${w}, ${n}, ${g})`,
      );
    }
  });

  it('and on where the search settles', async () => {
    for (const [lo, hi, strategy, p, w] of [
      [0, 0, 'prior', 0, 0],
      [3, 3, 'prior', 7, 0],
      [0, 50, 'prior', 25, 0],
      [0, 50, 'prior', 60, 0],
      [30, 50, 'prior', 25, 0],
      [0, 50, 'bisect', 25, 0],
      [0, 50, 'prior', null, 0],
    ]) {
      const sql = await call(`_rank_settle_at($1, $2, $3, $4, $5)`, [lo, hi, strategy, p, w]);
      assert.equal(sql, settleAt(lo, hi, strategy, p, w), `_rank_settle_at(${lo}, ${hi})`);
    }
  });
});

describe('§F.3 the cost, against the real RPCs', () => {
  /**
   * Builds a band of `n` loved movies in a known order, then re-checks the one at
   * `priorIndex` against an oracle whose true order is the one already stored — so
   * "nothing changed" is the honest answer to every comparison.
   */
  const buildBand = async (n, label) => {
    seq += 1;
    const u = await t.createUser({ username: `cost_${label}_${seq}` });
    await t.actAs(u);
    const ids = [];
    for (let i = 0; i < n; i += 1) {
      const m = await movie(`${label} ${i}`);
      ids.push(m);
      // Inserted directly: building a 150-title band through the comparison RPCs is
      // thousands of round trips, and this test is about the RE-check, not the build.
      await t.sql(
        `insert into rankings (user_id, media_item_id, category, bucket, position)
         values ($1, $2, 'movies', 'loved', $3)`,
        [u, m, i + 1],
      );
      await t.sql(
        `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`,
        [u, m],
      );
    }
    return { u, ids };
  };

  /** Re-checks `ids[at]`, answering as if the stored order is the truth. */
  const recheck = async (u, ids, at, truthIndex) => {
    await t.actAs(u);
    let r = await call(`rank_again($1, 'loved', $2, false, null)`, [ids[at], await op()]);
    let comparisons = 0;
    while (!r.done) {
      const rival = ids.indexOf(r.pivot);
      assert.notEqual(rival, -1, 'the opponent is a member of the band');
      // The subject belongs above the rival exactly when its true insertion point is at
      // or before the rival's index in the subject-excluded list.
      const rivalExcluded = rival < at ? rival : rival - 1;
      const winner = truthIndex <= rivalExcluded ? ids[at] : r.pivot;
      comparisons += 1;
      r = await call(`rank_answer($1, $2, $3)`, [r.session_id, winner, await op()]);
      if (comparisons > 64) throw new Error('did not converge');
    }
    return { comparisons, result: r };
  };

  it('an unchanged re-check costs 2 comparisons mid-band, at 50 and at 150', async () => {
    for (const n of [50, 150]) {
      const { u, ids } = await buildBand(n, `n${n}`);
      const at = Math.floor(n / 2);
      const { comparisons, result } = await recheck(u, ids, at, at);
      assert.equal(comparisons, 2, `band of ${n}: §F.3 says 2`);
      assert.equal(result.position, at + 1, 'and it is exactly where it was');
      assert.equal(result.movement.outcome, 'unchanged');
    }
  });

  it('at the top of the band an unchanged re-check costs 1', async () => {
    // There is no item above the window to test, so the policy tests one side only.
    const { u, ids } = await buildBand(40, 'top');
    const { comparisons, result } = await recheck(u, ids, 0, 0);
    assert.equal(comparisons, 1);
    assert.equal(result.position, 1);
    assert.equal(result.movement.outcome, 'unchanged');
  });

  it('at the bottom of the band an unchanged re-check costs 1', async () => {
    const { u, ids } = await buildBand(40, 'bottom');
    const { comparisons, result } = await recheck(u, ids, 39, 39);
    assert.equal(comparisons, 1);
    assert.equal(result.position, 40);
  });

  it('a one-place move up costs 2, and down costs 3', async () => {
    // Downward costs one more because the neighbour ABOVE the window is tested first.
    const up = await buildBand(60, 'up');
    const a = await recheck(up.u, up.ids, 30, 29);
    assert.equal(a.comparisons, 2);
    assert.equal(a.result.position, 30, 'one place up');
    assert.equal(a.result.movement.outcome, 'moved');
    assert.equal(a.result.movement.from_position, 31);

    const down = await buildBand(60, 'down');
    const b = await recheck(down.u, down.ids, 30, 31);
    assert.equal(b.comparisons, 3);
    assert.equal(b.result.position, 32, 'one place down');
  });

  it('a long move still lands exactly where the answers put it', async () => {
    const { u, ids } = await buildBand(120, 'far');
    const { result } = await recheck(u, ids, 60, 3);
    assert.equal(result.position, 4);
    assert.equal(result.movement.from_position, 61);
    assert.equal(result.movement.outcome, 'moved');
  });
});

describe('§F.4 the invariants the policy may not touch', () => {
  it('a noise-free prior search lands where plain bisection lands, over many priors', async () => {
    // The policy chooses cheaper QUESTIONS. It must never produce a different ANSWER,
    // and this is the assertion that says so in the only terms that matter.
    const n = 60;
    for (const truth of [0, 1, 7, 29, 30, 31, 55, 59, 60]) {
      for (const prior of [0, 15, 30, 45, 60]) {
        let lo = 0;
        let hi = n;
        let guard = 0;
        while (lo < hi) {
          const i = nextPivot(lo, hi, prior, 0, n, 3);
          if (truth <= i) hi = i;
          else lo = i + 1;
          if ((guard += 1) > 64) throw new Error('did not converge');
        }
        assert.equal(
          settleAt(lo, hi, 'prior', prior, 0),
          truth,
          `truth ${truth}, prior ${prior}`,
        );
      }
    }
  });

  it('the kill switch puts an OPEN session back on bisection', async () => {
    // A flag that only affects sessions opened afterwards is a preference, not a kill
    // switch. The strategy is read through _prior_search_enabled() on every step.
    seq += 1;
    const u = await t.createUser({ username: `kill_${seq}` });
    await t.actAs(u);
    const ids = [];
    for (let i = 0; i < 20; i += 1) {
      const m = await movie(`Kill ${i}`);
      ids.push(m);
      await t.sql(
        `insert into rankings (user_id, media_item_id, category, bucket, position)
         values ($1, $2, 'movies', 'loved', $3)`,
        [u, m, i + 1],
      );
      await t.sql(
        `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`,
        [u, m],
      );
    }

    const r = await call(`rank_again($1, 'loved', $2, false, null)`, [ids[10], await op()]);
    // The prior policy opened on the neighbour above: index 9 of the 19-member
    // subject-excluded band.
    assert.equal(r.pivot, ids[9], 'the neighbour above, which is the policy');

    await t.sql(`update app_config set value = 'false'::jsonb
                  where key = 'ranking.prior_search_enabled'`);
    try {
      // The SUBJECT wins, so it belongs above ids[9]: the range narrows to [0, 9).
      const next = await call(`rank_answer($1, $2, $3)`, [r.session_id, ids[10], await op()]);
      // With the flag off the same session bisects that range rather than galloping:
      // midpoint 4, which is member 4 of the subject-excluded band, which is ids[4].
      assert.equal(next.pivot, ids[4], 'the midpoint, which is plain bisection');
    } finally {
      await t.sql(`update app_config set value = 'true'::jsonb
                    where key = 'ranking.prior_search_enabled'`);
    }
  });

  it('a first ranking never anchors, because it has no prior to anchor to', async () => {
    seq += 1;
    const u = await t.createUser({ username: `firstrank_${seq}` });
    await t.actAs(u);
    for (let i = 0; i < 9; i += 1) {
      const m = await movie(`Base ${i}`);
      await t.sql(
        `insert into rankings (user_id, media_item_id, category, bucket, position)
         values ($1, $2, 'movies', 'loved', $3)`,
        [u, m, i + 1],
      );
      await t.sql(
        `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`,
        [u, m],
      );
    }
    const fresh = await movie('Fresh');
    const r = await one(t.db, `select rank_start($1, 'loved') as r`, [fresh]);

    const { rows } = await t.sql(
      `select strategy, prior_offset from ranking_sessions where id = $1`,
      [r.session_id],
    );
    assert.equal(rows[0].strategy, 'bisect');
    assert.equal(rows[0].prior_offset, null);
  });

  it('a band change bisects: the old band’s index says nothing about the new one', async () => {
    seq += 1;
    const u = await t.createUser({ username: `rebucket_${seq}` });
    await t.actAs(u);
    const loved = [];
    for (let i = 0; i < 6; i += 1) {
      const m = await movie(`Loved ${i}`);
      loved.push(m);
      await t.sql(
        `insert into rankings (user_id, media_item_id, category, bucket, position)
         values ($1, $2, 'movies', 'loved', $3)`,
        [u, m, i + 1],
      );
      await t.sql(
        `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`,
        [u, m],
      );
    }
    for (let i = 0; i < 6; i += 1) {
      const m = await movie(`Fine ${i}`);
      await t.sql(
        `insert into rankings (user_id, media_item_id, category, bucket, position)
         values ($1, $2, 'movies', 'fine', $3)`,
        [u, m, 7 + i],
      );
      await t.sql(
        `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'fine')`,
        [u, m],
      );
    }

    const r = await call(`rank_rebucket($1, 'fine', $2)`, [loved[2], await op()]);
    const { rows } = await t.sql(
      `select strategy, prior_offset, kind from ranking_sessions where id = $1`,
      [r.session_id],
    );
    assert.equal(rows[0].prior_offset, null, 'no prior in the band it is moving INTO');
    assert.equal(rows[0].kind, 'correction', 'a band change is a correction, not a watch');
  });
});
