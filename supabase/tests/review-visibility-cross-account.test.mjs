import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * A review, read from the other account — QA 2026-11-14.
 *
 * Everything else in the suite that reads the Reviews tab does so from a fixture built to
 * test one rule at a time. This file asks the question a second person on a second phone
 * asks: *I am A, B wrote something about this title — do I see it, exactly as B wrote it,
 * with B's score beside it, and does the number on the tab agree with the list?*
 *
 * Each case uses a fresh title and fresh accounts, so no case can pass because of a row
 * another case left behind. Every read goes through `title_reviews_v2` and
 * `title_review_count` as the `authenticated` role (RLS on, grants enforced), and the
 * writes go through the app's own RPCs (`rankToCompletion`, `save_note`, `log_watched`,
 * `block` / `unblock`) wherever one exists. Follows, profile visibility and suspension
 * are written directly, as the rest of the suite writes them.
 *
 * Parity (case 9) is not a separate case: `view` asserts it on every read. The one
 * exception is the `following` sort, which is a FILTER over the same population that
 * `title_review_count` counts unfiltered — the tab label is the size of the whole list,
 * not of the Following view — so parity for `following` is asserted as "never more than
 * the count", and exact parity is asserted on the unfiltered sorts of the same read.
 */

let t;
let seq = 0;
const tmdb = () => 113000 + (seq += 1);

const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

const user = async (name, visibility = 'public') =>
  t.createUser({ username: `rvx_${name}_${seq += 1}`, visibility });

const movie = (title) => t.createMovie(title, tmdb());

/** The app's writer. Returns the jsonb result, whose note_version is the next base. */
const saveNote = async (who, film, text, visibility = null, { base = null, spoilers = null } = {}) => {
  await t.actAs(who);
  try {
    const { rows } = await t.sql(
      `select save_note($1, $2, $3, $4, $5::note_visibility, $6) as r`,
      [await uuid(), film, text, base, visibility, spoilers],
    );
    return rows[0].r;
  } finally {
    await t.actAs(null);
  }
};

/** Ranks a film for `who` with the app's ranking RPCs, always preferring the incumbent. */
const rank = async (who, film, bucket = 'loved') => {
  await t.actAs(who);
  try {
    return await t.rankToCompletion(film, bucket, async (pivot) => pivot);
  } finally {
    await t.actAs(null);
  }
};

/** Logs a film watched without ranking it — the "logged, unranked" state. */
const logWatched = async (who, film) => {
  await t.actAs(who);
  try {
    const { rows } = await t.sql(`select log_watched($1, $2, current_date) as r`, [
      await uuid(),
      film,
    ]);
    return rows[0].r;
  } finally {
    await t.actAs(null);
  }
};

/**
 * The expected score, computed by the server's own `score_for` over `band_bounds` — the
 * same two functions the Reviews tab quotes — rather than a number guessed here.
 */
const expectedScore = async (who, film) => {
  const { rows } = await t.sql(
    `select score_for(r.bucket, (r.position - bb.lo + 1)::integer, bb.size) as s
       from rankings r
       join lateral band_bounds(r.user_id, r.category, r.bucket) bb on true
      where r.user_id = $1 and r.media_item_id = $2`,
    [who, film],
  );
  return rows[0] ? Number(rows[0].s) : null;
};

const block = (blocker, blocked) =>
  t.asUser(blocker, async () => {
    await t.sql(`select block($1, $2)`, [await uuid(), blocked]);
  });

const unblock = (blocker, blocked) =>
  t.asUser(blocker, async () => {
    await t.sql(`select unblock($1, $2)`, [await uuid(), blocked]);
  });

const follow = (follower, followee, state = 'approved') =>
  t.sql(
    `insert into follows (follower_id, followee_id, state, approved_at)
     values ($1, $2, $3::follow_state, case when $3 = 'approved' then now() end)
     on conflict (follower_id, followee_id) do update
       set state = excluded.state, approved_at = excluded.approved_at`,
    [follower, followee, state],
  );

const countFor = (viewer, film) =>
  t.asUser(viewer, async () =>
    (await t.sql(`select title_review_count($1) as n`, [film])).rows[0].n);

/**
 * What the Reviews tab draws for `viewer` under `sort`, with parity asserted on the way
 * out (case 9): the tab label and the rows behind it must answer the same question.
 */
