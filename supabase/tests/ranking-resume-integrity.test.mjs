import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * A completed answer must remain consistent with every final ordinal placement.
 *
 * A ranking session keeps its search as band *indices* -- `lo`, `hi`, `pivot` and every
 * Undo frame -- and a session can be left open (the app is killed, `rank_cancel` never
 * lands) while other titles are ranked into the same band. The indices then name
 * different titles. The founder-facing failure, found 2026-09-19: the reader says a
 * pivot is better, the session is suspended, a title lands above that pivot, the session
 * resumes, and the subject is placed ABOVE the pivot it lost to.
 *
 * Every test here drives the real RPCs with an oracle that answers truthfully from a
 * fixed order, so any stored position that contradicts a recorded comparison is the
 * engine's fault, never the reader's.
 */

let t;
let seq = 910000;

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

const rpc = async (query, params) => (await t.sql(query, params)).rows[0].r;

/** A fresh reader per test, so no test's band leaks into another's. */
async function reader(name) {
  const id = await t.createUser({ username: `${name}${seq++}`.slice(0, 20) });
  await t.actAs(id);
  return id;
}

/** Titles with a hidden truth: higher is better. */
function oracle() {
  const truth = new Map();
  return {
    truth,
    async movie(title, value) {
      const id = await t.createMovie(title, seq++);
      truth.set(id, value);
      return id;
    },
    /** What an honest reader picks between the subject and the pivot on screen. */
    pick(subject, pivot) {
      return truth.get(subject) > truth.get(pivot) ? subject : pivot;
    },
  };
}

const start = (id, bucket = 'loved') =>
  rpc(`select rank_start($1, $2::taste_bucket) as r`, [id, bucket]);
const answer = (session, winner, op = null) =>
  rpc(`select rank_answer($1, $2, $3) as r`, [session, winner, op]);
const skip = (session) => rpc(`select rank_skip($1) as r`, [session]);
const back = (session) => rpc(`select rank_back($1) as r`, [session]);

/** Answers honestly until the title is placed. */
async function finish(state, subject, o) {
  let s = state;
  for (let guard = 0; !s.done; guard += 1) {
    assert.ok(guard < 64, 'the search did not converge');
    s = await answer(s.session_id, o.pick(subject, s.pivot));
  }
  return s;
}

async function rankHonestly(o, id, bucket = 'loved') {
  return finish(await start(id, bucket), id, o);
}

/** Every recorded comparison whose winner is currently ranked below its loser. */
async function contradictions(user) {
  const { rows } = await t.sql(
    `select c.winner_id, c.loser_id, w.position as winner_at, l.position as loser_at
       from comparisons c
       join rankings w on w.user_id = c.user_id and w.media_item_id = c.winner_id
       join rankings l on l.user_id = c.user_id and l.media_item_id = c.loser_id
      where c.user_id = $1 and w.category = l.category and w.position > l.position`,
    [user],
  );
  return rows;
}

const positionOf = async (user, id) =>
  (
    await t.sql(`select position from rankings where user_id = $1 and media_item_id = $2`, [
      user,
      id,
    ])
  ).rows[0]?.position;

const comparisonCount = async (user) =>
  Number((await t.sql(`select count(*) n from comparisons where user_id = $1`, [user])).rows[0].n);

/** Ten loved films, Base 0 best, ranked honestly. */
async function tenLoved(o) {
  const base = [];
  for (let i = 0; i < 10; i += 1) base.push(await o.movie(`Base ${i}`, 100 - i * 10));
  for (const id of base) await rankHonestly(o, id);
  return base;
}

