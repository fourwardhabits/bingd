import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Reviews of a whole TV show (title/series-reviews, 2026-11-21).
 *
 * The title page used to skip a series for every review read, on the reasoning that a
 * show could not be ranked. Since 20261114000200 a show is ranked in its own `tv_shows`
 * pool, and the page now asks a series for its reviews exactly as it asks a film or a
 * season. Nothing in the review backend checks `media_items.kind`: `save_note`,
 * `title_reviews_v2`, `title_review_count`, `_helpful_target` and `set_review_helpful` key
 * on the one `media_item_id` and share `can_view_profile`. This file pins that a show's
 * reviews really do behave like a film's against a real schema, so a future `kind` check
 * cannot quietly bring the missing section back:
 *
 *   - an unranked show and a ranked one (an explicit `tv_shows` ranking);
 *   - the score beside a show review is the show's own ranking, never its seasons';
 *   - the show's reviews and its seasons' are separate populations;
 *   - writing, editing and unpublishing through `save_note` / `log_watched`;
 *   - Helpful votes, and the self-vote refusal;
 *   - a private author, a block in either direction, and a private note.
 *
 * Every read goes through the `authenticated` role (RLS on, grants enforced) and every
 * write through the app's own RPCs, as `review-visibility-cross-account.test.mjs` does.
 */

let t;
let seq = 0;
const tmdb = () => 114500 + (seq += 1);

const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
const user = (name, visibility = 'public') =>
  t.createUser({ username: `srv_${name}_${(seq += 1)}`, visibility });

const as = async (who, fn) => {
  await t.actAs(who);
  try {
    return await fn();
  } finally {
    await t.actAs(null);
  }
};

const saveNote = (who, item, text, visibility = null, { base = null, spoilers = null } = {}) =>
  as(who, async () => {
    const { rows } = await t.sql(
      `select save_note($1, $2, $3, $4, $5::note_visibility, $6) as r`,
      [await uuid(), item, text, base, visibility, spoilers],
    );
    return rows[0].r;
  });

/** Logs it watched, unranked, with a public note: the page's first-review path. */
const logWithReview = (who, item, text) =>
  as(who, async () => {
    const { rows } = await t.sql(
      `select log_watched($1, $2, current_date, $3, 'public'::note_visibility) as r`,
      [await uuid(), item, text],
    );
    return rows[0].r;
  });

const rank = (who, item, bucket = 'loved') =>
  as(who, () => t.rankToCompletion(item, bucket, async (pivot) => pivot));

const reviews = (viewer, item, sort = 'top_desc') =>
  t.asUser(viewer, async () =>
    (await t.sql(`select * from title_reviews_v2($1, $2, 100)`, [item, sort])).rows);

const count = (viewer, item) =>
  t.asUser(viewer, async () =>
    (await t.sql(`select title_review_count($1) as n`, [item])).rows[0].n);

/** What the page draws for `viewer`: the rows' authors, with the tab's count in parity. */
const authors = async (viewer, item) => {
  const rows = await reviews(viewer, item);
  assert.equal(await count(viewer, item), rows.length, 'count and rows disagree');
  return rows.map((row) => row.user_id).sort();
};

const helpful = (voter, reviewId, on = true) =>
  t.asUser(voter, async () =>
    (
      await t.sql(`select set_review_helpful($1, $2, $3) as r`, [await uuid(), reviewId, on])
    ).rows[0].r);

const reviewIdOf = async (who, item) =>
  (
    await t.sql(`select id from user_media where user_id = $1 and media_item_id = $2`, [
      who,
      item,
    ])
  ).rows[0].id;

const follow = (follower, followee, state = 'approved') =>
  t.sql(
    `insert into follows (follower_id, followee_id, state, approved_at)
     values ($1, $2, $3::follow_state, case when $3 = 'approved' then now() end)
     on conflict (follower_id, followee_id) do update
       set state = excluded.state, approved_at = excluded.approved_at`,
    [follower, followee, state],
  );

const block = (blocker, blocked) =>
  t.asUser(blocker, async () => {
    await t.sql(`select block($1, $2)`, [await uuid(), blocked]);
  });