const view = async (viewer, film, sort = 'top_desc') => {
  const rows = await t.asUser(viewer, async () =>
    (await t.sql(`select * from title_reviews_v2($1, $2, 25)`, [film, sort])).rows);
  const n = await countFor(viewer, film);
  if (sort === 'following') {
    assert.ok(rows.length <= n, `following returned ${rows.length} rows but the count is ${n}`);
  } else {
    assert.equal(n, rows.length, `title_review_count (${n}) ≠ rows (${rows.length}) under ${sort}`);
  }
  return rows;
};

const UNFILTERED = ['top_desc', 'top_asc', 'recent_desc', 'recent_asc'];

/** Asserts `viewer` sees exactly `expected` (user ids) under every unfiltered sort. */
const seesExactly = async (viewer, film, expected, label) => {
  for (const sort of UNFILTERED) {
    const rows = await view(viewer, film, sort);
    assert.deepEqual(
      rows.map((r) => r.user_id).sort(),
      [...expected].sort(),
      `${label} (${sort})`,
    );
  }
};

/** Collection row for a title the author has neither ranked nor logged through an RPC. */
const collect = (who, film) =>
  t.sql(
    `insert into user_media (user_id, media_item_id, bucket, watched_on)
     values ($1, $2, 'loved', current_date)
     on conflict (user_id, media_item_id) do nothing`,
    [who, film],
  );

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

beforeEach(async () => {
  await t.actAs(null);
});

// ---------------------------------------------------------------------------
// 1. A ranked, published review, read from the other account
// ---------------------------------------------------------------------------

describe('1. B ranks a title and publishes a review; A reads it', () => {
  it('is exactly one row with B’s identity, text, live score, version and spoiler flag, on every sort', async () => {
    const a = await user('a1');
    const b = await user('b1');
    const film = await movie('Cross Account One');
    await t.sql(`update profiles set display_name = 'Bea Reviewer', avatar_path = $2 where id = $1`, [
      b,
      `${b}/face.jpg`,
    ]);

    const placed = await rank(b, film, 'loved');
    const saved = await saveNote(b, film, 'B wrote this, for A to read.', 'public', { spoilers: true });
    assert.equal(saved.status, 'ok');

    const score = await expectedScore(b, film);
    assert.notEqual(score, null, 'B’s ranking produced no score');
    // The ranking RPC's own report of the score agrees with score_for over band_bounds.
    assert.equal(Number(placed.score), score);

    const { rows: um } = await t.sql(
      `select id, note_updated_at from user_media where user_id = $1 and media_item_id = $2`,
      [b, film],
    );
    assert.equal(um.length, 1);

    await follow(a, b);

    for (const sort of ['top_desc', 'recent_desc', 'following']) {
      const rows = await view(a, film, sort);
      assert.equal(rows.length, 1, `exactly one row under ${sort}`);
      const [row] = rows;
      assert.equal(row.id, um[0].id);
      assert.equal(row.user_id, b);
      assert.match(row.username, /^rvx_b1_/);
      assert.equal(row.display_name, 'Bea Reviewer');
      assert.equal(row.avatar_path, `${b}/face.jpg`);
      assert.equal(row.note, 'B wrote this, for A to read.');
      assert.equal(row.has_spoilers, true);
      assert.equal(Number(row.score), score, `score under ${sort}`);
      assert.equal(row.updated_at.getTime(), um[0].note_updated_at.getTime());
      assert.equal(new Date(saved.note_version).getTime(), um[0].note_updated_at.getTime());
    }

    // A's count with exact parity on the unfiltered sorts too.
    await seesExactly(a, film, [b], 'A sees B’s review');
    // B sees their own review the same way.
    await seesExactly(b, film, [b], 'B sees their own review');
  });
});

// ---------------------------------------------------------------------------
// 2. A private note is nobody's review — not even its author's
// ---------------------------------------------------------------------------