describe('a suspended session whose band changes', () => {
  it('never places the title above a pivot it lost to (the ten-title case)', async () => {
    const user = await reader('resume');
    const o = oracle();
    const base = await tenLoved(o);
    // Truly between Base 5 (50) and Base 6 (40).
    const subject = await o.movie('Subject', 44);

    let s = await start(subject);
    assert.equal(s.pivot, base[5], 'a band of ten opens on its midpoint, Base 5');
    s = await answer(s.session_id, o.pick(subject, s.pivot));
    assert.equal(s.done, false);

    // Suspended. A title better than Base 5 lands in the same band, above it.
    await rankHonestly(o, await o.movie('Intruder', 1000));

    s = await start(subject);
    assert.equal(s.resumed, true, 'still a resume, not a new session');
    s = await finish(s, subject, o);

    assert.deepEqual(await contradictions(user), []);
    assert.ok(
      (await positionOf(user, subject)) > (await positionOf(user, base[5])),
      'Base 5 won; the subject must sit below it',
    );
    assert.ok((await positionOf(user, subject)) < (await positionOf(user, base[6])));
    await t.assertValid(user);
  });

  it('keeps a win when a title above the pivot is removed', async () => {
    const user = await reader('removal');
    const o = oracle();
    const base = await tenLoved(o);
    // Truly between Base 4 (60) and Base 5 (50): beats the opening pivot, Base 5.
    const subject = await o.movie('Subject', 55);

    let s = await start(subject);
    assert.equal(s.pivot, base[5]);
    s = await answer(s.session_id, o.pick(subject, s.pivot));

    await t.sql(`select rank_unrank($1)`, [base[0]]);

    s = await finish(await start(subject), subject, o);
    assert.deepEqual(await contradictions(user), []);
    assert.ok((await positionOf(user, subject)) < (await positionOf(user, base[5])));
    assert.ok((await positionOf(user, subject)) > (await positionOf(user, base[4])));
    await t.assertValid(user);
  });

  it('is unaffected by a title landing below everything the answers decided', async () => {
    const user = await reader('below');
    const o = oracle();
    await tenLoved(o);
    const subject = await o.movie('Subject', 44);

    const s = await start(subject);
    await answer(s.session_id, o.pick(subject, s.pivot));
    await rankHonestly(o, await o.movie('Worst', 1));

    await finish(await start(subject), subject, o);
    assert.deepEqual(await contradictions(user), []);
    await t.assertValid(user);
  });

  it('never records an answer against a title the reader was not shown', async () => {
    const user = await reader('gone');
    const o = oracle();
    await tenLoved(o);
    const subject = await o.movie('Subject', 44);

    const s = await start(subject);
    const shown = s.pivot;

    // The title on screen is unranked while the session is suspended.
    await t.sql(`select rank_unrank($1)`, [shown]);

    const before = await comparisonCount(user);
    const next = await answer(s.session_id, subject);

    assert.equal(next.done, false, 'the answer was about a title that has left the band');
    assert.notEqual(next.pivot, shown);
    assert.equal(await comparisonCount(user), before, 'no comparison against an unseen title');

    await finish(next, subject, o);
    assert.deepEqual(await contradictions(user), []);
    await t.assertValid(user);
  });
});

describe('a suspended session whose band did not change', () => {
  it('resumes exactly as if it had never been left', async () => {
    const o = oracle();

    // The same ten titles and the same subject for two readers: one uninterrupted, one
    // who leaves after the first answer and comes back.
    const straight = await reader('straight');
    const base = await tenLoved(o);
    const subject = await o.movie('Subject', 44);
    const pivotsStraight = [];
    let s = await start(subject);
    while (!s.done) {
      pivotsStraight.push(s.pivot);
      s = await answer(s.session_id, o.pick(subject, s.pivot));
    }
    const placedStraight = s.position;

    const paused = await reader('paused');
    for (const id of base) await rankHonestly(o, id);
    const pivotsPaused = [];
    s = await start(subject);
    pivotsPaused.push(s.pivot);
    s = await answer(s.session_id, o.pick(subject, s.pivot));
    pivotsPaused.push(s.pivot);

    const resumed = await start(subject);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.pivot, s.pivot, 'the comparison that was on screen comes back');
    s = resumed;
    while (!s.done) {
      s = await answer(s.session_id, o.pick(subject, s.pivot));
      if (!s.done) pivotsPaused.push(s.pivot);
    }

    assert.deepEqual(pivotsPaused, pivotsStraight, 'the same comparisons, in the same order');
    assert.equal(s.position, placedStraight);
    assert.equal(
      await comparisonCount(paused),
      await comparisonCount(straight),
      'no comparison asked twice',
    );
  });
});

