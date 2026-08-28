import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * `taste_match` — 20260817000400.
 *
 * The founder's fixture list, in order: identical evaluations → near 100 · inverted
 * opinions → low · mostly similar → high but imperfect · mixed → middle · fewer than
 * five shared → insufficient · deterministic as unrelated collection items grow.
 *
 * Those are the tests below, and they are written as *bands* rather than as exact
 * numbers on purpose. An assertion of `equal(score, 87)` would pin the formula rather
 * than its behaviour, and the first legitimate tuning of the weight ramp would break
 * six tests without any of them saying what went wrong. The bands say what the founder
 * asked for; the exact-value test at the end pins determinism separately.
 */

let t;
let alice;
let seq = 80000;

const movie = (title) => t.createMovie(title, seq++);

/**
 * Ranks a list of films for one user, best first.
 *
 * `rankToCompletion` answers each comparison, and answering "the new title wins"
 * against every pivot places it at the top — so inserting in reverse order of
 * preference leaves the list in the intended order.
 */
const rankAll = async (user, films, bucket = 'loved') => {
  await t.actAs(user);
  for (const film of films) {
    await t.rankToCompletion(film, bucket, async (pivot) => pivot);
  }
  await t.actAs(alice);
};

const match = async (subject, asUser) => {
  if (asUser) await t.actAs(asUser);
  const { rows } = await t.sql(`select * from taste_match($1)`, [subject]);
  if (asUser) await t.actAs(alice);
  return rows[0];
};

/** n films, ranked by both accounts. `plan` decides each side's bucket per film. */
const pair = async (name, count, plan) => {
  const other = await t.createUser({ username: `tm_${name}` });
  const films = [];
  for (let i = 0; i < count; i += 1) films.push(await movie(`${name}_${i}`));

  for (let i = 0; i < count; i += 1) {
    const { mine, theirs } = plan(i, count);
    await t.actAs(alice);
    await t.rankToCompletion(films[i], mine, async (pivot) => pivot);
    await t.actAs(other);
    await t.rankToCompletion(films[i], theirs, async (pivot) => pivot);
  }
  await t.actAs(alice);
  return other;
};

before(async () => {
  t = await createTestDb();
  alice = await t.createUser({ username: 'alice_taste' });
  await t.actAs(alice);
});

after(async () => t?.close());

// ---------------------------------------------------------------------------

