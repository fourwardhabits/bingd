import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * `following_ratings` — 20260827000800.
 *
 * Founder tranche 2026-08-27 §13: tapping the Following aggregate on a title page
 * opens the list it averages — who I follow that rated this, what they gave it, and
 * how much their taste matches mine.
 *
 * The function's whole argument for existing safely is that it restates
 * `following_score`'s population predicate verbatim, which is `rankings_read`'s: every
 * row it names is a row the caller could already select one at a time. So the tests
 * here are population tests first — who is in, who is out — and then the two things
 * the list adds on top of the aggregate:
 *
 *   1. **Match, by the one algorithm.** `taste_match` is invoked per row rather than
 *      reimplemented, so its refusals and its below-threshold null arrive intact. The
 *      client renders that null as "Match TBD" — a number invented below five shared
 *      titles would be the feature's first lie, exactly as taste-match.test.mjs says.
 *   2. **An order that never reshuffles**: trustworthy match first, then their
 *      rating, then a stable name.
 *
 * Derived scores are asserted as bands or by construction (a lone title in a band is
 * deterministically at its top), never as brittle formula constants.
 */

let t;
let alice;
let seq = 96000;

const movie = (title) => t.createMovie(title, seq++);

const follow = async (follower, followee, state = 'approved') => {
  await t.sql(
    `insert into follows (follower_id, followee_id, state, approved_at)
     values ($1, $2, $3::follow_state, case when $3 = 'approved' then now() end)
     on conflict (follower_id, followee_id) do update
       set state = excluded.state, approved_at = excluded.approved_at`,
    [follower, followee, state],
  );
};

/** A fresh account that has ranked `mediaItemId` into `bucket`. */
let raterSeq = 0;
const rater = async (mediaItemId, bucket = 'loved', options = {}) => {
  raterSeq += 1;
  const user = await t.createUser({
    username: options.username ?? `fr_rater_${raterSeq}`,
    visibility: options.visibility ?? 'public',
  });
  if (mediaItemId) {
    await t.actAs(user);
    await t.rankToCompletion(mediaItemId, bucket, async (pivot) => pivot);
  }
  await t.actAs(alice);
  return user;
};

/** The list as alice sees it, unless another viewer is named. */
const listFor = async (mediaItemId, asUser) => {
  if (asUser) await t.actAs(asUser);
  const { rows } = await t.sql(`select * from following_ratings($1)`, [mediaItemId]);
  if (asUser) await t.actAs(alice);
  return rows;
};

before(async () => {
  t = await createTestDb();
  alice = await t.createUser({ username: 'alice_fr' });
  await t.actAs(alice);
});

after(async () => t?.close());

// ---------------------------------------------------------------------------

describe('who is on the list', () => {
  it('returns exactly the approved, viewable followees who ranked this title', async () => {
    const film = await movie('fr_population');

    // In: two public followees and a private one alice is approved to see.
    const loved = await rater(film, 'loved');
    const fine = await rater(film, 'fine');
    const shy = await rater(film, 'loved', { visibility: 'private' });
    await follow(alice, loved);
    await follow(alice, fine);
    await follow(alice, shy);

    // Out, one per exclusion the predicate makes:
    await rater(film); // ranked it, but alice does not follow them
    const unranked = await rater(null); // followed, but never ranked this title
    await follow(alice, unranked);
    const blocker = await rater(film);
    await follow(alice, blocker);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [blocker, alice]);
    const gone = await rater(film);
    await follow(alice, gone);
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [gone]);

    const rows = await listFor(film);
    assert.deepEqual(
      rows.map((r) => r.user_id).sort(),
      [loved, fine, shy].sort(),
      'the stranger, the non-rater, the blocker and the suspended account are all absent',
    );

    // Each row names its person and carries a real score. The private followee is
    // present *because* approval is the predicate — visibility alone excludes nobody
    // the caller was let in to see.
    for (const row of rows) {
      assert.ok(row.username, 'a person, not an id');
      assert.ok(row.display_name);
      assert.ok('avatar_path' in row);
      const score = Number(row.score);
      assert.ok(score >= 0 && score <= 10, `a derived score in [0,10], got ${row.score}`);
    }
  });

  it('agrees with following_score about how many people that is', async () => {
    // The list exists to explain the aggregate, so the one unforgivable failure is
    // the two disagreeing: a number averaging three people above a list naming two.
    // Same fixture, both functions, one assertion.
    const film = await movie('fr_parity');
    for (const bucket of ['loved', 'fine', 'not_for_me']) {
      const user = await rater(film, bucket);
      await follow(alice, user);
    }
    await rater(film); // a stranger, counted by neither

    const rows = await listFor(film);
    const { rows: agg } = await t.sql(`select rating_count from following_score($1)`, [film]);
    assert.equal(rows.length, agg[0].rating_count, 'the list and the aggregate count the same people');
    assert.equal(rows.length, 3);
  });
});

