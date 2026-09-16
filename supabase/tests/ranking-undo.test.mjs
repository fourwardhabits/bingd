import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * **Undo, then the same answer again** (2026-09-16).
 *
 * The report: comparison A, the reader picks the title on the right, comparison B
 * appears, Undo brings A back, the reader picks the right again — and instead of B the
 * app sometimes finalises the ranking.
 *
 * The cause was on the server. `rank_back` restored `lo`, `hi` and `pivot` from the
 * history frame but left `seen_items` as it was, so the title the undone answer had
 * offered — B — was still recorded as shown. Answering A the same way again computed the
 * same midpoint, `_rank_offer` refused B as already seen, and walked outward:
 *
 *   - when B was the only title left in the range, the walk ran dry and the title was
 *     placed at the midpoint without the comparison the search needed — the finalise
 *     the reader saw, and a placement that can be one slot wrong;
 *   - when the range was wider, the walk offered a neighbour of B instead, so the
 *     session silently took a different path from the one it took the first time, and
 *     could run dry later for the same reason.
 *
 * "Sometimes" is the band size: it is deterministic for a range of one.
 *
 * `rank_skip` had the matching asymmetry: it pushes no frame, so an Undo after a skip
 * pops the answer before it, and the skip count was decremented by one whatever had
 * actually been undone.
 *
 * The invariant pinned here is the one the report states: **answer, Undo, and the same
 * answer again is the same progression as the answer alone** — same next comparison,
 * same final position, same `adjustable` — because Undo returns the session to exactly
 * the state it was in when the undone comparison was shown.
 */

let t;
let owner;

const rpc = async (query, params) => (await t.sql(query, params)).rows[0].r;

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

let seq = 91000;
const movie = (title) => t.createMovie(title, seq++);

/** A fresh account with exactly `size` titles in `loved`, so a band is what a test says. */
async function account(size) {
  owner = await t.createUser({ username: `undo_${seq}` });
  await t.actAs(owner);
  const band = [];
  for (let i = 0; i < size; i += 1) {
    const id = await movie(`undo_base_${seq}_${i}`);
    // Always below the incumbents, so the band's order is creation order.
    await t.rankToCompletion(id, 'loved', async (pivot) => pivot);
    band.push(id);
  }
  return band;
}

/**
 * An oracle for a subject whose true place in the band is index `k`: it beats every
 * title at index k or below it in the ranking, and loses to every title above.
 */
const oracle = (band, subject, k) => (pivot) => (band.indexOf(pivot) >= k ? subject : pivot);

const session = async (id) =>
  (
    await t.sql(
      `select lo, hi, pivot, skips, seen_items, jsonb_array_length(history) as depth
         from ranking_sessions where id = $1`,
      [id],
    )
  ).rows[0];

const positionOf = async (id) =>
  Number(
    (
      await t.sql(`select position from rankings where user_id = $1 and media_item_id = $2`, [
        owner,
        id,
      ])
    ).rows[0]?.position,
  );

/** Takes the subject back out, so the band is the same size for the next case. */
const unrank = (id) => t.sql(`select rank_unrank($1) as r`, [id]);

describe('the reported sequence: right, Undo, right again', () => {
  it('returns to the second comparison rather than finalising, on a band of three', async () => {
    await account(3);
    const subject = await movie('undo_reported_subject');

    const a = await rpc(`select rank_start($1, 'loved') as r`, [subject]);
    assert.equal(a.done, false);

    // The title on the right is the incumbent: the reader says it was better.
    const b = await rpc(`select rank_answer($1, $2) as r`, [a.session_id, a.pivot]);
    assert.equal(b.done, false, 'a band of three needs a second comparison here');
    assert.notEqual(b.pivot, a.pivot);

    const undone = await rpc(`select rank_back($1) as r`, [a.session_id]);
    assert.equal(undone.pivot, a.pivot, 'Undo brings comparison A back');

    const again = await rpc(`select rank_answer($1, $2) as r`, [a.session_id, a.pivot]);
    assert.equal(
      again.done,
      false,
      'the same answer must not finalise where the first did not',
    );
    assert.equal(again.pivot, b.pivot, 'and it must bring back comparison B');

    await t.assertValid(owner);
  });

  it('restores the session to exactly the state comparison A was shown in', async () => {
    await account(9);
    const subject = await movie('undo_state_subject');

    const a = await rpc(`select rank_start($1, 'loved') as r`, [subject]);
    const before = await session(a.session_id);

    await rpc(`select rank_answer($1, $2) as r`, [a.session_id, a.pivot]);
    await rpc(`select rank_back($1) as r`, [a.session_id]);

    const restored = await session(a.session_id);
    assert.deepEqual(restored, before);
  });
});