describe('the founder’s fixtures', () => {
  it('scores identical evaluations high — and no longer near 100 at eight titles', async () => {
    // Same bucket, same order, so both sides derive the same score for every film.
    //
    // Before 20260827001000 this asserted >= 90, and that assertion *was* the
    // defect the founder's Match audit named: eight shared titles cannot prove two
    // people near-identical, and the formula now says so — the blend is shrunk
    // toward the 50 stranger baseline by n/(n+5), so identical evaluations over
    // eight films land near 80. Near-100 is still reachable; it just has to be
    // earned with evidence (see 'confidence grows with evidence' below).
    const other = await pair('identical', 8, () => ({ mine: 'loved', theirs: 'loved' }));

    const row = await match(other);
    assert.equal(row.common_count, 8);
    assert.ok(row.score >= 75, `expected high, got ${row.score}`);
    assert.ok(row.score <= 85, `expected the shrink to hold at n=8, got ${row.score}`);
  });

  it('scores inverted opinions low', async () => {
    // One loves what the other rejects, film for film. This is the case the metric
    // exists to distinguish, and it must not land in the middle.
    const other = await pair('inverted', 8, () => ({ mine: 'loved', theirs: 'not_for_me' }));

    const row = await match(other);
    assert.equal(row.common_count, 8);
    assert.ok(row.score <= 35, `expected low, got ${row.score}`);
  });

  it('scores mostly-similar high but not perfect', async () => {
    // Agreement on six of eight, and a bucket apart on the other two.
    const other = await pair('mostly', 8, (i) => ({
      mine: 'loved',
      theirs: i < 6 ? 'loved' : 'fine',
    }));

    const row = await match(other);
    assert.ok(row.score >= 60, `expected high, got ${row.score}`);
    assert.ok(row.score < 100, `expected imperfect, got ${row.score}`);
  });

  it('scores a mixed pair in the middle', async () => {
    // Half agreed, half opposite.
    const other = await pair('mixed', 8, (i) => ({
      mine: 'loved',
      theirs: i % 2 === 0 ? 'loved' : 'not_for_me',
    }));

    const row = await match(other);
    assert.ok(row.score > 35 && row.score < 80, `expected the middle, got ${row.score}`);
  });

  it('orders the four fixtures the way a reader would expect', async () => {
    // The individual bands above could all pass with a metric that ranked them
    // wrongly inside those bands. This asserts the ordering itself, which is the
    // property a reader actually relies on.
    const identical = await pair('ord_identical', 8, () => ({ mine: 'loved', theirs: 'loved' }));
    const mostly = await pair('ord_mostly', 8, (i) => ({
      mine: 'loved',
      theirs: i < 6 ? 'loved' : 'fine',
    }));
    const mixed = await pair('ord_mixed', 8, (i) => ({
      mine: 'loved',
      theirs: i % 2 === 0 ? 'loved' : 'not_for_me',
    }));
    const inverted = await pair('ord_inverted', 8, () => ({
      mine: 'loved',
      theirs: 'not_for_me',
    }));

    const scores = [];
    for (const other of [identical, mostly, mixed, inverted]) {
      scores.push((await match(other)).score);
    }

    for (let i = 1; i < scores.length; i += 1) {
      assert.ok(
        scores[i] < scores[i - 1],
        `expected strictly decreasing, got ${JSON.stringify(scores)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------

describe('the minimum overlap', () => {
  it('has no number below five shared titles', async () => {
    // Not a low score — an absence. Two people who both saw four films and agreed on
    // all four are not a 100% match, and saying so would be the feature's first lie.
    const other = await pair('sparse', 4, () => ({ mine: 'loved', theirs: 'loved' }));

    const row = await match(other);
    assert.equal(row.common_count, 4);
    assert.equal(row.score, null);
    assert.equal(row.min_common, 5);
  });

  it('produces a number at exactly five', async () => {
    const other = await pair('exactly_five', 5, () => ({ mine: 'loved', theirs: 'loved' }));

    const row = await match(other);
    assert.equal(row.common_count, 5);
    assert.ok(row.score !== null);
  });

  it('counts only the exact items both ranked', async () => {
    // Titles only one of them has ranked are not overlap, however many there are.
    const other = await pair('padded', 6, () => ({ mine: 'loved', theirs: 'loved' }));

    const mineAlone = [];
    for (let i = 0; i < 5; i += 1) mineAlone.push(await movie(`padded_mine_${i}`));
    await rankAll(alice, mineAlone);

    const theirsAlone = [];
    for (let i = 0; i < 5; i += 1) theirsAlone.push(await movie(`padded_theirs_${i}`));
    await rankAll(other, theirsAlone);

    assert.equal((await match(other)).common_count, 6);
  });

  it('never compares a season with its series', async () => {
    // True by construction rather than by a rule: a series is not rankable at all
    // (AD-1), so it cannot enter the common set. Asserted anyway, because "by
    // construction" is a claim about code somebody may change.
    const series = await t.createSeries('tm_series', seq++);
    const s1 = await t.createSeason(series, 1, 'Season 1');
    const s2 = await t.createSeason(series, 2, 'Season 2');
    const other = await t.createUser({ username: 'tm_seasons' });

    await t.actAs(alice);
    await t.rankToCompletion(s1, 'loved', async (pivot) => pivot);
    await t.actAs(other);
    await t.rankToCompletion(s2, 'loved', async (pivot) => pivot);
    await t.actAs(alice);

    // One ranked Season 1 and the other Season 2. That is no overlap at all.
    assert.equal((await match(other)).common_count, 0);
  });
});

// ---------------------------------------------------------------------------

describe('evidence and confidence (20260827001000)', () => {
  // The founder's Match audit: five shared titles were enough to print 90%, with
  // nothing anywhere saying how thin that evidence was. The blend is now shrunk
  // toward the 50 stranger baseline by n/(n + taste.shrink_prior), so a confident
  // number has to be earned with evidence rather than granted at the threshold.

  it('does not grant a near-certain match at the minimum evidence', async () => {
    // Identical evaluations over exactly five titles — the case that used to read
    // 90+. Shrunk by 5/(5+5), it now reads ~75: promising, and visibly not proof.
    const other = await pair('shrunk_five', 5, () => ({ mine: 'loved', theirs: 'loved' }));

    const row = await match(other);
    assert.equal(row.common_count, 5);
    assert.ok(row.score !== null);
    assert.ok(row.score <= 80, `expected the shrink at n=5, got ${row.score}`);
    assert.ok(row.score >= 65, `expected promising rather than dismissed, got ${row.score}`);
  });

  it('lets more evidence raise the same agreement higher', async () => {
    // The same perfect agreement, five titles versus eighteen. Confidence is
    // n/(n+5), monotonic in n, so the larger sample must score strictly higher —
    // which is the property the founder asked for in one sentence: more shared
    // evidence, more trust in the number.
    const thin = await pair('conf_thin', 5, () => ({ mine: 'loved', theirs: 'loved' }));
    const thick = await pair('conf_thick', 18, () => ({ mine: 'loved', theirs: 'loved' }));

    const thinScore = (await match(thin)).score;
    const thickScore = (await match(thick)).score;
    assert.ok(
      thickScore > thinScore,
      `expected ${thickScore} (n=18) > ${thinScore} (n=5)`,
    );
    // A loose floor, deliberately: alice's shared catalogue keeps growing across
    // this file, so the shared films sit ever deeper in her band and proximity
    // carries some fixture noise. The strict inequality above is the contract;
    // this only guards against the pair somehow reading as strangers.
    assert.ok(thickScore >= 70, `expected a well-evidenced pair to read high, got ${thickScore}`);
  });

  it('shrinks disagreement symmetrically', async () => {
    // Five titles of opposition is thin evidence too. An inverted pair at the
    // threshold reads nearer the middle than the floor — the formula is saying "I
    // cannot tell you much yet" in both directions, not softening only the good news.
    const other = await pair('shrunk_inverted', 5, () => ({
      mine: 'loved',
      theirs: 'not_for_me',
    }));

    const row = await match(other);
    assert.ok(row.score !== null);
    assert.ok(row.score >= 20 && row.score <= 40, `expected shrunk disagreement, got ${row.score}`);
  });
});

// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('gives the same answer twice', async () => {
    const other = await pair('stable', 8, (i) => ({
      mine: 'loved',
      theirs: i < 6 ? 'loved' : 'fine',
    }));

    const first = await match(other);
    const second = await match(other);
    assert.equal(first.score, second.score);
  });

  it('does not drift as unrelated titles are added to either collection', async () => {
    // The founder's last fixture. A score is a position within its owner's band, so
    // adding titles *does* legitimately move the scores of the shared ones — what must
    // not happen is the number wandering because of titles neither of them shares.
    //
    // Both accounts here grow by the same relative amount and in the same direction,
    // and the shared films keep their relative positions, so the match must hold.
    const other = await pair('growth', 10, () => ({ mine: 'loved', theirs: 'loved' }));
    const before = (await match(other)).score;

    const extra = [];
    for (let i = 0; i < 6; i += 1) extra.push(await movie(`growth_extra_${i}`));
    // Ranked into a different band by both, so the shared films' band is untouched.
    await rankAll(alice, extra.slice(0, 3), 'not_for_me');
    await rankAll(other, extra.slice(3), 'not_for_me');

    const after = (await match(other)).score;
    assert.equal(after, before, 'unrelated titles in another band moved the score');
  });

  it('is symmetric: A’s match with B is B’s match with A', async () => {
    // Not required by the brief, and a property worth having anyway: a number that
    // disagreed depending on who was looking would be indefensible to two people
    // comparing screens.
    const other = await pair('symmetric', 9, (i) => ({
      mine: 'loved',
      theirs: i < 7 ? 'loved' : 'fine',
    }));

    const forward = await match(other);
    const back = await match(alice, other);

    assert.equal(forward.score, back.score);
    assert.equal(forward.common_count, back.common_count);
  });
});

// ---------------------------------------------------------------------------

describe('who may be compared with', () => {
  it('refuses yourself', async () => {
    const row = await match(alice);
    assert.equal(row.score, null);
    assert.equal(row.common_count, 0);
  });

  it('refuses a private account the caller does not follow', async () => {
    const shy = await t.createUser({ username: 'tm_private', visibility: 'private' });
    const films = [];
    for (let i = 0; i < 6; i += 1) films.push(await movie(`tm_private_${i}`));
    await rankAll(alice, films);
    await rankAll(shy, films);

    // The same shape as no overlap: no score, no count. A caller who cannot see the
    // profile must not be able to tell "not allowed" from "nothing in common".
    const row = await match(shy);
    assert.equal(row.score, null);
    assert.equal(row.common_count, 0);
  });

  it('allows a private account the caller follows', async () => {
    const shy = await t.createUser({ username: 'tm_private_ok', visibility: 'private' });
    await t.sql(
      `insert into follows (follower_id, followee_id, state, approved_at)
       values ($1, $2, 'approved', now())`,
      [alice, shy],
    );
    const films = [];
    for (let i = 0; i < 6; i += 1) films.push(await movie(`tm_private_ok_${i}`));
    await rankAll(alice, films);
    await rankAll(shy, films);

    const row = await match(shy);
    assert.equal(row.common_count, 6);
    assert.ok(row.score !== null);
  });

  it('refuses an account that has blocked the caller', async () => {
    const hostile = await t.createUser({ username: 'tm_blocked' });
    const films = [];
    for (let i = 0; i < 6; i += 1) films.push(await movie(`tm_blocked_${i}`));
    await rankAll(alice, films);
    await rankAll(hostile, films);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [hostile, alice]);

    assert.equal((await match(hostile)).common_count, 0);
  });

  it('refuses a suspended account', async () => {
    const gone = await t.createUser({ username: 'tm_suspended' });
    const films = [];
    for (let i = 0; i < 6; i += 1) films.push(await movie(`tm_suspended_${i}`));
    await rankAll(alice, films);
    await rankAll(gone, films);
    assert.equal((await match(gone)).common_count, 6);

    await t.sql(`update profiles set status = 'suspended' where id = $1`, [gone]);

    assert.equal((await match(gone)).common_count, 0);
  });

  it('tells an anonymous caller nothing', async () => {
    const error = await t.asAnon(() =>
      t.errorFrom(`select * from taste_match($1)`, [alice]),
    );
    await t.actAs(alice);
    assert.equal(error?.code, '42501');
  });
});

describe('what comes back', () => {
  it('returns a score, a count and the threshold — and never the titles', async () => {
    // The founder's rule: the aggregate must not expose the other account's ranking
    // catalogue. Three scalars is the whole surface.
    const other = await pair('projection', 6, () => ({ mine: 'loved', theirs: 'loved' }));
    const { rows } = await t.sql(`select * from taste_match($1)`, [other]);

    assert.deepEqual(Object.keys(rows[0]).sort(), ['common_count', 'min_common', 'score']);
  });

  it('always returns exactly one row', async () => {
    // Both CTEs it selects from are scalar aggregates, so this is one row by
    // construction — including for a caller with no rankings at all, where every
    // branch could plausibly have produced none.
    const stranger = await t.createUser({ username: 'tm_empty' });
    const { rows } = await t.sql(`select * from taste_match($1)`, [stranger]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].common_count, 0);
  });
});
