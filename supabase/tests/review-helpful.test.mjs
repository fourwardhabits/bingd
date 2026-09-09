import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Helpful — 20260911000100.
 *
 * The feature is one positive signal on a public review, and almost everything worth
 * testing about it is a refusal. A review is `user_media.note` at
 * `note_visibility = 'public'`, which means the same column, the same row and the same
 * table hold the private notes nobody may ever reach. So the tests that matter are the
 * ones asserting that a private note is not merely *absent* from the list but
 * **unreachable through the vote RPC**, and indistinguishable from a uuid that was never
 * a review at all.
 *
 * The sorting tests set `note_updated_at` directly rather than relying on the order
 * `save_note` happens to write in. A tiebreak that only works because two writes landed
 * a microsecond apart is not a tiebreak.
 */

let t;
let author;      // writes the public review under test
let second;      // a second public author, for sorting and Following
let third;       // a third, followed by nobody
let reader;      // the viewer doing the voting
let voterB;      // a second voter, so a count can exceed one
let privateAuthor;
let film;
let seq = 97000;

const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

/** The app's own writer, so the path under test is the one the app uses. */
const saveNote = async (who, text, visibility) => {
  await t.actAs(who);
  const { rows } = await t.sql(
    `select save_note($1, $2, $3, null, $4::note_visibility, null) as r`,
    [await uuid(), film, text, visibility],
  );
  await t.actAs(null);
  return rows[0].r;
};

/** Give an account a collection row on the film, which `save_note` requires. */
const collect = (who) =>
  t.sql(
    `insert into user_media (user_id, media_item_id, bucket, watched_on)
     values ($1, $2, 'loved', current_date)
     on conflict (user_id, media_item_id) do nothing`,
    [who, film],
  );

const reviewIdOf = async (who) =>
  (await t.sql(`select id from user_media where user_id = $1 and media_item_id = $2`, [who, film]))
    .rows[0].id;

/** What the tab would draw, read as one viewer. */
const list = (viewer, sort = 'top_desc') =>
  t.asUser(viewer, async () => {
    const { rows } = await t.sql(`select * from title_reviews_v2($1, $2, 25)`, [film, sort]);
    return rows;
  });

const vote = (viewer, reviewId, helpful) =>
  t.asUser(viewer, async () => {
    const { rows } = await t.sql(`select set_review_helpful($1, $2, $3) as r`, [
      await uuid(),
      reviewId,
      helpful,
    ]);
    return rows[0].r;
  });

/** The error a refusal produces, or null if the call unexpectedly succeeded. */
const refusal = async (viewer, reviewId, helpful = true) => {
  try {
    await vote(viewer, reviewId, helpful);
    return null;
  } catch (error) {
    return { code: error.code, message: error.message };
  } finally {
    await t.actAs(null);
  }
};

const setNoteTime = (who, iso) =>
  t.sql(
    `update user_media set note_updated_at = $3
      where user_id = $1 and media_item_id = $2`,
    [who, film, iso],
  );

before(async () => {
  t = await createTestDb();

  author = await t.createUser({ username: 'rh_author' });
  second = await t.createUser({ username: 'rh_second' });
  third = await t.createUser({ username: 'rh_third' });
  reader = await t.createUser({ username: 'rh_reader' });
  voterB = await t.createUser({ username: 'rh_voter_b' });
  privateAuthor = await t.createUser({ username: 'rh_private' });
  film = await t.createMovie('The Helpful One', seq++);

  for (const who of [author, second, third, privateAuthor]) await collect(who);

  await saveNote(author, 'The one everybody found useful.', 'public');
  await saveNote(second, 'A second opinion.', 'public');
  await saveNote(third, 'A third, from a stranger.', 'public');
  await saveNote(privateAuthor, 'Notes to myself, not for anyone.', 'private');

  // The reader follows two of the three public authors, so Following has something to
  // exclude. Approved, because a pending request is not a following relationship.
  await t.sql(
    `insert into follows (follower_id, followee_id, state)
     values ($1, $2, 'approved'), ($1, $3, 'approved')`,
    [reader, author, second],
  );
});

