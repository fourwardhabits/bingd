import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Ranking sessions that stay open while the ranking changes underneath them.
 *
 * The existing ranking suite drives one insertion at a time to completion, which
 * is why three defects survived it: each needed either a session left open
 * across another mutation, or a skip followed by an answer. Both are ordinary
 * user behaviour and neither was covered.
 */

let t;
let user;

/** Unwraps the single jsonb column the ranking RPCs return. */
const rpc = async (query, params) => (await t.sql(query, params)).rows[0].r;

before(async () => {
  t = await createTestDb();
  user = await t.createUser({ username: 'ranker' });
  await t.actAs(user);
});

after(async () => {
  await t?.close();
});

let seq = 70000;
const movie = (title) => t.createMovie(title, seq++);

/** Ranks a title to completion, always letting the incumbent win. */
async function rankBelow(id, bucket) {
  return t.rankToCompletion(id, bucket, async (pivot) => pivot);
}

describe('skipping a comparison', () => {
  it('offers a different title and then accepts an answer about it', async () => {
    for (let i = 0; i < 7; i += 1) {
      await rankBelow(await movie(`skip_base_${i}`), 'loved');
    }

    const subject = await movie('skip_subject');
    const started = await rpc(`select rank_start($1, 'loved') as r`, [subject]);
    const skipped = await rpc(`select rank_skip($1) as r`, [started.session_id]);

    assert.equal(skipped.done, false);
    assert.ok(skipped.pivot, 'skip must offer a replacement comparison');
    assert.notEqual(skipped.pivot, started.pivot, 'skip must re-anchor to a different title');

    // The defect: rank_answer recomputed the midpoint and refused the very title
    // skip had just displayed, so every skip led to a dead end.
    const answered = await rpc(`select rank_answer($1, $2) as r`, [
      started.session_id,
      skipped.pivot,
    ]);
    assert.ok(answered, 'the skipped-to pivot must be a valid answer');
    await t.assertValid(user);
  });

  it('places the title and says so once the skip limit is reached', async () => {
    const subject = await movie('skip_limit');
    let result = await rpc(`select rank_start($1, 'loved') as r`, [subject]);
    for (let i = 0; i < 3 && !result.done; i += 1) {
      result = await rpc(`select rank_skip($1) as r`, [result.session_id]);
    }
    assert.equal(result.done, true);
    assert.equal(result.adjustable, true, 'the client may only offer to adjust when told to');
    await t.assertValid(user);
  });
});

describe('a session left open while the ranking moves', () => {
  it('still places the title inside its own band', async () => {
    for (let i = 0; i < 4; i += 1) await rankBelow(await movie(`shift_loved_${i}`), 'loved');
    for (let i = 0; i < 4; i += 1) await rankBelow(await movie(`shift_fine_${i}`), 'fine');

    // Open a session on a 'fine' title and leave it mid-flight.
    const subject = await movie('shift_subject');
    let state = await rpc(`select rank_start($1, 'fine') as r`, [subject]);
    assert.equal(state.done, false);

    // Rank a new 'loved' title. Every 'fine' position now shifts down by one, so
    // a session holding absolute positions is pointing into the loved band.
    await rankBelow(await movie('shift_intruder'), 'loved');

    while (!state.done) {
      state = await rpc(`select rank_answer($1, $2) as r`, [state.session_id, state.pivot]);
    }

    // I2 is the invariant at stake: every loved position precedes every fine one.
    await t.assertValid(user);

    const { rows } = await t.sql(
      `select bucket, position from rankings where user_id = $1 and media_item_id = $2`,
      [user, subject],
    );
    assert.equal(rows[0].bucket, 'fine');

    const { rows: band } = await t.sql(
      `select lo, hi from band_bounds($1, 'movies', 'fine')`,
      [user],
    );
    assert.ok(
      rows[0].position >= band[0].lo && rows[0].position <= band[0].hi,
      `landed at ${rows[0].position}, outside the fine band ${band[0].lo}-${band[0].hi}`,
    );
  });

  it('refuses to place a title outside its band even if asked directly', async () => {
    // The backstop in _rank_finalize. Band ordering cannot be a constraint, so a
    // violation would otherwise be silent and discovered much later.
    const subject = await movie('out_of_band');
    await t.sql(`insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'fine')`, [
      user,
      subject,
    ]);
    await assert.rejects(
      () =>
        t.sql(`select _rank_finalize($1, $2, 'movies', 'fine', 1, null) as r`, [user, subject]),
      /outside the fine band/i,
    );
  });
});

describe('changing your mind about the bucket mid-session', () => {
  it('restarts the comparison rather than resuming it in the old band', async () => {
    for (let i = 0; i < 3; i += 1) await rankBelow(await movie(`mind_loved_${i}`), 'loved');
    for (let i = 0; i < 3; i += 1) await rankBelow(await movie(`mind_fine_${i}`), 'fine');

    const subject = await movie('mind_subject');
    const first = await rpc(`select rank_start($1, 'loved') as r`, [subject]);
    assert.equal(first.done, false);

    // Same title, different bucket. The session carried the old bucket, so
    // finalizing wrote a rankings row disagreeing with user_media — invariant I3.
    let state = await rpc(`select rank_start($1, 'fine') as r`, [subject]);
    assert.notEqual(state.resumed, true, 'a bucket change must not resume the old session');

    while (!state.done) {
      state = await rpc(`select rank_answer($1, $2) as r`, [state.session_id, state.pivot]);
    }

    await t.assertValid(user);

    const { rows } = await t.sql(
      `select r.bucket as ranked, um.bucket as logged
         from rankings r
         join user_media um
           on um.user_id = r.user_id and um.media_item_id = r.media_item_id
        where r.user_id = $1 and r.media_item_id = $2`,
      [user, subject],
    );
    assert.equal(rows[0].ranked, 'fine');
    assert.equal(rows[0].logged, 'fine', 'the ranked and logged buckets must agree');
  });

  it('resumes normally when the bucket is unchanged', async () => {
    const subject = await movie('resume_same');
    const first = await rpc(`select rank_start($1, 'loved') as r`, [subject]);
    const again = await rpc(`select rank_start($1, 'loved') as r`, [subject]);
    assert.equal(again.resumed, true);
    assert.equal(again.session_id, first.session_id);
    assert.equal(again.pivot, first.pivot, 'resuming must offer the same comparison');
  });
});