describe('answer, Undo, same answer is the same progression as the answer alone', () => {
  for (const size of [1, 2, 3, 4, 7, 8, 15]) {
    it(`places every true position correctly on a band of ${size}, undoing every answer`, async () => {
      const band = await account(size);

      for (let k = 0; k <= size; k += 1) {
        // Without Undo: the reference.
        const plain = await movie(`undo_plain_${size}_${k}`);
        const reference = await t.rankToCompletion(plain, 'loved', oracle(band, plain, k));
        assert.equal(reference.adjustable, false);
        assert.equal(reference.position, k + 1, 'the reference search must be exact');
        await unrank(plain);

        // With an Undo after every answer, and the same answer given again.
        const subject = await movie(`undo_twice_${size}_${k}`);
        const decide = oracle(band, subject, k);
        let step = await rpc(`select rank_start($1, 'loved') as r`, [subject]);
        const shown = [];

        while (!step.done) {
          const winner = decide(step.pivot);
          const first = await rpc(`select rank_answer($1, $2) as r`, [step.session_id, winner]);

          if (first.done) {
            // A placement ends the session, so there is nothing left to undo: only a
            // comparison can be.
            step = first;
            break;
          }

          const back = await rpc(`select rank_back($1) as r`, [step.session_id]);
          assert.equal(
            back.pivot,
            step.pivot,
            'Undo restores the comparison that was answered',
          );

          const second = await rpc(`select rank_answer($1, $2) as r`, [
            step.session_id,
            winner,
          ]);
          assert.equal(second.done, false, `band ${size}, k ${k}: the repeat finalised early`);
          assert.equal(second.pivot, first.pivot, `band ${size}, k ${k}: the repeat diverged`);

          shown.push(second.pivot);
          step = second;
        }

        assert.equal(
          step.position,
          reference.position,
          `band ${size}, k ${k}: wrong placement`,
        );
        assert.equal(step.adjustable, false, 'an Undo is not a skip and must not read as one');
        assert.equal(new Set(shown).size, shown.length, 'no pair was offered twice by the app');
        assert.equal(await positionOf(subject), k + 1);
        await t.assertValid(owner);
        await unrank(subject);
      }
    });
  }
});

describe('Undo after Too tough', () => {
  it('restores the skip count and the offers the undone step made', async () => {
    const band = await account(15);
    const subject = await movie('undo_skip_subject');

    const a = await rpc(`select rank_start($1, 'loved') as r`, [subject]);
    // Too tough on A: a replacement opponent, one skip spent, no frame pushed.
    const c = await rpc(`select rank_skip($1) as r`, [a.session_id]);
    assert.equal(c.done, false);

    const atC = await session(a.session_id);
    assert.equal(atC.skips, 1);

    const winner = oracle(band, subject, 4)(c.pivot);
    const d = await rpc(`select rank_answer($1, $2) as r`, [a.session_id, winner]);
    assert.equal(d.done, false);

    const back = await rpc(`select rank_back($1) as r`, [a.session_id]);
    assert.equal(back.pivot, c.pivot, 'Undo returns to the comparison that was answered');
    assert.deepEqual(
      await session(a.session_id),
      atC,
      'the skip that preceded the answer is still spent, and nothing else is',
    );

    const again = await rpc(`select rank_answer($1, $2) as r`, [a.session_id, winner]);
    assert.equal(again.pivot, d.pivot);
    await t.assertValid(owner);
  });

  it('keeps the skip cap where it was, rather than handing back a skip nobody undid', async () => {
    const band = await account(31);
    const subject = await movie('undo_skip_cap_subject');

    let step = await rpc(`select rank_start($1, 'loved') as r`, [subject]);
    step = await rpc(`select rank_skip($1) as r`, [step.session_id]);
    step = await rpc(`select rank_skip($1) as r`, [step.session_id]);
    assert.equal((await session(step.session_id)).skips, 2);

    const winner = oracle(band, subject, 20)(step.pivot);
    await rpc(`select rank_answer($1, $2) as r`, [step.session_id, winner]);
    await rpc(`select rank_back($1) as r`, [step.session_id]);

    // Two skips were spent and neither was undone. The third still places the title.
    assert.equal((await session(step.session_id)).skips, 2);
    const third = await rpc(`select rank_skip($1) as r`, [step.session_id]);
    assert.equal(third.done, true);
    assert.equal(third.adjustable, true);
    await t.assertValid(owner);
  });

  /**
   * Answer, then Too tough, then Undo (independent review of this change).
   *
   * `rank_skip` pushes no frame, so this Undo pops the answer before the skip. The title
   * that answer offered was then declined, and truncating the offers to the frame handed
   * it back: the same answer re-offered the pair the reader had just skipped, and a
   * reader repeating the loop never finished.
   */
  it('does not re-offer a title the reader skipped after the answer being undone', async () => {
    const band = await account(15);
    const subject = await movie('undo_after_skip_subject');
    const decide = oracle(band, subject, 11);

    const a = await rpc(`select rank_start($1, 'loved') as r`, [subject]);
    const b = await rpc(`select rank_answer($1, $2) as r`, [a.session_id, decide(a.pivot)]);
    assert.equal(b.done, false);

    const c = await rpc(`select rank_skip($1) as r`, [a.session_id]);
    assert.equal(c.done, false);

    const back = await rpc(`select rank_back($1) as r`, [a.session_id]);
    assert.equal(back.pivot, a.pivot);
    const state = await session(a.session_id);
    assert.equal(state.skips, 1, 'the skip was spent and an Undo does not refund it');
    assert.ok(state.seen_items.includes(b.pivot), 'the declined title stays declined');
    assert.ok(!state.seen_items.includes(c.pivot), 'the comparison on screen is withdrawn');

    const again = await rpc(`select rank_answer($1, $2) as r`, [a.session_id, decide(a.pivot)]);
    if (!again.done) assert.notEqual(again.pivot, b.pivot, 'the skipped pair came back');
    await t.assertValid(owner);
  });

  it('ends a session that keeps answering, skipping and undoing', async () => {
    const band = await account(15);
    const subject = await movie('undo_loop_subject');
    const decide = oracle(band, subject, 11);

    const a = await rpc(`select rank_start($1, 'loved') as r`, [subject]);
    let step = a;
    for (let round = 0; round < 40 && !step.done; round += 1) {
      step = await rpc(`select rank_answer($1, $2) as r`, [a.session_id, decide(a.pivot)]);
      if (step.done) break;
      step = await rpc(`select rank_skip($1) as r`, [a.session_id]);
      if (step.done) break;
      step = await rpc(`select rank_back($1) as r`, [a.session_id]);
    }
    assert.equal(step.done, true, 'the loop must reach a placement');
    await t.assertValid(owner);
  });
});