after(async () => {
  await t?.close();
});

beforeEach(async () => {
  await t.actAs(null);
  await t.sql(`delete from review_helpful_votes`);
});

// ---------------------------------------------------------------------------
// Privacy. The half of this feature that must never be wrong.
// ---------------------------------------------------------------------------

describe('a private note is not a review', () => {
  it('never appears in the list, under any sort', async () => {
    for (const sort of ['top_desc', 'top_asc', 'following', 'recent_desc', 'recent_asc']) {
      const rows = await list(reader, sort);
      assert.equal(
        rows.some((r) => r.user_id === privateAuthor),
        false,
        `a private note surfaced under ${sort}`,
      );
      assert.equal(
        rows.some((r) => (r.note ?? '').includes('Notes to myself')),
        false,
        `private text surfaced under ${sort}`,
      );
    }
  });

  it('cannot be voted on, and is not counted', async () => {
    const privateId = await reviewIdOf(privateAuthor);
    const denied = await refusal(reader, privateId);
    assert.notEqual(denied, null, 'a private note accepted a Helpful vote');

    const { rows } = await t.sql(`select count(*)::int as n from review_helpful_votes`);
    assert.equal(rows[0].n, 0);
  });

  it('refuses identically to a uuid that was never a review, so it cannot be detected', async () => {
    /**
     * The disclosure this whole design is arranged around. If "private note" and "no such
     * row" produced different errors, the RPC would answer the question *is there a
     * private note behind this id* for any id an attacker could guess or observe — and
     * `user_media.id` is returned to every reader by `title_reviews`.
     */
    const privateId = await reviewIdOf(privateAuthor);
    const nonsense = await uuid();

    const forPrivate = await refusal(reader, privateId);
    const forNothing = await refusal(reader, nonsense);

    assert.notEqual(forPrivate, null);
    assert.notEqual(forNothing, null);
    assert.equal(forPrivate.message, forNothing.message);
    assert.equal(forPrivate.code, forNothing.code);
  });

  it('is not counted by the tab label', async () => {
    const n = await t.asUser(reader, async () =>
      (await t.sql(`select title_review_count($1) as n`, [film])).rows[0].n);
    await t.actAs(null);
    // Three public reviews. The private one is not one of them.
    assert.equal(n, 3);
  });
});

describe('a blocked author', () => {
  it('is neither listed nor votable', async () => {
    const thirdId = await reviewIdOf(third);

    await t.asUser(third, async () => {
      await t.sql(`select block($1, $2)`, [await uuid(), reader]);
    });
    await t.actAs(null);

    try {
      const rows = await list(reader, 'recent_desc');
      assert.equal(rows.some((r) => r.user_id === third), false, 'a blocker’s review was listed');

      const denied = await refusal(reader, thirdId);
      assert.notEqual(denied, null, 'a blocker’s review accepted a vote');
    } finally {
      await t.asUser(third, async () => {
        await t.sql(`select unblock($1, $2)`, [await uuid(), reader]);
      });
      await t.actAs(null);
    }
  });
});

describe('the votes table itself', () => {
  it('is unreadable and unwritable by a client role', async () => {
    const reviewId = await reviewIdOf(author);
    await vote(reader, reviewId, true);
    await t.actAs(null);

    /**
     * Refused at the grant, before RLS is even consulted.
     *
     * `revoke all` and an enabled RLS with no policy are two independent locks and this
     * asserts the outer one: a client role does not get zero rows from this table, it
     * gets 42501. The count is only ever reachable through the functions, which is what
     * stops the table being an enumeration surface for `user_media.id`.
     */
    let read = null;
    try {
      await t.asUser(voterB, async () => {
        await t.sql(`select count(*) from review_helpful_votes`);
      });
      read = 'allowed';
    } catch (error) {
      read = error.code;
    }
    await t.actAs(null);
    assert.equal(read, '42501', 'a client role could read the votes table');

    let wrote = null;
    try {
      await t.asUser(voterB, async () => {
        await t.sql(`insert into review_helpful_votes (review_id, user_id) values ($1, $2)`, [
          reviewId,
          voterB,
        ]);
      });
      wrote = 'inserted';
    } catch {
      wrote = 'refused';
    }
    await t.actAs(null);
    assert.equal(wrote, 'refused', 'a client role could write the votes table directly');
  });
});