describe('Undo, Too tough and replays across a band change', () => {
  it('Undo brings back the title that was compared, not whatever now holds its index', async () => {
    const user = await reader('undo');
    const o = oracle();
    const base = [];
    for (let i = 0; i < 16; i += 1) base.push(await o.movie(`Base ${i}`, 160 - i * 10));
    for (const id of base) await rankHonestly(o, id);
    const subject = await o.movie('Subject', 35); // between Base 12 (40) and Base 13 (30)

    let s = await start(subject);
    s = await answer(s.session_id, o.pick(subject, s.pivot));
    const second = s.pivot;
    s = await answer(s.session_id, o.pick(subject, s.pivot));
    const third = s.pivot;

    await rankHonestly(o, await o.movie('Intruder', 1000));

    s = await start(subject);
    assert.equal(s.pivot, third, 'the comparison on screen is still the one shown');

    s = await back(s.session_id);
    assert.equal(s.pivot, second, 'Undo re-shows the second comparison, by title');

    await finish(s, subject, o);
    assert.deepEqual(await contradictions(user), []);
    await t.assertValid(user);
  });

  it('Too tough after a band change offers only titles the answers still allow', async () => {
    const user = await reader('tough');
    const o = oracle();
    const base = await tenLoved(o);
    const subject = await o.movie('Subject', 44);

    let s = await start(subject);
    s = await answer(s.session_id, o.pick(subject, s.pivot)); // Base 5 wins
    await rankHonestly(o, await o.movie('Intruder', 1000));

    s = await start(subject);
    s = await skip(s.session_id);
    assert.equal(s.done, false);
    assert.ok(
      (await positionOf(user, s.pivot)) > (await positionOf(user, base[5])),
      'every candidate is below Base 5, which beat the subject',
    );

    await finish(s, subject, o);
    assert.deepEqual(await contradictions(user), []);
    await t.assertValid(user);
  });

  it('a replayed answer after a band change is applied once', async () => {
    const user = await reader('replay');
    const o = oracle();
    await tenLoved(o);
    const subject = await o.movie('Subject', 44);

    let s = await start(subject);
    s = await answer(s.session_id, o.pick(subject, s.pivot));
    await rankHonestly(o, await o.movie('Intruder', 1000));
    s = await start(subject);

    const op = randomUUID();
    const before = await comparisonCount(user);
    const first = await answer(s.session_id, o.pick(subject, s.pivot), op);
    const again = await answer(s.session_id, o.pick(subject, s.pivot), op);

    assert.deepEqual(again, first);
    assert.equal(await comparisonCount(user), before + 1);

    await finish(first, subject, o);
    assert.deepEqual(await contradictions(user), []);
    const { rows } = await t.sql(
      `select count(*) n from feed_events where actor_id = $1 and media_item_id = $2 and type = 'title_ranked'`,
      [user, subject],
    );
    assert.equal(Number(rows[0].n), 1, 'one placement, one activity');
  });
});

describe('answers the band no longer agrees with', () => {
  it('starts the search again when the reader has since reordered two of its pivots', async () => {
    const user = await reader('conflict');
    const o = oracle();
    const base = await tenLoved(o);
    const subject = await o.movie('Subject', 44); // between Base 5 and Base 6

    let s = await start(subject);
    assert.equal(s.pivot, base[5]);
    s = await answer(s.session_id, o.pick(subject, s.pivot)); // Base 5 wins
    assert.equal(s.pivot, base[8]);
    s = await answer(s.session_id, o.pick(subject, s.pivot)); // subject beats Base 8

    // The reader changes their mind about Base 8: it is now their favourite. Base 5 beat
    // the subject and the subject beat Base 8, and Base 8 is now above Base 5 -- no
    // placement can honour both answers.
    o.truth.set(base[8], 1000);
    await finish(await rpc(`select rank_again($1, 'loved') as r`, [base[8]]), base[8], o);
    assert.equal(await positionOf(user, base[8]), 1);

    s = await start(subject);
    await finish(s, subject, o);

    // Placed by the answers it gave in the search that finished.
    assert.ok((await positionOf(user, subject)) > (await positionOf(user, base[5])));
    assert.ok((await positionOf(user, subject)) < (await positionOf(user, base[6])));
    await t.assertValid(user);
  });
});