/** The server's own band score for `who` on `item`, from `score_for` over `band_bounds`. */
const scoreOf = async (who, item) => {
  const { rows } = await t.sql(
    `select score_for(r.bucket, (r.position - bb.lo + 1)::integer, bb.size) as s, r.category
       from rankings r
       join lateral band_bounds(r.user_id, r.category, r.bucket) bb on true
      where r.user_id = $1 and r.media_item_id = $2`,
    [who, item],
  );
  return rows[0] ? { score: Number(rows[0].s), category: rows[0].category } : null;
};

const show = async (title = 'Yu-Gi-Oh! Duel Monsters') => {
  const id = await t.createSeries(title, tmdb());
  const s1 = await t.createSeason(id, 1, 'Season 1');
  const s2 = await t.createSeason(id, 2, 'Season 2');
  return { id, seasons: [s1, s2] };
};

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

beforeEach(async () => {
  await t.actAs(null);
});

describe('a review of an unranked show', () => {
  it('is written by logging the show, and read by another account with no score', async () => {
    const a = await user('a1');
    const b = await user('b1');
    const { id } = await show();

    const logged = await logWithReview(b, id, 'Heart of the cards.');
    assert.equal(logged.status, 'ok');

    const rows = await reviews(a, id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, b);
    assert.equal(rows[0].note, 'Heart of the cards.');
    assert.equal(rows[0].score, null, 'an unranked show review carries no score');
    assert.deepEqual(await authors(a, id), [b]);
    // The author sees their own review the same way.
    assert.deepEqual(await authors(b, id), [b]);
  });
});

describe('a review of a ranked show', () => {
  it('carries the show’s own tv_shows score, the same number score_for gives', async () => {
    const a = await user('a2');
    const b = await user('b2');
    const { id } = await show();

    await rank(b, id, 'loved');
    const ranked = await scoreOf(b, id);
    assert.equal(ranked.category, 'tv_shows');
    assert.equal((await saveNote(b, id, 'King of Games.', 'public')).status, 'ok');

    const [row] = await reviews(a, id);
    assert.equal(row.note, 'King of Games.');
    assert.equal(Number(row.score), ranked.score);
  });

  it('never borrows a score from the show’s seasons (an SN AVG show stays unscored)', async () => {
    const a = await user('a3');
    const b = await user('b3');
    const { id, seasons } = await show('Seasons Only');

    // B ranks both seasons, never the show, and reviews the show itself.
    await rank(b, seasons[0], 'loved');
    await rank(b, seasons[1], 'fine');
    await logWithReview(b, id, 'Better as a whole.');

    const [row] = await reviews(a, id);
    assert.equal(row.note, 'Better as a whole.');
    assert.equal(row.score, null);
  });
});

describe('the show’s reviews and its seasons’ are separate', () => {
  it('lists each title’s own reviews and counts, and nothing of the other level', async () => {
    const a = await user('a4');
    const showReviewer = await user('show4');
    const seasonReviewer = await user('season4');
    const { id, seasons } = await show('Separate Levels');

    await logWithReview(showReviewer, id, 'The whole show.');
    await rank(seasonReviewer, seasons[0], 'loved');
    await saveNote(seasonReviewer, seasons[0], 'Just season one.', 'public');

    assert.deepEqual(await authors(a, id), [showReviewer]);
    assert.deepEqual(await authors(a, seasons[0]), [seasonReviewer]);
    assert.deepEqual(await authors(a, seasons[1]), []);
    assert.equal((await reviews(a, id))[0].note, 'The whole show.');
    assert.equal((await reviews(a, seasons[0]))[0].note, 'Just season one.');
  });
});