// ---------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------

describe('marking a review helpful', () => {
  it('adds, and reports the count and the viewer’s own state', async () => {
    const reviewId = await reviewIdOf(author);
    const result = await vote(reader, reviewId, true);
    await t.actAs(null);

    assert.equal(result.status, 'ok');
    assert.equal(result.helpful_count, 1);
    assert.equal(result.viewer_helpful, true);
  });

  it('takes it back', async () => {
    const reviewId = await reviewIdOf(author);
    await vote(reader, reviewId, true);
    const result = await vote(reader, reviewId, false);
    await t.actAs(null);

    assert.equal(result.helpful_count, 0);
    assert.equal(result.viewer_helpful, false);
  });

  it('cannot be cast twice by the same person', async () => {
    const reviewId = await reviewIdOf(author);
    await vote(reader, reviewId, true);
    // A second call with a *different* operation id, which is the case the primary key
    // has to catch rather than the idempotency ledger.
    const again = await vote(reader, reviewId, true);
    await t.actAs(null);

    assert.equal(again.helpful_count, 1);
    assert.equal(again.viewer_helpful, true);
  });

  it('counts two different people as two', async () => {
    const reviewId = await reviewIdOf(author);
    await vote(reader, reviewId, true);
    const result = await vote(voterB, reviewId, true);
    await t.actAs(null);

    assert.equal(result.helpful_count, 2);
  });

  it('refuses the caller’s own review', async () => {
    const reviewId = await reviewIdOf(author);
    const denied = await refusal(author, reviewId);
    assert.notEqual(denied, null, 'an author marked their own review helpful');
    assert.match(denied.message, /your own review/i);

    const { rows } = await t.sql(`select count(*)::int as n from review_helpful_votes`);
    assert.equal(rows[0].n, 0);
  });

  it('cannot be used to vote on another person’s behalf', async () => {
    // There is no recipient parameter. The row is keyed on auth.uid() inside the
    // function, so the only vote a caller can cast or clear is their own — asserted by
    // clearing as the wrong person and finding the other's vote intact.
    const reviewId = await reviewIdOf(author);
    await vote(reader, reviewId, true);
    const result = await vote(voterB, reviewId, false);
    await t.actAs(null);

    assert.equal(result.helpful_count, 1, 'one person’s removal took another person’s vote');
    assert.equal(result.viewer_helpful, false);
  });

  it('goes when the review row goes', async () => {
    // A note deleted with its collection row takes its votes with it, so a count can
    // never outlive the writing it was about.
    const other = await t.createUser({ username: 'rh_transient' });
    await collect(other);
    await saveNote(other, 'Briefly here.', 'public');
    const transientId = await reviewIdOf(other);
    await vote(reader, transientId, true);
    await t.actAs(null);

    await t.sql(`delete from user_media where user_id = $1 and media_item_id = $2`, [other, film]);
    const { rows } = await t.sql(`select count(*)::int as n from review_helpful_votes where review_id = $1`, [
      transientId,
    ]);
    assert.equal(rows[0].n, 0);
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe('the order the tab draws', () => {
  before(async () => {
    // Fixed, distinct times so a tiebreak is tested rather than observed.
    await setNoteTime(author, '2026-09-01T10:00:00Z');
    await setNoteTime(second, '2026-09-02T10:00:00Z');
    await setNoteTime(third, '2026-09-03T10:00:00Z');
  });

  it('leads with the most helpful, newest first inside a tie', async () => {
    const secondId = await reviewIdOf(second);
    await vote(reader, secondId, true);
    await vote(voterB, secondId, true);
    await t.actAs(null);

    const rows = await list(reader, 'top_desc');
    await t.actAs(null);
    // second has two; author and third have none and fall back to recency, newest first.
    assert.deepEqual(rows.map((r) => r.user_id), [second, third, author]);
    assert.equal(rows[0].helpful_count, 2);
  });

  it('is the default, so a caller that names no sort gets it', async () => {
    const secondId = await reviewIdOf(second);
    await vote(reader, secondId, true);
    await t.actAs(null);

    const rows = await t.asUser(reader, async () =>
      (await t.sql(`select * from title_reviews_v2($1)`, [film])).rows);
    await t.actAs(null);
    assert.equal(rows[0].user_id, second);
  });

  it('reverses on top_asc, and its tiebreak reverses with it', async () => {
    const secondId = await reviewIdOf(second);
    await vote(reader, secondId, true);
    await t.actAs(null);

    const rows = await list(reader, 'top_asc');
    await t.actAs(null);
    // The two with none come first, oldest first between them; the helpful one last.
    assert.deepEqual(rows.map((r) => r.user_id), [author, third, second]);
  });

  it('orders by recency alone under recent_desc and recent_asc', async () => {
    const authorId = await reviewIdOf(author);
    // A vote that must NOT affect a recency sort.
    await vote(reader, authorId, true);
    await t.actAs(null);

    const newest = await list(reader, 'recent_desc');
    await t.actAs(null);
    assert.deepEqual(newest.map((r) => r.user_id), [third, second, author]);

    const oldest = await list(reader, 'recent_asc');
    await t.actAs(null);
    assert.deepEqual(oldest.map((r) => r.user_id), [author, second, third]);
  });

  it('reports the viewer’s own vote per row, and only theirs', async () => {
    const authorId = await reviewIdOf(author);
    await vote(voterB, authorId, true);
    await t.actAs(null);

    const mine = await list(reader, 'recent_asc');
    await t.actAs(null);
    assert.equal(mine[0].helpful_count, 1, 'the count is everybody’s');
    assert.equal(mine[0].viewer_helpful, false, 'somebody else’s vote showed as the viewer’s');

    const theirs = await list(voterB, 'recent_asc');
    await t.actAs(null);
    assert.equal(theirs[0].viewer_helpful, true);
  });
});

describe('Following', () => {
  it('is a filter: only people the viewer follows, and never themselves', async () => {
    const rows = await list(reader, 'following');
    await t.actAs(null);
    assert.deepEqual(new Set(rows.map((r) => r.user_id)), new Set([author, second]));
    assert.equal(rows.some((r) => r.user_id === third), false, 'a stranger appeared under Following');
  });

  it('orders like Top inside the filter, most helpful then newest', async () => {
    const authorId = await reviewIdOf(author);
    await vote(voterB, authorId, true);
    await t.actAs(null);

    const rows = await list(reader, 'following');
    await t.actAs(null);
    assert.deepEqual(rows.map((r) => r.user_id), [author, second]);
  });

  it('does not count a pending follow request as following', async () => {
    const pending = await t.createUser({ username: 'rh_pending' });
    await collect(pending);
    await saveNote(pending, 'Awaiting approval.', 'public');
    await t.sql(`insert into follows (follower_id, followee_id, state) values ($1, $2, 'pending')`, [
      reader,
      pending,
    ]);

    const rows = await list(reader, 'following');
    await t.actAs(null);
    assert.equal(rows.some((r) => r.user_id === pending), false);

    await t.sql(`delete from follows where follower_id = $1 and followee_id = $2`, [reader, pending]);
    await t.sql(`delete from user_media where user_id = $1 and media_item_id = $2`, [pending, film]);
  });

  it('is empty rather than broken for somebody who follows nobody', async () => {
    const rows = await list(voterB, 'following');
    await t.actAs(null);
    assert.deepEqual(rows, []);
  });
});

// ---------------------------------------------------------------------------
// The public build that is already installed
// ---------------------------------------------------------------------------

describe('backward compatibility with build 1.0.0 (7)', () => {
  it('leaves the old title_reviews callable, with the shape it had', async () => {
    /**
     * The hard requirement. A phone in somebody's pocket calls
     * `title_reviews(uuid, text, integer)` and expects ten columns in a fixed order. If
     * this ever fails, that phone's Reviews tab is broken by a migration it never asked
     * for.
     */
    const rows = await t.asUser(reader, async () =>
      (await t.sql(`select * from title_reviews($1, 'top', 25)`, [film])).rows);
    await t.actAs(null);

    assert.equal(rows.length, 3);
    assert.deepEqual(Object.keys(rows[0]), [
      'id',
      'user_id',
      'username',
      'display_name',
      'avatar_path',
      'note',
      'has_spoilers',
      'updated_at',
      'score',
      'reaction_count',
    ]);
  });

  it('still hides private notes from the old function too', async () => {
    const rows = await t.asUser(reader, async () =>
      (await t.sql(`select * from title_reviews($1, 'recent', 25)`, [film])).rows);
    await t.actAs(null);
    assert.equal(rows.some((r) => r.user_id === privateAuthor), false);
  });

  it('answers the legacy sort words on the new function as their descending sense', async () => {
    const secondId = await reviewIdOf(second);
    await vote(reader, secondId, true);
    await t.actAs(null);

    const top = await list(reader, 'top');
    await t.actAs(null);
    assert.equal(top[0].user_id, second);

    const recent = await list(reader, 'recent');
    await t.actAs(null);
    assert.equal(recent[0].user_id, third);
  });

  it('falls back to the default rather than failing on an unknown sort', async () => {
    const rows = await list(reader, 'sideways');
    await t.actAs(null);
    assert.equal(rows.length, 3);
  });
});

/**
 * What an unrecognised sort actually orders by — 20260911000200.
 *
 * Independent review found that `20260911000100` read `p_sort` in six separate places and
 * claimed a fallback it did not implement. Asserting "three rows came back" was what let
 * that through: the rows were there, in an order nobody chose.
 */
describe('a sort nobody recognises', () => {
  before(async () => {
    await setNoteTime(author, '2026-09-01T10:00:00Z');
    await setNoteTime(second, '2026-09-02T10:00:00Z');
    await setNoteTime(third, '2026-09-03T10:00:00Z');
  });

  it('orders an unknown value exactly as top_desc, not merely returning rows', async () => {
    const secondId = await reviewIdOf(second);
    await vote(reader, secondId, true);
    await vote(voterB, secondId, true);
    await t.actAs(null);

    const expected = await list(reader, 'top_desc');
    await t.actAs(null);
    const actual = await list(reader, 'sideways');
    await t.actAs(null);

    assert.deepEqual(actual.map((r) => r.user_id), expected.map((r) => r.user_id));
    assert.equal(actual[0].user_id, second);
  });

  it('treats null as top_desc rather than as the Following filter', async () => {
    /**
     * The defect this migration exists for. `null <> 'following'` is `null`, so the whole
     * disjunction fell to the `exists` branch and a caller who named no sort silently got
     * Following: everybody they do not follow vanished, with no error and nothing to see
     * it by. `third` is followed by nobody, which is what makes them the witness.
     */
    const rows = await t.asUser(reader, async () => {
      const { rows: r } = await t.sql(`select * from title_reviews_v2($1, null, 25)`, [film]);
      return r;
    });
    await t.actAs(null);

    assert.equal(rows.length, 3, 'a null sort filtered the list to Following');
    assert.equal(rows.some((r) => r.user_id === third), true, 'the unfollowed author vanished');
  });

  it('treats an empty string the same way', async () => {
    const rows = await list(reader, '');
    await t.actAs(null);
    assert.equal(rows.length, 3);
    assert.equal(rows.some((r) => r.user_id === third), true);
  });

  it('still applies Following when Following is what was asked for', async () => {
    // The guard against over-correcting: the filter must survive the fallback.
    const rows = await list(reader, 'following');
    await t.actAs(null);
    assert.equal(rows.some((r) => r.user_id === third), false);
  });
});
