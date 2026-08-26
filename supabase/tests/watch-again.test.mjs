import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb, one } from './harness.mjs';

/**
 * Rank again means you watched it again — `20260826000500`.
 *
 * Two founder findings on one device, and they turn out to be the same function:
 *
 *   1. **Tapping Rank again made the score disappear.** `rank_again` unranked before it
 *      opened a session, so the position was gone before a single comparison had been
 *      answered, and closing the sheet left it gone. `rank_rebucket` had done the same
 *      since 20260813000700.
 *
 *   2. **Changing a rating posted a duplicate activity every time.** `_rank_finalize`
 *      wrote a `title_ranked` feed event on every completion, and every re-ranking
 *      completes one — hence four "ranked War Dogs" rows for one film.
 *
 * The contract that replaces both:
 *
 *   opening a re-ranking       changes nothing anybody can see
 *   completing Rank again      replaces the position, writes one activity
 *   completing Change rating   replaces the position, writes none
 *   abandoning either          leaves the ranking, the review and the note untouched
 *
 * `ranking-contract.test.mjs` owns the provisional-state half. This file owns the
 * activity half and what a re-ranking must not destroy on the way past.
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
  user = await t.createUser({ username: `again_${seq}` });
  await t.actAs(user);
});

const movie = (title) => t.createMovie(title, (seq += 1) + 70000);
const op = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

const events = async (item) =>
  Number(
    (
      await t.sql(
        `select count(*)::int as n from feed_events
          where actor_id = $1 and media_item_id = $2 and type = 'title_ranked'`,
        [user, item],
      )
    ).rows[0].n,
  );

const collection = async (item) =>
  (
    await t.sql(
      `select bucket, note, note_visibility from user_media
        where user_id = $1 and media_item_id = $2`,
      [user, item],
    )
  ).rows[0] ?? null;

const rankingOf = async (item) =>
  (
    await t.sql(`select bucket, position from rankings where user_id = $1 and media_item_id = $2`, [
      user,
      item,
    ])
  ).rows[0] ?? null;

/** Ranks `n` other films into `bucket`, so a band is never empty by accident. */
const anchors = async (n, bucket = 'loved') => {
  const placed = [];
  for (let i = 0; i < n; i += 1) {
    const film = await movie(`Anchor ${i}`);
    await t.rankToCompletion(film, bucket, async (pivot) => pivot);
    placed.push(film);
  }
  return placed;
};

/** Answers a session to completion, always preferring the subject. */
const finish = async (step, subject) => {
  let current = step;
  let guard = 0;
  while (!current.done) {
    current = await one(t.db, `select rank_answer($1, $2, $3) as r`, [
      current.session_id,
      subject,
      await op(),
    ]);
    guard += 1;
    if (guard > 32) throw new Error('did not converge');
  }
  return current;
};

// ---------------------------------------------------------------------------

describe('one activity per watch, and none for a correction', () => {
  it('writes exactly one activity for a first ranking', async () => {
    await anchors(3);
    const film = await movie('First');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);

    assert.equal(await events(film), 1);
  });

  /**
   * The founder's four War Dogs. Changing a rating three times used to write three
   * identical activities — all true, none of them a thing that happened to anybody else.
   */
  it('writes none at all for Change your rating in the same band', async () => {
    await anchors(3);
    const film = await movie('Corrected');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    assert.equal(await events(film), 1, 'the first ranking posted');

    for (let i = 0; i < 3; i += 1) {
      const step = await one(t.db, `select rank_again($1, 'loved', $2, false) as r`, [
        film,
        await op(),
      ]);
      await finish(step, film);
    }

    assert.equal(await events(film), 1, 'and three corrections added nothing');
    assert.equal((await rankingOf(film)).bucket, 'loved');
    await t.assertValid(user);
  });

  it('writes none for a band change either', async () => {
    await anchors(3);
    await anchors(3, 'fine');
    const film = await movie('Rebucketed');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);

    const step = await one(t.db, `select rank_rebucket($1, 'fine', $2) as r`, [film, await op()]);
    await finish(step, film);

    assert.equal(await events(film), 1, 'moving a band is a correction, not a viewing');
    assert.equal((await rankingOf(film)).bucket, 'fine', 'and the band did move');
    await t.assertValid(user);
  });

  it('writes exactly one more for Rank again, and only at the end', async () => {
    await anchors(3);
    const film = await movie('Watched twice');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);

    const step = await one(t.db, `select rank_again($1, 'loved', $2, true) as r`, [
      film,
      await op(),
    ]);
    assert.equal(step.done, false);
    assert.equal(await events(film), 1, 'nothing is posted for opening the session');

    await finish(step, film);
    assert.equal(await events(film), 2, 'and exactly one is posted for finishing it');
    await t.assertValid(user);
  });

  it('writes nothing for a Rank again that is abandoned', async () => {
    await anchors(3);
    const film = await movie('Thought better of it');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    const before = await rankingOf(film);

    const step = await one(t.db, `select rank_again($1, 'loved', $2, true) as r`, [
      film,
      await op(),
    ]);
    // One comparison answered, then the reader closes the sheet.
    await one(t.db, `select rank_answer($1, $2, $3) as r`, [step.session_id, step.pivot, await op()]);
    await t.sql(`select rank_cancel($1)`, [step.session_id]);

    assert.equal(await events(film), 1);
    assert.deepEqual(await rankingOf(film), before, 'and the ranking is exactly where it was');
    await t.assertValid(user);
  });

  /**
   * A replayed `rank_answer` is the case that costs most: the transaction commits, the
   * reply is lost, and the reader presses the same control again. `_claim_operation`
   * answers it from the ledger, so the second attempt cannot write a second activity.
   */
  it('writes nothing extra when the finishing answer is retried', async () => {
    await anchors(3);
    const film = await movie('Retried');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);

    let step = await one(t.db, `select rank_again($1, 'loved', $2, true) as r`, [
      film,
      await op(),
    ]);
    // Narrow to the last comparison, then replay the one that finalises.
    while (true) {
      const id = await op();
      const next = await one(t.db, `select rank_answer($1, $2, $3) as r`, [
        step.session_id,
        film,
        id,
      ]);
      if (next.done) {
        const replay = await one(t.db, `select rank_answer($1, $2, $3) as r`, [
          step.session_id,
          film,
          id,
        ]);
        assert.deepEqual(replay, next, 'the replay is answered from the ledger');
        break;
      }
      step = next;
    }

    assert.equal(await events(film), 2, 'one for the first watch, one for the second');
    assert.equal((await t.sql(`select count(*)::int as n from rankings where user_id = $1`, [user])).rows[0].n, 4);
    await t.assertValid(user);
  });

  /**
   * The installed friend-beta build calls `rank_again` with three arguments from *both*
   * Rank again and Change your rating, so it cannot say which it meant. The default is
   * the conservative one: an activity that should have been posted and was not is
   * recoverable; the duplicate feed is the bug being fixed.
   */
  it('defaults to no activity when the caller does not say', async () => {
    await anchors(3);
    const film = await movie('Old client');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);

    const step = await one(t.db, `select rank_again($1, 'loved'::taste_bucket, $2) as r`, [
      film,
      await op(),
    ]);
    await finish(step, film);

    assert.equal(await events(film), 1);
  });

  /**
   * Whatever the caller says, a placement that creates a position where there was none
   * is a first ranking by observation, and PRD §11 has always posted one for it. The
   * case is reachable: `rank_again` on a title that lost its position between the screen
   * reading it and the call.
   */
  it('still posts for a placement that replaced nothing', async () => {
    await anchors(3);
    const film = await movie('Never ranked');
    await t.sql(`select set_bucket($1, $2, 'loved'::taste_bucket)`, [await op(), film]);

    const step = await one(t.db, `select rank_again($1, 'loved', $2, false) as r`, [
      film,
      await op(),
    ]);
    await finish(step, film);

    assert.equal(await events(film), 1);
  });
});