describe('2. B saves the note private', () => {
  it('is 0 rows and a count of 0 for A and for B', async () => {
    const a = await user('a2');
    const b = await user('b2');
    const film = await movie('Cross Account Two');
    await rank(b, film);
    const saved = await saveNote(b, film, 'Only for me.', 'private');
    assert.equal(saved.status, 'ok');

    for (const viewer of [a, b]) {
      for (const sort of [...UNFILTERED, 'following']) {
        assert.deepEqual(await view(viewer, film, sort), [], `${sort} for ${viewer === a ? 'A' : 'B'}`);
      }
      assert.equal(await countFor(viewer, film), 0);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Private → public with the base version; the first-published stamp is set once
// ---------------------------------------------------------------------------

describe('3. B publishes a private note with the base version', () => {
  it('appears for A, and note_first_published_at is stamped once and never moved by an edit', async () => {
    const a = await user('a3');
    const b = await user('b3');
    const film = await movie('Cross Account Three');
    await rank(b, film);

    const firstSave = await saveNote(b, film, 'Drafting.', 'private');
    const stampOf = async () =>
      (
        await t.sql(
          `select note_first_published_at as p, note_updated_at as v
             from user_media where user_id = $1 and media_item_id = $2`,
          [b, film],
        )
      ).rows[0];

    assert.equal((await stampOf()).p, null, 'a private note was stamped as published');
    await seesExactly(a, film, [], 'A before publication');

    const published = await saveNote(b, film, 'Drafting.', 'public', { base: firstSave.note_version });
    assert.equal(published.status, 'ok');
    const afterPublish = await stampOf();
    assert.ok(afterPublish.p instanceof Date, 'publishing did not stamp note_first_published_at');

    await seesExactly(a, film, [b], 'A after publication');
    const [row] = await view(a, film);
    assert.equal(row.note, 'Drafting.');

    // An edit, with the right base, advances the version and leaves the stamp alone.
    const edited = await saveNote(b, film, 'Drafted, and edited.', null, {
      base: published.note_version,
    });
    assert.equal(edited.status, 'ok');
    const afterEdit = await stampOf();
    assert.equal(afterEdit.p.getTime(), afterPublish.p.getTime(), 'an edit moved the first-published stamp');
    assert.ok(afterEdit.v > afterPublish.v, 'an edit did not advance the version');

    const [editedRow] = await view(a, film);
    assert.equal(editedRow.note, 'Drafted, and edited.');
    assert.equal(editedRow.updated_at.getTime(), afterEdit.v.getTime());

    // Unshare and reshare: still the original instant.
    const hidden = await saveNote(b, film, 'Drafted, and edited.', 'private', { base: edited.note_version });
    await seesExactly(a, film, [], 'A after unsharing');
    await saveNote(b, film, 'Drafted, and edited.', 'public', { base: hidden.note_version });
    await seesExactly(a, film, [b], 'A after resharing');
    assert.equal((await stampOf()).p.getTime(), afterPublish.p.getTime(), 'a reshare moved the stamp');

    // And a stale base is refused rather than silently overwriting.
    const staleOp = await uuid();
    await t.actAs(b);
    const stale = await t.errorFrom(`select save_note($1, $2, $3, $4, null, null)`, [
      staleOp,
      film,
      'Overwrite from an old device.',
      firstSave.note_version,
    ]);
    await t.actAs(null);
    assert.equal(stale?.code, '55000');
    assert.equal((await view(a, film))[0].note, 'Drafted, and edited.');
  });
});

// ---------------------------------------------------------------------------
// 4. A block in either direction hides it; unblocking restores it
// ---------------------------------------------------------------------------

describe('4. A block between A and B', () => {
  for (const direction of ['A blocks B', 'B blocks A']) {
    it(`${direction}: 0 rows for A, then visible again after unblock`, async () => {
      const a = await user('a4');
      const b = await user('b4');
      const film = await movie(`Cross Account Four ${direction}`);
      await rank(b, film);
      await saveNote(b, film, 'Blockable.', 'public');
      await seesExactly(a, film, [b], 'before the block');

      const [blocker, blocked] = direction === 'A blocks B' ? [a, b] : [b, a];
      await block(blocker, blocked);
      await seesExactly(a, film, [], 'A while blocked');
      assert.deepEqual(await view(a, film, 'following'), []);
      // The author still sees their own review, and the count agrees.
      await seesExactly(b, film, [b], 'B while blocked');

      await unblock(blocker, blocked);
      await seesExactly(a, film, [b], 'A after unblock');
    });
  }
});

// ---------------------------------------------------------------------------
// 5. A private profile: approved follow only; Following shows only followed authors
// ---------------------------------------------------------------------------

describe('5. B has a private profile', () => {
  it('is hidden without an approved follow, visible with one, and Following excludes an unfollowed C', async () => {
    const a = await user('a5');
    const b = await user('b5', 'private');
    const c = await user('c5');
    const film = await movie('Cross Account Five');
    await rank(b, film);
    await saveNote(b, film, 'Behind a private profile.', 'public');
    await rank(c, film);
    await saveNote(c, film, 'C is public and unfollowed.', 'public');

    // No follow at all.
    await seesExactly(a, film, [c], 'A with no follow');
    assert.deepEqual(await view(a, film, 'following'), []);

    // A pending request is not a follow.
    await follow(a, b, 'pending');
    await seesExactly(a, film, [c], 'A with a pending follow');
    assert.deepEqual(await view(a, film, 'following'), []);

    // Approved.
    await follow(a, b, 'approved');
    await seesExactly(a, film, [b, c], 'A with an approved follow');
    const following = await view(a, film, 'following');
    assert.deepEqual(following.map((r) => r.user_id), [b], 'Following showed an unfollowed author');
    assert.equal(following[0].note, 'Behind a private profile.');
    assert.equal(Number(following[0].score), await expectedScore(b, film));

    // B, reading their own title, sees both reviews (C is public).
    await seesExactly(b, film, [b, c], 'B sees own and C');
  });
});

// ---------------------------------------------------------------------------
// 6. A suspended author
// ---------------------------------------------------------------------------

describe('6. B is suspended', () => {
  it('is 0 rows for A', async () => {
    const a = await user('a6');
    const b = await user('b6');
    const film = await movie('Cross Account Six');
    await rank(b, film);
    await saveNote(b, film, 'Written before the suspension.', 'public');
    await follow(a, b);
    await seesExactly(a, film, [b], 'A before suspension');

    await t.sql(`update profiles set status = 'suspended' where id = $1`, [b]);
    await seesExactly(a, film, [], 'A after suspension');
    assert.deepEqual(await view(a, film, 'following'), []);

    // `can_view_profile` checks self before suspension, so B still sees their own
    // review — the same rule that lets a suspended user load their own profile.
    await seesExactly(b, film, [b], 'B, suspended, reading their own title');

    await t.sql(`update profiles set status = 'active' where id = $1`, [b]);
    await seesExactly(a, film, [b], 'A after reinstatement');
  });
});

// ---------------------------------------------------------------------------
// 7. A review on a title that is logged but not ranked
// ---------------------------------------------------------------------------

describe('7. B reviews a logged, unranked title', () => {
  it('is a row with score null', async () => {
    const a = await user('a7');
    const b = await user('b7');
    const film = await movie('Cross Account Seven');

    const logged = await logWatched(b, film);
    assert.equal(logged.status, 'ok');
    const { rows: ranked } = await t.sql(
      `select 1 from rankings where user_id = $1 and media_item_id = $2`,
      [b, film],
    );
    assert.equal(ranked.length, 0, 'log_watched created a ranking');

    await saveNote(b, film, 'Watched, not ranked.', 'public');
    await seesExactly(a, film, [b], 'A reads the unranked review');
    const [row] = await view(a, film);
    assert.equal(row.note, 'Watched, not ranked.');
    assert.equal(row.score, null);
    assert.equal(await expectedScore(b, film), null);
  });
});

// ---------------------------------------------------------------------------
// 8. Two titles with the same name are two titles
// ---------------------------------------------------------------------------

describe('8. Two media rows with the same title text', () => {
  it('never shows a review of one on the other', async () => {
    const a = await user('a8');
    const b = await user('b8');
    const c = await user('c8');
    const original = await movie('The Same Name');
    const remake = await movie('The Same Name');
    assert.notEqual(original, remake);
    const { rows: ids } = await t.sql(
      `select tmdb_id from media_items where id = any($1::uuid[])`,
      [[original, remake]],
    );
    assert.equal(new Set(ids.map((r) => r.tmdb_id)).size, 2, 'the fixtures share a TMDB id');

    await rank(b, original);
    await saveNote(b, original, 'About the original.', 'public');
    await seesExactly(a, original, [b], 'the original');
    await seesExactly(a, remake, [], 'the remake, before anybody reviews it');
    assert.equal(await countFor(a, remake), 0);

    // A review on the remake by someone else stays on the remake.
    await collect(c, remake);
    await saveNote(c, remake, 'About the remake.', 'public');
    await seesExactly(a, original, [b], 'the original after a remake review');
    await seesExactly(a, remake, [c], 'the remake after its own review');
    const [onRemake] = await view(a, remake);
    assert.equal(onRemake.note, 'About the remake.');
    assert.equal(onRemake.score, null, 'C has not ranked the remake');
    const [onOriginal] = await view(a, original);
    assert.equal(onOriginal.note, 'About the original.');
  });
});