describe('operations around an Undo', () => {
  it('a replay of the undone answer changes nothing, and the fresh repeat is not a replay', async () => {
    await account(15);
    const subject = await movie('undo_replay_subject');
    const a = await rpc(`select rank_start($1, 'loved') as r`, [subject]);

    const first = await rpc(`select rank_answer($1, $2, $3) as r`, [
      a.session_id,
      a.pivot,
      '11111111-1111-4111-8111-111111111111',
    ]);
    await rpc(`select rank_back($1, $2) as r`, [
      a.session_id,
      '22222222-2222-4222-8222-222222222222',
    ]);
    const atA = await session(a.session_id);

    // A retry of the first answer's lost reply, arriving after the Undo, is answered from
    // the ledger and moves nothing.
    const replay = await rpc(`select rank_answer($1, $2, $3) as r`, [
      a.session_id,
      a.pivot,
      '11111111-1111-4111-8111-111111111111',
    ]);
    assert.deepEqual(replay, first);
    assert.deepEqual(await session(a.session_id), atA);

    // So is a replay of the Undo: it does not pop a second frame.
    await rpc(`select rank_back($1, $2) as r`, [
      a.session_id,
      '22222222-2222-4222-8222-222222222222',
    ]);
    assert.deepEqual(await session(a.session_id), atA);

    // The reader's repeat carries a new id and is a real answer.
    const repeat = await rpc(`select rank_answer($1, $2, $3) as r`, [
      a.session_id,
      a.pivot,
      '33333333-3333-4333-8333-333333333333',
    ]);
    assert.equal(repeat.pivot, first.pivot);
    assert.equal((await session(a.session_id)).depth, 1);
  });

  it('an Undo on a frame written before this fix still restores the comparison', async () => {
    await account(9);
    const subject = await movie('undo_legacy_subject');
    const a = await rpc(`select rank_start($1, 'loved') as r`, [subject]);
    await rpc(`select rank_answer($1, $2) as r`, [a.session_id, a.pivot]);

    // The frame shape an older rank_answer wrote: bounds and pivot, nothing else.
    await t.sql(
      `update ranking_sessions
          set history = (select jsonb_agg(f - 'seen' - 'skips') from jsonb_array_elements(history) f)
        where id = $1`,
      [a.session_id],
    );

    const back = await rpc(`select rank_back($1) as r`, [a.session_id]);
    assert.equal(back.pivot, a.pivot);
    const again = await rpc(`select rank_answer($1, $2) as r`, [a.session_id, a.pivot]);
    assert.equal(again.done, false);
    await t.assertValid(owner);
  });
});

describe('the opponent travels with the comparison', () => {
  it('answer, skip and Undo each carry the card for the title they put on screen', async () => {
    await account(15);
    const subject = await movie('card_subject');
    const a = await rpc(`select rank_start($1, 'loved') as r`, [subject]);

    const card = async (id) =>
      (await t.sql(`select id, kind, title, poster_path from media_items where id = $1`, [id]))
        .rows[0];

    const answered = await rpc(`select rank_answer($1, $2) as r`, [a.session_id, subject]);
    assert.deepEqual(answered.pivot_card, await card(answered.pivot));

    const skipped = await rpc(`select rank_skip($1) as r`, [a.session_id]);
    assert.deepEqual(skipped.pivot_card, await card(skipped.pivot));

    const back = await rpc(`select rank_back($1) as r`, [a.session_id]);
    assert.deepEqual(back.pivot_card, await card(back.pivot));
  });
});