// ---------------------------------------------------------------------------

describe('what a re-ranking must not destroy', () => {
  const write = async (film, text, visibility) => {
    await t.sql(
      `select save_note($1, $2, $3, null, $4::note_visibility, false)`,
      [await op(), film, text, visibility],
    );
  };

  /**
   * PRD §10: reranking never deletes viewing history. For v1 there is one current review
   * and one current private note per title, and another watch does not clear either —
   * the reader edits them from the post-rank log sheet if they want to.
   */
  it('keeps a review through a completed Rank again', async () => {
    await anchors(3);
    const film = await movie('Reviewed');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    await write(film, 'Better the second time.', 'public');

    const step = await one(t.db, `select rank_again($1, 'loved', $2, true) as r`, [
      film,
      await op(),
    ]);
    await finish(step, film);

    const row = await collection(film);
    assert.equal(row.note, 'Better the second time.');
    assert.equal(row.note_visibility, 'public', 'and it is still a review, not a note');
  });

  it('keeps a private note through a completed Rank again', async () => {
    await anchors(3);
    const film = await movie('Noted');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    await write(film, 'Watched with Dad.', 'private');

    const step = await one(t.db, `select rank_again($1, 'loved', $2, true) as r`, [
      film,
      await op(),
    ]);
    await finish(step, film);

    const row = await collection(film);
    assert.equal(row.note, 'Watched with Dad.');
    assert.equal(row.note_visibility, 'private', 'and it was not published by the rerank');
  });

  it('keeps both through an abandoned one', async () => {
    await anchors(3);
    const film = await movie('Abandoned with writing');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    await write(film, 'Still thinking about it.', 'public');
    const before = await collection(film);

    const step = await one(t.db, `select rank_again($1, 'loved', $2, true) as r`, [
      film,
      await op(),
    ]);
    await t.sql(`select rank_cancel($1)`, [step.session_id]);

    assert.deepEqual(await collection(film), before);
  });

  /**
   * The band change is the one where losing the collection row would be easiest: the
   * bucket is written at the *end* now rather than at the start, so the row has to
   * survive a session it is not describing yet.
   */
  it('keeps the old bucket visible until a band change completes', async () => {
    await anchors(3);
    await anchors(3, 'fine');
    const film = await movie('Mid-move');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);

    const step = await one(t.db, `select rank_rebucket($1, 'fine', $2) as r`, [film, await op()]);
    assert.equal((await collection(film)).bucket, 'loved', 'still Loved during the session');
    assert.equal((await rankingOf(film)).bucket, 'loved', 'and still holding its place in it');

    await finish(step, film);
    assert.equal((await collection(film)).bucket, 'fine');
    assert.equal((await rankingOf(film)).bucket, 'fine');
    await t.assertValid(user);
  });

  it('restores the old bucket when a band change is abandoned', async () => {
    await anchors(3);
    await anchors(3, 'fine');
    const film = await movie('Changed my mind');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    const before = await rankingOf(film);

    const step = await one(t.db, `select rank_rebucket($1, 'fine', $2) as r`, [film, await op()]);
    await t.sql(`select rank_cancel($1)`, [step.session_id]);

    assert.equal((await collection(film)).bucket, 'loved');
    assert.deepEqual(await rankingOf(film), before);
    await t.assertValid(user);
  });
});