describe('a session that was open when 20260926000100 deployed', () => {
  /**
   * Such a session has no digest, no pivot_item, and frames that record an index but not
   * the title behind it. Recreated here by writing a current session back into that shape.
   */
  const toLegacy = (session) =>
    t.sql(
      `update ranking_sessions
          set band_digest = null,
              pivot_item  = null,
              history     = coalesce(
                (select jsonb_agg(f - 'pivot_item' - 'won') from jsonb_array_elements(history) f),
                '[]'::jsonb)
        where id = $1`,
      [session],
    );

  it('with answers: starts the search again rather than trusting an old index', async () => {
    const user = await reader('legacya');
    const o = oracle();
    const base = await tenLoved(o);
    const subject = await o.movie('Subject', 44);

    let s = await start(subject);
    s = await answer(s.session_id, o.pick(subject, s.pivot)); // Base 5 wins, lo = 6
    await toLegacy(s.session_id);
    await rankHonestly(o, await o.movie('Intruder', 1000));

    const before = await comparisonCount(user);
    const next = await answer(s.session_id, subject);
    assert.equal(next.rebased, true, 'the first step after the deploy re-presents a comparison');
    assert.equal(await comparisonCount(user), before, 'and applies nothing to the old one');

    const { rows } = await t.sql(
      `select lo, hi, jsonb_array_length(history) as frames, skips from ranking_sessions where id = $1`,
      [s.session_id],
    );
    assert.deepEqual(rows[0], { lo: 0, hi: 11, frames: 0, skips: 0 }, 'the whole band again');

    await finish(next, subject, o);
    assert.ok((await positionOf(user, subject)) > (await positionOf(user, base[5])));
    assert.deepEqual(await contradictions(user), []);
    await t.assertValid(user);
  });

  it('without answers: loses nothing, and the resume carries on', async () => {
    const user = await reader('legacyb');
    const o = oracle();
    await tenLoved(o);
    const subject = await o.movie('Subject', 44);

    const s = await start(subject);
    await toLegacy(s.session_id);

    const resumed = await start(subject);
    assert.equal(resumed.resumed, true);
    assert.ok(resumed.pivot, 'a comparison to show');

    await finish(resumed, subject, o);
    assert.deepEqual(await contradictions(user), []);
    await t.assertValid(user);
  });
});

describe('property: interleaved suspended sessions never contradict an answer', () => {
  it('holds through 220 randomised steps over one shared band', async () => {
    const user = await reader('prop');
    const o = oracle();
    const pool = [];
    for (let i = 0; i < 26; i += 1) pool.push(await o.movie(`Prop ${i}`, (i * 37) % 101));

    let state = 20260919;
    const rand = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
    const pickFrom = (list) => list[Math.floor(rand() * list.length)];

    const unranked = [...pool];
    const ranked = [];
    const open = new Map(); // subject -> the last response shown for it

    let rebased = 0;
    const settle = (subject, response) => {
      if (response.rebased) rebased += 1;
      if (response.cancelled) {
        // Undo at the first comparison: the session is gone and the title is unranked.
        open.delete(subject);
        unranked.push(subject);
      } else if (response.done) {
        open.delete(subject);
        ranked.push(subject);
      } else {
        open.set(subject, response);
      }
    };

    for (let step = 0; step < 220; step += 1) {
      const roll = rand();

      if (roll < 0.3 && unranked.length > 0) {
        const subject = unranked.splice(Math.floor(rand() * unranked.length), 1)[0];
        settle(subject, await start(subject));
      } else if (roll < 0.75 && open.size > 0) {
        const subject = pickFrom([...open.keys()]);
        const shown = open.get(subject);
        settle(subject, await answer(shown.session_id, o.pick(subject, shown.pivot)));
      } else if (roll < 0.82 && open.size > 0) {
        const subject = pickFrom([...open.keys()]);
        settle(subject, await skip(open.get(subject).session_id));
      } else if (roll < 0.9 && open.size > 0) {
        const subject = pickFrom([...open.keys()]);
        settle(subject, await back(open.get(subject).session_id));
      } else if (ranked.length > 3) {
        const id = ranked.splice(Math.floor(rand() * ranked.length), 1)[0];
        await t.sql(`select rank_unrank($1)`, [id]);
        unranked.push(id);
      }

      assert.deepEqual(await contradictions(user), [], `after step ${step}`);
      await t.assertValid(user);
    }

    // Every session still open is resumed and finished honestly, as a reader coming
    // back to each of them would.
    for (const subject of [...open.keys()]) {
      settle(subject, await finish(await start(subject), subject, o));
    }

    assert.deepEqual(await contradictions(user), []);
    await t.assertValid(user);
    assert.equal(open.size, 0);
    assert.ok(ranked.length > 15, `the run must actually have ranked things (${ranked.length})`);
    assert.ok(rebased > 10, `the run must have moved bands under open sessions (${rebased})`);
  });
});