describe('editing a show review', () => {
  it('edits in place with the base version, and unpublishing removes it from the list', async () => {
    const a = await user('a5');
    const b = await user('b5');
    const { id } = await show('Edited Show');
    await rank(b, id);

    const first = await saveNote(b, id, 'First take.', 'public');
    const edited = await saveNote(b, id, 'Second take.', null, { base: first.note_version });
    assert.equal(edited.status, 'ok');
    const rows = await reviews(a, id);
    assert.equal(rows.length, 1, 'an edit is the same review, never a second one');
    assert.equal(rows[0].note, 'Second take.');

    await saveNote(b, id, 'Second take.', 'private', { base: edited.note_version });
    assert.deepEqual(await authors(a, id), []);
    assert.deepEqual(await authors(b, id), [], 'a private note is nobody’s review');
  });

  it('refuses a stale edit with 55000, as a film’s', async () => {
    const b = await user('b6');
    const { id } = await show('Stale Show');
    await rank(b, id);
    const first = await saveNote(b, id, 'One.', 'public');
    await saveNote(b, id, 'Two.', null, { base: first.note_version });

    await t.actAs(b);
    try {
      const e = await t.errorFrom(
        `select save_note($1, $2, 'Three.', $3::timestamptz, null, null)`,
        [await uuid(), id, first.note_version],
      );
      assert.equal(e?.code, '55000');
    } finally {
      await t.actAs(null);
    }
  });

  it('keeps the spoiler flag the author set', async () => {
    const a = await user('a7');
    const b = await user('b7');
    const { id } = await show('Spoiler Show');
    await rank(b, id);
    await saveNote(b, id, 'Yugi wins.', 'public', { spoilers: true });
    const [row] = await reviews(a, id);
    assert.equal(row.has_spoilers, true);
  });
});

describe('Helpful on a show review', () => {
  it('counts a vote, takes it back, and refuses the author’s own', async () => {
    const a = await user('a8');
    const b = await user('b8');
    const { id } = await show('Helpful Show');
    await rank(b, id);
    await saveNote(b, id, 'Worth it.', 'public');
    const reviewId = await reviewIdOf(b, id);

    const on = await helpful(a, reviewId, true);
    assert.equal(on.helpful_count, 1);
    assert.equal(on.viewer_helpful, true);
    const [row] = await reviews(a, id);
    assert.equal(row.helpful_count, 1);
    assert.equal(row.viewer_helpful, true);

    const off = await helpful(a, reviewId, false);
    assert.equal(off.helpful_count, 0);

    const op = await uuid();
    const own = await t.asUser(b, () =>
      t.errorFrom(`select set_review_helpful($1, $2, true)`, [op, reviewId]),
    );
    assert.equal(own?.code, '42501');
  });
});

describe('who may read a show review', () => {
  it('hides a private account’s show review from a non-follower, and shows it to a follower', async () => {
    const stranger = await user('stranger9');
    const follower = await user('follower9');
    const pending = await user('pending9');
    const b = await user('b9', 'private');
    const { id } = await show('Private Show');
    await rank(b, id);
    await saveNote(b, id, 'For my followers.', 'public');
    await follow(follower, b, 'approved');
    await follow(pending, b, 'pending');

    assert.deepEqual(await authors(stranger, id), []);
    assert.deepEqual(await authors(pending, id), []);
    assert.deepEqual(await authors(follower, id), [b]);
    assert.deepEqual(await authors(b, id), [b]);

    // And a vote cannot be used to find it: the same refusal as a review that is not there.
    const reviewId = await reviewIdOf(b, id);
    const op = await uuid();
    const probe = await t.asUser(stranger, () =>
      t.errorFrom(`select set_review_helpful($1, $2, true)`, [op, reviewId]),
    );
    assert.equal(probe?.code, 'P0002');
  });

  it('hides a show review across a block, in either direction', async () => {
    const a = await user('a10');
    const b = await user('b10');
    const c = await user('c10');
    const { id } = await show('Blocked Show');
    await rank(b, id);
    await saveNote(b, id, 'Across a block.', 'public');

    await block(a, b);
    assert.deepEqual(await authors(a, id), [], 'the blocker no longer reads it');
    await block(b, c);
    assert.deepEqual(await authors(c, id), [], 'the blocked no longer reads it');

    const reviewId = await reviewIdOf(b, id);
    const op = await uuid();
    const probe = await t.asUser(a, () =>
      t.errorFrom(`select set_review_helpful($1, $2, true)`, [op, reviewId]),
    );
    assert.equal(probe?.code, 'P0002');
  });
});
