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

  it('offers a new title on each skip rather than repeating one', async () => {
    // The offset used to reset to 1 on every call, and lo/hi do not move when a
    // comparison is skipped, so every skip re-offered mid + 1 — the user was shown
    // a comparison they had just declined to judge. ranking.md §5 specifies
    // stepping outward: mid + 1, then mid - 1, then mid + 2.
    for (let i = 0; i < 9; i += 1) {
      await rankBelow(await movie(`skip_distinct_base_${i}`), 'fine');
    }

    const subject = await movie('skip_distinct_subject');
    let result = await rpc(`select rank_start($1, 'fine') as r`, [subject]);

    const offered = [result.pivot];
    while (!result.done) {
      result = await rpc(`select rank_skip($1) as r`, [result.session_id]);
      if (!result.done) offered.push(result.pivot);
    }

    assert.ok(offered.length > 2, 'the band is large enough to offer several comparisons');
    assert.equal(
      new Set(offered).size,
      offered.length,
      `every comparison offered should be a distinct title, got ${JSON.stringify(offered)}`,
    );
    await t.assertValid(user);
  });

  it('keeps offering comparisons when a skip follows an answer', async () => {
    // The fix for consecutive skips counted against session-wide `skips`, which
    // rank_answer does not reset — correctly, since the cap is meant to count the
    // whole session. So once an answer moved the band, the walk skipped past
    // candidates it had never offered, ran out, and placed the title immediately.
    //
    // The band is nine rather than the three this was first written against.
    // 20260901000100 made the walk refuse every title the SESSION has offered, so on
    // a band of three — start, skip, answer, skip — the fourth call has genuinely run
    // out of unoffered opponents and finalising is now the correct answer. The
    // property this test is about is the other one: while an unoffered comparison
    // exists, a skip after an answer must offer it. Nine leaves plenty.
    for (let i = 0; i < 9; i += 1) {
      await rankBelow(await movie(`interleave_base_${i}`), 'not_for_me');
    }

    const subject = await movie('interleave_subject');
    const started = await rpc(`select rank_start($1, 'not_for_me') as r`, [subject]);
    assert.equal(started.done, false);

    const skipped = await rpc(`select rank_skip($1) as r`, [started.session_id]);
    assert.equal(skipped.done, false, 'the first skip should offer another comparison');

    // The *subject* has to win. Letting the pivot win raises the lower bound to the
    // top of the band and ends the session, so the interleaving under test never
    // happens — which is how the first version of this test passed against the bug
    // it was written for.
    const answered = await rpc(`select rank_answer($1, $2) as r`, [started.session_id, subject]);
    assert.equal(answered.done, false, 'the band should have narrowed, not closed');

    const after = await rpc(`select rank_skip($1) as r`, [started.session_id]);
    assert.equal(
      after.done,
      false,
      'skipping after an answer must offer a comparison, not finalize early — a ' +
        'valid unoffered pivot exists and the skip cap has not been reached',
    );
    assert.ok(after.pivot, 'and that comparison must be a real title');

    await t.assertValid(user);
  });

  /**
   * THE FOUNDER'S REPEAT (physical QA, 2026-08-29), and the reason 20260901000100
   * exists.
   *
   * The report: A versus B, "Too tough", a different comparison, one answer, and A
   * versus B again. It reproduces on a band of three, which is roughly what
   * onboarding hands a new account — and the old skip walk did it every time, because
   * `band_skips` reset whenever [lo, hi) moved and the narrowed midpoint was the
   * title that had just been skipped.
   */
  it('never offers the same pair twice in one session', async () => {
    for (let i = 0; i < 3; i += 1) {
      await rankBelow(await movie(`norepeat_base_${i}`), 'not_for_me');
    }

    const subject = await movie('norepeat_subject');
    const started = await rpc(`select rank_start($1, 'not_for_me') as r`, [subject]);
    assert.equal(started.done, false);

    const offered = [started.pivot];
    let result = await rpc(`select rank_skip($1) as r`, [started.session_id]);
    if (!result.done) offered.push(result.pivot);

    // The founder's exact next move: answer the substitute, letting the subject win
    // so the band narrows rather than closing.
    let guard = 0;
    while (!result.done && guard < 20) {
      guard += 1;
      result = await rpc(`select rank_answer($1, $2) as r`, [started.session_id, subject]);
      if (!result.done) offered.push(result.pivot);
    }

    assert.ok(result.done, 'the session must terminate rather than loop');
    assert.equal(
      new Set(offered).size,
      offered.length,
      `a pair was offered twice: ${JSON.stringify(offered)}`,
    );
    await t.assertValid(user);
  });

  /**
   * The other half of the invariant. "Too tough" means the reader gave no preference
   * evidence about this pair; it does not mean the two are equal, and nothing may be
   * written as though it did.
   */
  it('writes no comparison for a pair that was skipped', async () => {
    for (let i = 0; i < 3; i += 1) {
      await rankBelow(await movie(`noevidence_base_${i}`), 'loved');
    }

    const subject = await movie('noevidence_subject');
    const started = await rpc(`select rank_start($1, 'loved') as r`, [subject]);
    const skippedPivot = started.pivot;

    let result = await rpc(`select rank_skip($1) as r`, [started.session_id]);
    let guard = 0;
    while (!result.done && guard < 20) {
      guard += 1;
      result = await rpc(`select rank_skip($1) as r`, [started.session_id]);
    }
    assert.ok(result.done, 'the session must terminate');

    const { rows } = await t.sql(
      `select count(*)::int as n from comparisons
        where user_id = $1
          and ((winner_id = $2 and loser_id = $3) or (winner_id = $3 and loser_id = $2))`,
      [user.id, subject, skippedPivot],
    );
    assert.equal(rows[0].n, 0, 'a skipped pair produced comparison evidence');

    // And the title is still placed: an honest completion, not a refusal.
    const placed = await t.sql(
      `select count(*)::int as n from rankings where media_item_id = $1`,
      [subject],
    );
    assert.equal(placed.rows[0].n, 1, 'the title must still be placed');
  });

  /**
   * Per session, deliberately: a new session may reconsider a pair the last one
   * skipped, which is what makes Rank again a second opinion rather than a replay.
   */
  it('may reconsider a skipped pair in a new session', async () => {
    for (let i = 0; i < 3; i += 1) {
      await rankBelow(await movie(`fresh_base_${i}`), 'fine');
    }

    const subject = await movie('fresh_subject');
    let result = await rpc(`select rank_start($1, 'fine') as r`, [subject]);
    let guard = 0;
    while (!result.done && guard < 20) {
      guard += 1;
      result = await rpc(`select rank_skip($1) as r`, [result.session_id]);
    }
    assert.ok(result.done);

    // A second session over the same title, which is Rank again.
    const second = await rpc(`select rank_again($1, 'fine', null, true) as r`, [subject]);
    assert.equal(second.done, false, 'a new session should open');
    assert.ok(second.pivot, 'and it may offer any opponent, including a skipped one');

    const { rows } = await t.sql(
      `select cardinality(seen_items) as n from ranking_sessions where id = $1`,
      [second.session_id],
    );
    assert.equal(
      Number(rows[0].n),
      1,
      'a fresh session starts knowing only its own first offer',
    );
  });

  /**
   * **The two paths that DO return a pair already shown, and why neither is the
   * founder's defect** — independent review 74.
   *
   * The seen-set stops the app choosing a comparison it has already put to the reader.
   * It is not, and must not be, a rule against the reader asking for one: Back exists to
   * re-display the comparison being undone, and a resume exists to restore the one that
   * was on screen. Review 74 read the migration's own header as claiming otherwise, which
   * it did; the prose is corrected and these pin the behaviour so a later pass cannot
   * "fix" Back into something that is not an undo.
   */
  it('Back re-displays the comparison it is undoing, which is what Back is', async () => {
    for (let i = 0; i < 9; i += 1) {
      await rankBelow(await movie(`back_base_${i}`), 'loved');
    }

    const subject = await movie('back_subject');
    const started = await rpc(`select rank_start($1, 'loved') as r`, [subject]);
    assert.equal(started.done, false);

    const answered = await rpc(`select rank_answer($1, $2) as r`, [started.session_id, subject]);
    assert.equal(answered.done, false, 'the band should have narrowed, not closed');

    const back = await rpc(`select rank_back($1) as r`, [started.session_id]);
    assert.equal(
      back.pivot,
      started.pivot,
      'Back must return the comparison being undone, not a fresh one',
    );

    // And the seen-set is not corrupted by it: the title is recorded once, not twice.
    const { rows } = await t.sql(
      `select cardinality(seen_items) as n,
              cardinality(array(select distinct e from unnest(seen_items) e)) as distinct_n
         from ranking_sessions where id = $1`,
      [started.session_id],
    );
    assert.equal(Number(rows[0].n), Number(rows[0].distinct_n), 'seen_items gained a duplicate');
  });

  it('and the next comparison the app picks after a Back still excludes what was seen', async () => {
    // The half that matters: Back hands back an old pair, and everything the app chooses
    // afterwards is still governed by the seen-set.
    for (let i = 0; i < 9; i += 1) {
      await rankBelow(await movie(`backnext_base_${i}`), 'fine');
    }

    const subject = await movie('backnext_subject');
    const started = await rpc(`select rank_start($1, 'fine') as r`, [subject]);
    const offered = [started.pivot];

    const answered = await rpc(`select rank_answer($1, $2) as r`, [started.session_id, subject]);
    if (!answered.done) offered.push(answered.pivot);

    await rpc(`select rank_back($1) as r`, [started.session_id]);

    // Answer the restored comparison the other way, so the search takes the branch it
    // did not take before.
    const again = await rpc(`select rank_answer($1, $2) as r`, [started.session_id, started.pivot]);
    if (!again.done) {
      assert.ok(
        !offered.includes(again.pivot),
        `the app offered a pair it had already shown: ${JSON.stringify(offered)} then ${again.pivot}`,
      );
    }
    await t.assertValid(user);
  });

  it('a resume restores the comparison that was on screen, and records it once', async () => {
    for (let i = 0; i < 5; i += 1) {
      await rankBelow(await movie(`resume_base_${i}`), 'loved');
    }

    const subject = await movie('resume_subject');
    const started = await rpc(`select rank_start($1, 'loved') as r`, [subject]);
    assert.equal(started.done, false);

    // Leaving the screen does not delete the session; opening it again resumes.
    const resumed = await rpc(`select rank_start($1, 'loved') as r`, [subject]);
    assert.equal(resumed.resumed, true);
    assert.equal(
      resumed.pivot,
      started.pivot,
      'a resume is one unanswered question restored, not a second asking of it',
    );

    const { rows } = await t.sql(
      `select cardinality(seen_items) as n from ranking_sessions where id = $1`,
      [started.session_id],
    );
    assert.equal(Number(rows[0].n), 1, 'the resume must not record the pivot a second time');
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