// ---------------------------------------------------------------------------

describe('the match column', () => {
  it('is null below five shared titles, because Match TBD is the honest answer', async () => {
    const film = await movie('fr_tbd');
    const bob = await rater(film, 'loved');
    await follow(alice, bob);

    const rows = await listFor(film);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].match_score, null, 'no number is invented below the threshold');
    assert.ok(rows[0].common_count < 5, 'CONTROL: the overlap really is thin');
  });

  it('is a number at five or more shared titles, with the count beside it', async () => {
    // The taste-match `pair` idiom: the target plus five more films, ranked by both
    // sides, so the overlap crosses taste.min_common with the target included.
    const film = await movie('fr_matched');
    const bob = await t.createUser({ username: 'fr_matched_bob' });
    const shared = [film];
    for (let i = 0; i < 5; i += 1) shared.push(await movie(`fr_matched_${i}`));

    for (const title of shared) {
      await t.actAs(alice);
      await t.rankToCompletion(title, 'loved', async (pivot) => pivot);
      await t.actAs(bob);
      await t.rankToCompletion(title, 'loved', async (pivot) => pivot);
    }
    await t.actAs(alice);
    await follow(alice, bob);

    const rows = await listFor(film);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].common_count, 6, 'the exact shared catalogue, target included');
    const match = Number(rows[0].match_score);
    assert.ok(Number.isFinite(match), 'above the threshold the algorithm speaks');
    // A band, not a constant: identical evaluations over six titles read high but
    // shrunk toward the stranger baseline by n/(n+5) — see 20260827001000.
    assert.ok(match >= 60 && match <= 90, `expected shrunk-high agreement, got ${match}`);
  });
});

// ---------------------------------------------------------------------------

describe('the order', () => {
  it('puts a trustworthy match first, then rating, then username', async () => {
    // Four rows, one per sort key, so the assertion pins the whole clause:
    //   matched  — the only non-null match_score, sorts first however they rated it
    //   amy/ben  — both scored 10.0 (a lone loved title tops its band), match null,
    //              so only the username separates them
    //   colder   — 'fine' lands below 10, so rating desc places them last
    const film = await movie('fr_order');

    const matched = await t.createUser({ username: 'fr_ord_match' });
    const shared = [film];
    for (let i = 0; i < 5; i += 1) shared.push(await movie(`fr_order_${i}`));
    for (const title of shared) {
      await t.actAs(alice);
      await t.rankToCompletion(title, 'loved', async (pivot) => pivot);
      await t.actAs(matched);
      await t.rankToCompletion(title, 'loved', async (pivot) => pivot);
    }
    await t.actAs(alice);
    await follow(alice, matched);

    const amy = await rater(film, 'loved', { username: 'fr_ord_amy' });
    const ben = await rater(film, 'loved', { username: 'fr_ord_ben' });
    const colder = await rater(film, 'fine', { username: 'fr_ord_colder' });
    for (const user of [amy, ben, colder]) await follow(alice, user);

    const rows = await listFor(film);
    assert.deepEqual(
      rows.map((r) => r.username),
      ['fr_ord_match', 'fr_ord_amy', 'fr_ord_ben', 'fr_ord_colder'],
      'match desc nulls last, then score desc, then username — and never a reshuffle',
    );
    assert.notEqual(rows[0].match_score, null);
    assert.equal(rows[1].match_score, null, 'amy sorts on rating, not on a match she lacks');
  });
});

// ---------------------------------------------------------------------------

describe('what comes back, and to whom', () => {
  it('returns the seven declared columns and nothing else', async () => {
    // The projection is the privacy boundary: a row must never grow, say, the
    // followee's whole catalogue or their bucket sizes. Asserting the exact column
    // list is what fails if someone widens the return table casually.
    const film = await movie('fr_projection');
    const bob = await rater(film, 'loved');
    await follow(alice, bob);

    const rows = await listFor(film);
    assert.deepEqual(
      Object.keys(rows[0]).sort(),
      ['avatar_path', 'common_count', 'display_name', 'match_score', 'score', 'user_id', 'username'],
    );
  });

  it('is not reachable by an unauthenticated caller at all', async () => {
    // auth.uid() is the whole population filter, so anon could only ever receive the
    // empty list — and a function useless by construction should be unreachable, so
    // the grants stay a list of things that are there for a reason.
    const film = await movie('fr_anon');
    const error = await t.asAnon(() =>
      t.errorFrom(`select * from following_ratings($1)`, [film]),
    );
    await t.actAs(alice);
    assert.equal(error?.code, '42501', 'anon must not hold EXECUTE on following_ratings');
  });
});
