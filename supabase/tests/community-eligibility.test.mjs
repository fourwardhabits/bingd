import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { PGlite } from '@electric-sql/pglite';

import { createTestDb } from './harness.mjs';
import {
  addFillerRankings,
  communityScore,
  qualifyForMovies,
  qualifyForTv,
} from './helpers/qualify.mjs';

/**
 * Community-score contributor eligibility, and a whole show counted once per person
 * (20261119000100, founder spec t168u §4).
 *
 *   - A user's rankings count toward bingd community scores for a category only once they
 *     have `score.contributor_min_rankings` (10) completed rankings in it. Movies and TV
 *     (seasons + whole shows combined) are independent.
 *   - A whole show's community score is the equal-weight mean of each eligible person's
 *     ONE effective score: their explicit show ranking, else the mean of their ranked
 *     seasons. A season's community score reads that season's rankings only.
 *   - `score.community_min_ratings` is a different row and keeps its meaning.
 *
 * Every ranking in this file goes through the real engine (`rank_start` / `rank_answer` /
 * `rank_again` / `unlog`); nothing is inserted into `rankings` directly. The `describe`
 * names carry the founder's §4K numbers so the checklist maps onto them one to one.
 *
 * Fillers (helpers/qualify.mjs) are ranked not_for_me with the incumbent winning, so they
 * sit at the bottom of the bottom band and never move a loved or fine subject's score.
 */

let t;
let viewer;
let seq = 6_100_000;
let users = 0;

const movie = (title = 'film') => t.createMovie(`${title} ${seq}`, seq++);
const series = (title = 'show') => t.createSeries(`${title} ${seq}`, seq++);
const season = (parent, n) => t.createSeason(parent, n, `Season ${n}`);
const user = (opts = {}) => t.createUser({ username: `elig_${(users += 1)}`, ...opts });
const op = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

/** Ranks as `who`, the incumbent winning every comparison: arrival order is rank order. */
const rankAs = async (who, item, bucket) => {
  await t.actAs(who);
  return t.rankToCompletion(item, bucket, async (pivot) => pivot);
};

/** Reads a community score as the bystander viewer, who has ranked nothing and blocks nobody. */
const cs = async (item, as = viewer) => {
  await t.actAs(as);
  return communityScore(t, item);
};

/** The owner's own score, as the Collection and title page show it (public_scores). */
const ownScore = async (owner, item) => {
  await t.actAs(viewer);
  const { rows } = await t.sql(`select score from public_scores($1::uuid[], $2::uuid[])`, [
    [owner],
    [item],
  ]);
  return rows[0]?.score == null ? null : Number(rows[0].score);
};

const countRankings = async (who, categories) =>
  Number(
    (
      await t.sql(
        `select count(*)::int as n from rankings
          where user_id = $1 and category::text = any ($2::text[])`,
        [who, categories],
      )
    ).rows[0].n,
  );

const effective = async (who, show) => {
  const { rows } = await t.sql(`select * from _effective_show_score($1, $2)`, [who, show]);
  return rows.map((r) => ({
    score: r.score == null ? null : Number(r.score),
    raw: r.score == null ? null : String(r.score),
    source: r.source,
    season_count: r.season_count,
  }));
};

/**
 * Removes a ranked title from the Collection the way the client does
 * (src/features/collection/writes.ts): `rank_unrank`, then `unlog`.
 */
const unlogAs = async (who, item) => {
  await t.actAs(who);
  await t.sql(`select rank_unrank($1)`, [item]);
  const { rows } = await t.sql(`select unlog($1, $2) as r`, [await op(), item]);
  assert.notEqual(rows[0].r?.status, 'error', JSON.stringify(rows[0].r));
};

before(async () => {
  t = await createTestDb();
  viewer = await user();
});

after(async () => {
  await t?.close();
});

describe('the configuration', () => {
  it('adds score.contributor_min_rankings = 10 beside an untouched score.community_min_ratings = 1', async () => {
    const { rows } = await t.sql(
      `select key, value from app_config
        where key in ('score.contributor_min_rankings', 'score.community_min_ratings')
        order by key`,
    );
    assert.deepEqual(
      rows.map((r) => [r.key, r.value]),
      [
        ['score.community_min_ratings', 1],
        ['score.contributor_min_rankings', 10],
      ],
    );
  });
});

describe('§4K-1: 0, 1, 9, 10 and 11 ranked movies', () => {
  it('contributes only at 10 and 11, while the personal score shows from the first ranking', async () => {
    const rater = await user();
    const subject = await movie('subject');

    // 0 ranked movies.
    assert.deepEqual(await cs(subject), { score: null, rating_count: 0, min_ratings: 1 });

    // 1: the subject, loved and alone in its band, so 10.0 to its owner at once (§4D).
    await rankAs(rater, subject, 'loved');
    assert.equal(await countRankings(rater, ['movies']), 1);
    assert.equal(await ownScore(rater, subject), 10, 'the personal score is never suppressed');
    assert.deepEqual(await cs(subject), { score: null, rating_count: 0, min_ratings: 1 });

    // 9.
    await addFillerRankings(t, rater, 'movies', 8);
    assert.equal(await countRankings(rater, ['movies']), 9);
    assert.deepEqual(await cs(subject), { score: null, rating_count: 0, min_ratings: 1 });

    // 10.
    await addFillerRankings(t, rater, 'movies', 1);
    assert.equal(await countRankings(rater, ['movies']), 10);
    assert.deepEqual(await cs(subject), { score: 10, rating_count: 1, min_ratings: 1 });

    // 11.
    await addFillerRankings(t, rater, 'movies', 1);
    assert.equal(await countRankings(rater, ['movies']), 11);
    assert.deepEqual(await cs(subject), { score: 10, rating_count: 1, min_ratings: 1 });
    assert.equal(await ownScore(rater, subject), 10);
  });
});

describe('§4K-2: 0, 1, 9, 10 and 11 ranked TV entries', () => {
  it('contributes to a season only at 10 and 11', async () => {
    const rater = await user();
    const show = await series();
    const subject = await season(show, 1);

    assert.equal((await cs(subject)).rating_count, 0, '0 TV entries');

    await rankAs(rater, subject, 'fine');
    assert.equal(await ownScore(rater, subject), 6.9, 'own score at one ranking');
    assert.deepEqual(await cs(subject), { score: null, rating_count: 0, min_ratings: 1 }, '1');

    // Mixed fillers on purpose: shows and seasons both count toward the one TV number.
    await addFillerRankings(t, rater, 'shows', 4);
    await addFillerRankings(t, rater, 'seasons', 4);
    assert.equal(await countRankings(rater, ['tv_seasons', 'tv_shows']), 9);
    assert.deepEqual(await cs(subject), { score: null, rating_count: 0, min_ratings: 1 }, '9');

    await addFillerRankings(t, rater, 'seasons', 1);
    assert.deepEqual(await cs(subject), { score: 6.9, rating_count: 1, min_ratings: 1 }, '10');

    await addFillerRankings(t, rater, 'shows', 1);
    assert.deepEqual(await cs(subject), { score: 6.9, rating_count: 1, min_ratings: 1 }, '11');
  });
});

describe('§4K-3: mixed movie and TV rankings (the §4C table)', () => {
  it('applies each category independently, on a movie and on a season', async () => {
    // [movie rankings, TV rankings, movie contribution, TV contribution]
    const table = [
      [9, 0, false, false],
      [10, 0, true, false],
      [0, 10, false, true],
      [10, 10, true, true],
      [100, 2, true, false],
      [2, 100, false, true],
    ];
    for (const [movies, tv, movieYes, tvYes] of table) {
      const rater = await user();
      const film = await movie('table film');
      const show = await series('table show');
      const s1 = await season(show, 1);

      if (movies > 0) {
        await rankAs(rater, film, 'loved');
        await addFillerRankings(t, rater, 'movies', movies - 1);
      }
      if (tv > 0) {
        await rankAs(rater, s1, 'loved');
        await addFillerRankings(t, rater, 'seasons', tv - 1);
      }
      assert.equal(await countRankings(rater, ['movies']), movies);
      assert.equal(await countRankings(rater, ['tv_seasons', 'tv_shows']), tv);

      const label = `${movies} movies, ${tv} TV`;
      assert.deepEqual(
        await cs(film),
        movieYes
          ? { score: 10, rating_count: 1, min_ratings: 1 }
          : { score: null, rating_count: 0, min_ratings: 1 },
        `${label}: movie contribution ${movieYes ? 'Yes' : 'No'}`,
      );
      assert.deepEqual(
        await cs(s1),
        tvYes
          ? { score: 10, rating_count: 1, min_ratings: 1 }
          : { score: null, rating_count: 0, min_ratings: 1 },
        `${label}: TV contribution ${tvYes ? 'Yes' : 'No'}`,
      );
    }
  });
});

describe('§4K-4: TV qualification by seasons, whole shows and mixes', () => {
  /** A user whose TV rankings are `shows` whole shows and `seasons` seasons, one of them the subject. */
  const tvUser = async ({ shows, seasons, subject }) => {
    const rater = await user();
    await rankAs(rater, subject, 'loved');
    const left = { shows, seasons };
    const kind = (await t.sql(`select kind from media_items where id = $1`, [subject])).rows[0]
      .kind;
    if (kind === 'series') left.shows -= 1;
    else left.seasons -= 1;
    if (left.shows > 0) await addFillerRankings(t, rater, 'shows', left.shows);
    if (left.seasons > 0) await addFillerRankings(t, rater, 'seasons', left.seasons);
    assert.equal(await countRankings(rater, ['tv_shows']), shows);
    assert.equal(await countRankings(rater, ['tv_seasons']), seasons);
    return rater;
  };

  it('10 seasons: eligible', async () => {
    const s = await season(await series(), 1);
    await tvUser({ shows: 0, seasons: 10, subject: s });
    assert.equal((await cs(s)).rating_count, 1);
  });

  it('10 whole shows: eligible', async () => {
    const show = await series();
    await tvUser({ shows: 10, seasons: 0, subject: show });
    assert.deepEqual(await cs(show), { score: 10, rating_count: 1, min_ratings: 1 });
  });

  it('4 shows + 6 seasons: eligible, a show and three of its own seasons counting as four', async () => {
    const rater = await user();
    const show = await series();
    const own = [await season(show, 1), await season(show, 2), await season(show, 3)];
    await rankAs(rater, show, 'loved');
    for (const s of own) await rankAs(rater, s, 'loved');
    await addFillerRankings(t, rater, 'shows', 3);
    await addFillerRankings(t, rater, 'seasons', 3);
    assert.equal(await countRankings(rater, ['tv_shows']), 4);
    assert.equal(await countRankings(rater, ['tv_seasons']), 6);
    assert.equal((await cs(own[0])).rating_count, 1, 'the season counts');
    assert.equal((await cs(show)).rating_count, 1, 'and the show, once');
  });

  it('8 seasons + 1 show: ineligible', async () => {
    const s = await season(await series(), 1);
    await tvUser({ shows: 1, seasons: 8, subject: s });
    assert.deepEqual(await cs(s), { score: null, rating_count: 0, min_ratings: 1 });
  });

  it('12 movies but 3 TV entries: eligible for movies, not for TV', async () => {
    const rater = await user();
    const film = await movie();
    const s = await season(await series(), 1);
    await rankAs(rater, film, 'loved');
    await addFillerRankings(t, rater, 'movies', 11);
    await rankAs(rater, s, 'loved');
    await addFillerRankings(t, rater, 'seasons', 2);
    assert.equal((await cs(film)).rating_count, 1);
    assert.equal((await cs(s)).rating_count, 0);
  });
});

describe('§4K-5: multiple watches of one title do not inflate the count', () => {
  it('Log another watch, a rewatch re-rank and an unranked log leave nine rankings at nine', async () => {
    const rater = await user();
    const subject = await movie('rewatched');
    await rankAs(rater, subject, 'loved');
    await addFillerRankings(t, rater, 'movies', 8);
    await t.actAs(rater);

    // Log another watch, three times: the T3 path, then the legacy rank_again path.
    for (let i = 0; i < 3; i += 1) {
      const { rows } = await t.sql(
        `select log_rewatch($1, $2, current_date, 'today_default') as r`,
        [await op(), subject],
      );
      assert.notEqual(rows[0].r?.status, 'error', JSON.stringify(rows[0].r));
    }
    let step = (
      await t.sql(`select rank_again($1, 'loved'::taste_bucket, $2, true) as r`, [
        subject,
        await op(),
      ])
    ).rows[0].r;
    while (!step.done) {
      step = (
        await t.sql(`select rank_answer($1, $2, $3) as r`, [
          step.session_id,
          step.pivot,
          await op(),
        ])
      ).rows[0].r;
    }
    const watches = Number(
      (
        await t.sql(
          `select count(*)::int as n from watch_events where user_id = $1 and media_item_id = $2`,
          [rater, subject],
        )
      ).rows[0].n,
    );
    assert.ok(watches >= 4, `expected the rewatches recorded, got ${watches}`);

    // §4A's other exclusions: a watchlist entry, an unranked log and an unfinished session.
    const listed = await movie('watchlisted');
    await t.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [
      rater,
      listed,
    ]);
    const logged = await movie('logged only');
    const { rows: lw } = await t.sql(`select log_watched($1, $2, current_date) as r`, [
      await op(),
      logged,
    ]);
    assert.notEqual(lw[0].r?.status, 'error', JSON.stringify(lw[0].r));
    const unfinished = await movie('half ranked');
    const started = (
      await t.sql(`select rank_start($1, 'not_for_me'::taste_bucket) as r`, [unfinished])
    ).rows[0].r;
    assert.equal(started.done, false, 'the session is left open mid-comparison');

    assert.equal(await countRankings(rater, ['movies']), 9);
    assert.deepEqual(await cs(subject), { score: null, rating_count: 0, min_ratings: 1 });
  });
});

describe('§4K-6: deleting a ranking drops eligibility below ten', () => {
  it('removes the user from every title in that category, and only that category', async () => {
    const rater = await user();
    const a = await movie('a');
    const b = await movie('b');
    const s = await season(await series(), 1);
    await rankAs(rater, a, 'loved');
    await rankAs(rater, b, 'fine');
    const fillers = await addFillerRankings(t, rater, 'movies', 8);
    await rankAs(rater, s, 'loved');
    await qualifyForTv(t, rater);

    assert.equal((await cs(a)).rating_count, 1);
    assert.equal((await cs(b)).rating_count, 1);
    assert.equal((await cs(s)).rating_count, 1);

    await unlogAs(rater, fillers[0]);
    assert.equal(await countRankings(rater, ['movies']), 9);
    assert.deepEqual(await cs(a), { score: null, rating_count: 0, min_ratings: 1 });
    assert.deepEqual(await cs(b), { score: null, rating_count: 0, min_ratings: 1 });
    assert.equal((await cs(s)).rating_count, 1, 'TV eligibility is independent');
    assert.equal(await ownScore(rater, a), 10, 'and the owner still sees their own score');
  });
});

describe('§4K-7: reaching ten retroactively qualifies earlier rankings', () => {
  it('adds every ranking made before the threshold, at its current score', async () => {
    const rater = await user();
    const first = await movie('first');
    const second = await movie('second');
    await rankAs(rater, first, 'loved');
    await rankAs(rater, second, 'loved');
    await addFillerRankings(t, rater, 'movies', 7);
    assert.equal((await cs(first)).rating_count, 0);
    assert.equal((await cs(second)).rating_count, 0);

    await addFillerRankings(t, rater, 'movies', 1);
    assert.deepEqual(await cs(first), {
      score: await ownScore(rater, first),
      rating_count: 1,
      min_ratings: 1,
    });
    assert.deepEqual(await cs(second), { score: 7, rating_count: 1, min_ratings: 1 });
  });
});

/** A TV-eligible user who ranked `show` explicitly (optional) and some of its seasons. */
const showRater = async (show, { explicit = null, seasons = [] } = {}) => {
  const rater = await user();
  if (explicit) await rankAs(rater, show, explicit);
  for (const [s, bucket] of seasons) await rankAs(rater, s, bucket);
  await qualifyForTv(t, rater);
  return rater;
};

describe('§4K-8: an explicit show score overrides the season average', () => {
  it('uses the show ranking, not the seasons', async () => {
    const show = await series();
    const s1 = await season(show, 1);
    const s2 = await season(show, 2);
    // Explicit fine show alone in its band: 6.9. Seasons loved: 10.0 and 7.0.
    const rater = await showRater(show, {
      explicit: 'fine',
      seasons: [
        [s1, 'loved'],
        [s2, 'loved'],
      ],
    });
    assert.deepEqual(await effective(rater, show), [
      { score: 6.9, raw: '6.9', source: 'explicit', season_count: 2 },
    ]);
    assert.deepEqual(await cs(show), { score: 6.9, rating_count: 1, min_ratings: 1 });
  });
});

describe('§4K-9: the season average when there is no explicit show score', () => {
  it('averages the user’s ranked seasons of the show', async () => {
    const show = await series();
    const s1 = await season(show, 1);
    const s2 = await season(show, 2);
    await season(show, 3); // unranked: never counted as zero
    const rater = await showRater(show, {
      seasons: [
        [s1, 'loved'],
        [s2, 'loved'],
      ],
    });
    const [row] = await effective(rater, show);
    assert.equal(row.source, 'average');
    assert.equal(row.score, 8.5);
    assert.equal(row.season_count, 2);
    assert.deepEqual(await cs(show), { score: 8.5, rating_count: 1, min_ratings: 1 });
  });
});

describe('§4K-10: a show plus several seasons from one user is one contribution', () => {
  it('reproduces the contract’s community vector, and counts a newly eligible user once', async () => {
    const show = await series('vector');
    const [s1, s2, s3] = [await season(show, 1), await season(show, 2), await season(show, 3)];

    // A: explicit 6.9 (fine, alone) plus two ranked seasons. The contract's table gives A's
    // seasons as 10.0 and 10.0; two seasons in one pool cannot both be rank 1 of loved, so
    // they are 10.0 and 7.0 here. They are not read either way: A contributes 6.9 once.
    const a = await showRater(show, {
      explicit: 'fine',
      seasons: [
        [s1, 'loved'],
        [s2, 'loved'],
      ],
    });
    // B: no show ranking, seasons 10.0 and 7.0 -> 8.5.
    const b = await showRater(show, {
      seasons: [
        [s1, 'loved'],
        [s3, 'loved'],
      ],
    });
    // C: an explicit loved show (10.0) but only nine TV rankings -> excluded.
    const c = await user();
    await rankAs(c, show, 'loved');
    await addFillerRankings(t, c, 'seasons', 8);
    assert.equal(await countRankings(c, ['tv_seasons', 'tv_shows']), 9);

    assert.deepEqual((await effective(a, show))[0].score, 6.9);
    assert.deepEqual((await effective(b, show))[0].score, 8.5);
    assert.deepEqual(await cs(show), { score: 7.7, rating_count: 2, min_ratings: 1 });

    // C's tenth TV ranking: (6.9 + 8.5 + 10.0) / 3 = 8.4666… -> 8.5, three people.
    await addFillerRankings(t, c, 'seasons', 1);
    assert.deepEqual(await cs(show), { score: 8.5, rating_count: 3, min_ratings: 1 });
  });
});

describe('§4K-11: a season’s community score is its own', () => {
  it('reads only that season’s rankings by TV-eligible users, never a show ranking', async () => {
    const show = await series();
    const s1 = await season(show, 1);
    const s2 = await season(show, 2);

    await showRater(show, { explicit: 'loved' }); // show only
    assert.deepEqual(await cs(s1), { score: null, rating_count: 0, min_ratings: 1 });

    await showRater(show, { seasons: [[s1, 'fine']] }); // eligible, ranks S1: 6.9
    const ineligible = await user();
    await rankAs(ineligible, s1, 'loved');
    await addFillerRankings(t, ineligible, 'seasons', 4);

    assert.deepEqual(await cs(s1), { score: 6.9, rating_count: 1, min_ratings: 1 });
    assert.deepEqual(await cs(s2), { score: null, rating_count: 0, min_ratings: 1 });
    // And the show itself: the explicit 10.0 and the fine-season 6.9, one each.
    assert.deepEqual(await cs(show), { score: 8.5, rating_count: 2, min_ratings: 1 });
  });
});

describe('§4K-12: visibility, status, blocks and RLS still apply to eligible raters', () => {
  it('excludes private, suspended and blocked (either direction, per viewer) raters', async () => {
    const film = await movie('guarded');
    const show = await series('guarded show');
    const s1 = await season(show, 1);
    const make = async (opts) => {
      const who = await user(opts);
      await rankAs(who, film, 'loved');
      await rankAs(who, s1, 'loved');
      await qualifyForMovies(t, who);
      await qualifyForTv(t, who);
      return who;
    };
    const open = await make();
    const hidden = await make({ visibility: 'private' });
    const suspended = await make();
    const blocker = await make();
    const blockee = await make();
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [suspended]);

    const reader = await user();
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [
      blocker,
      reader,
    ]);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [
      reader,
      blockee,
    ]);

    // The bystander sees open, blocker and blockee: hidden and suspended never count.
    for (const item of [film, s1, show]) {
      assert.equal((await cs(item)).rating_count, 3, `bystander on ${item}`);
      assert.equal((await cs(item, reader)).rating_count, 1, `the blocked reader on ${item}`);
    }
    void open;
    void hidden;

    // RLS and grants: a client reaches community_score and none of the helpers.
    await t.asUser(reader, async () => {
      const { rows } = await t.sql(`select * from community_score($1)`, [film]);
      assert.equal(rows[0].rating_count, 1);
      for (const call of [
        `select _contributor_min_rankings()`,
        `select * from _effective_show_scores('${show}', array['${open}']::uuid[])`,
        `select * from _effective_show_score('${open}', '${show}')`,
      ]) {
        const err = await t.errorFrom(call);
        assert.match(err?.message ?? '', /permission denied/i, call);
      }
    });
    await t.asAnon(async () => {
      const err = await t.errorFrom(`select * from community_score($1)`, [film]);
      assert.match(err?.message ?? '', /permission denied/i, 'anon is still refused');
    });
  });
});

describe('§4K-13: the per-title minimum stays distinct from the per-user threshold', () => {
  it('gates display per title on score.community_min_ratings, counting eligible contributors', async () => {
    const film = await movie('gated');
    const raters = [];
    const lastFiller = [];
    for (let i = 0; i < 3; i += 1) {
      const who = await user();
      await rankAs(who, film, 'loved');
      // The film plus nine: exactly ten, so one removal drops below the line.
      lastFiller.push((await qualifyForMovies(t, who, 9)).at(-1));
      raters.push(who);
    }
    // A fourth rater who is not eligible must not help the title over the bar.
    const thin = await user();
    await rankAs(thin, film, 'loved');

    await t.sql(
      `update app_config set value = '3'::jsonb where key = 'score.community_min_ratings'`,
    );
    try {
      await unlogAs(raters[2], lastFiller[2]);
      // Two eligible contributors, one ineligible: below 3, no number.
      assert.deepEqual(await cs(film), { score: null, rating_count: 2, min_ratings: 3 });
      await addFillerRankings(t, raters[2], 'movies', 1);
      assert.deepEqual(await cs(film), { score: 10, rating_count: 3, min_ratings: 3 });

      // And the contributor row is a different knob: moving it does not move min_ratings.
      await t.sql(
        `update app_config set value = '1'::jsonb where key = 'score.contributor_min_rankings'`,
      );
      assert.deepEqual(await cs(film), { score: 10, rating_count: 4, min_ratings: 3 });
    } finally {
      await t.sql(
        `update app_config set value = '1'::jsonb where key = 'score.community_min_ratings'`,
      );
      await t.sql(
        `update app_config set value = '10'::jsonb where key = 'score.contributor_min_rankings'`,
      );
    }
  });

  it('falls back to 10 when the contributor row is missing or not a number, and clamps', async () => {
    const read = async () => (await t.sql(`select _contributor_min_rankings() as k`)).rows[0].k;
    try {
      await t.sql(`delete from app_config where key = 'score.contributor_min_rankings'`);
      assert.equal(await read(), 10, 'missing');
      for (const [value, expected] of [
        [`'"3"'`, 10],
        [`'true'`, 10],
        [`'null'`, 10],
        [`'{}'`, 10],
        [`'0'`, 1],
        [`'-4'`, 1],
        [`'2.7'`, 2],
        [`'1e12'`, 1000000],
      ]) {
        await t.sql(
          `insert into app_config (key, value) values ('score.contributor_min_rankings', ${value}::jsonb)
           on conflict (key) do update set value = excluded.value`,
        );
        assert.equal(await read(), expected, `value ${value}`);
      }
    } finally {
      await t.sql(
        `insert into app_config (key, value) values ('score.contributor_min_rankings', '10'::jsonb)
         on conflict (key) do update set value = excluded.value`,
      );
    }
  });
});

describe('§4K-14: the next read after a crossing is the new value, on any session', () => {
  it('stores nothing to refresh: same connection, another identity, and a fresh database session', async () => {
    const rater = await user();
    const film = await movie('crossing');
    await rankAs(rater, film, 'loved');
    const fillers = await addFillerRankings(t, rater, 'movies', 8);

    /** A second database session over the same rows: a reload of the data directory. */
    const fromSecondSession = async () => {
      const dump = await t.db.dumpDataDir('none');
      const other = await PGlite.create({ loadDataDir: dump });
      try {
        const { rows } = await other.query(`select * from community_score($1)`, [film]);
        return rows[0].rating_count;
      } finally {
        await other.close();
      }
    };

    assert.equal((await cs(film)).rating_count, 0);

    // 9 -> 10
    await addFillerRankings(t, rater, 'movies', 1);
    assert.equal((await cs(film)).rating_count, 1, 'same connection');
    assert.equal(
      await t.asUser(
        viewer,
        async () =>
          (await t.sql(`select rating_count from community_score($1)`, [film])).rows[0]
            .rating_count,
      ),
      1,
      'as a signed-in client',
    );
    assert.equal(await fromSecondSession(), 1, 'a second session');

    // 10 -> 9
    await unlogAs(rater, fillers[0]);
    assert.equal((await cs(film)).rating_count, 0, 'same connection');
    assert.equal(await fromSecondSession(), 0, 'a second session');
  });

  it('adds no table, view or materialised state to keep in step', async () => {
    const { rows } = await t.sql(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'v', 'm')
          and (c.relname ilike '%eligib%' or c.relname ilike '%contributor%')`,
    );
    assert.deepEqual(rows, []);
    const { rows: fns } = await t.sql(
      `select p.proname, p.provolatile from pg_proc p
        where p.proname in ('community_score', '_effective_show_scores',
                            '_effective_show_score', '_contributor_min_rankings')
        order by p.proname`,
    );
    assert.deepEqual(
      fns.map((f) => [f.proname, f.provolatile]),
      [
        ['_contributor_min_rankings', 's'],
        ['_effective_show_score', 's'],
        ['_effective_show_scores', 's'],
        ['community_score', 's'],
      ],
    );
  });
});

describe('the WS-COMM / WS-TVC interface contract, server side', () => {
  /** Ranks `count` loved filler seasons for `who` (of one throwaway series). */
  const lovedFillers = async (who, count) => {
    const parent = await series('loved fillers');
    for (let i = 0; i < count; i += 1) await rankAs(who, await season(parent, i + 1), 'loved');
  };

  it('V1: an explicit 10.0 beats seasons 10.0 and 7.0', async () => {
    const show = await series('V1');
    const rater = await showRater(show, {
      explicit: 'loved',
      seasons: [
        [await season(show, 1), 'loved'],
        [await season(show, 2), 'loved'],
      ],
    });
    assert.deepEqual(await effective(rater, show), [
      { score: 10, raw: '10.0', source: 'explicit', season_count: 2 },
    ]);
    assert.equal((await cs(show)).score, 10);
  });

  it('V2: no show, seasons 10.0 and 7.0 -> average 8.5', async () => {
    const show = await series('V2');
    const rater = await showRater(show, {
      seasons: [
        [await season(show, 1), 'loved'],
        [await season(show, 2), 'loved'],
      ],
    });
    const [row] = await effective(rater, show);
    assert.equal(row.source, 'average');
    assert.equal(row.score, 8.5);
    assert.equal((await cs(show)).score, 8.5);
  });

  it('V3: seasons 8.6 and 8.7 -> 8.65 unrounded, displayed 8.7', async () => {
    const show = await series('V3');
    const rater = await user();
    // A loved season band of 31 puts ranks 14 and 15 at 8.7 and 8.6.
    await lovedFillers(rater, 13);
    const a = await season(show, 1);
    const b = await season(show, 2);
    await rankAs(rater, a, 'loved');
    await rankAs(rater, b, 'loved');
    await lovedFillers(rater, 16);
    assert.equal(await ownScore(rater, a), 8.7);
    assert.equal(await ownScore(rater, b), 8.6);
    const [row] = await effective(rater, show);
    assert.equal(row.source, 'average');
    assert.equal(row.score, 8.65, 'full precision, not rounded');
    assert.equal((await cs(show)).score, 8.7, 'half-up at display');
  });

  it('V4: seasons 9.0, 8.0 and 7.4 -> 8.1333…, displayed 8.1', async () => {
    const show = await series('V4');
    const rater = await user();
    // A loved band of 16: ranks 6, 11 and 14 score 9.0, 8.0 and 7.4.
    const [a, b, c] = [await season(show, 1), await season(show, 2), await season(show, 3)];
    await lovedFillers(rater, 5);
    await rankAs(rater, a, 'loved');
    await lovedFillers(rater, 4);
    await rankAs(rater, b, 'loved');
    await lovedFillers(rater, 2);
    await rankAs(rater, c, 'loved');
    await lovedFillers(rater, 2);
    assert.deepEqual(
      [await ownScore(rater, a), await ownScore(rater, b), await ownScore(rater, c)],
      [9, 8, 7.4],
    );
    const [row] = await effective(rater, show);
    assert.equal(row.source, 'average');
    assert.match(row.raw, /^8\.1333/);
    assert.equal(row.season_count, 3);
    assert.equal((await cs(show)).score, 8.1);
  });

  it('V5: an explicit 6.9 removed falls back to the 8.5 season average', async () => {
    const show = await series('V5');
    const rater = await showRater(show, {
      explicit: 'fine',
      seasons: [
        [await season(show, 1), 'loved'],
        [await season(show, 2), 'loved'],
      ],
    });
    assert.equal((await effective(rater, show))[0].score, 6.9);
    assert.equal((await cs(show)).score, 6.9);
    await unlogAs(rater, show);
    const [row] = await effective(rater, show);
    assert.deepEqual([row.score, row.source], [8.5, 'average']);
    assert.equal((await cs(show)).score, 8.5);
  });

  it('V6: no show and no seasons -> no effective score and no contribution', async () => {
    const show = await series('V6');
    await season(show, 1);
    const rater = await user();
    await qualifyForTv(t, rater);
    assert.deepEqual(await effective(rater, show), []);
    assert.deepEqual(await cs(show), { score: null, rating_count: 0, min_ratings: 1 });
  });
});

describe('agreement: Top Rated and the starter picker still match community_score', () => {
  it('excludes ineligible raters on the walls exactly as on the title page', async () => {
    await t.sql(
      `update app_config set value = '0'::jsonb where key = 'discovery.support_percentile'`,
    );
    await t.sql(
      `update app_config set value = '2'::jsonb where key = 'discovery.support_min_ratings.movie'`,
    );
    await t.sql(
      `update app_config set value = '2'::jsonb where key = 'discovery.support_min_ratings.season'`,
    );
    try {
      const film = await movie('wall film');
      const show = await series('wall show');
      const s1 = await season(show, 1);
      // Two eligible raters who love both, and three ineligible raters who rank both last.
      for (let i = 0; i < 2; i += 1) {
        const who = await user();
        await rankAs(who, film, 'loved');
        await rankAs(who, s1, 'loved');
        await qualifyForMovies(t, who);
        await qualifyForTv(t, who);
      }
      for (let i = 0; i < 3; i += 1) {
        const who = await user();
        await rankAs(who, film, 'not_for_me');
        await rankAs(who, s1, 'not_for_me');
      }

      await t.actAs(viewer);
      for (const [medium, item] of [
        ['movies', film],
        ['tv', s1],
      ]) {
        const { rows } = await t.sql(`select * from top_rated_titles($1, 50)`, [medium]);
        const row = rows.find((r) => r.media_item_id === item);
        assert.ok(row, `${medium}: two eligible raters clear a floor of two`);
        assert.equal(Number(row.score), 10);
        assert.equal(row.rating_count, 2);
        assert.deepEqual(await cs(item), { score: 10, rating_count: 2, min_ratings: 1 });
      }
      const starter = (await t.sql(`select * from starter_movies(200)`)).rows.find(
        (r) => r.media_item_id === film,
      );
      assert.ok(starter);
      assert.deepEqual([Number(starter.score), starter.rating_count], [10, 2]);
    } finally {
      await t.sql(
        `update app_config set value = '0.9'::jsonb where key = 'discovery.support_percentile'`,
      );
      await t.sql(
        `update app_config set value = '3'::jsonb where key = 'discovery.support_min_ratings.movie'`,
      );
      await t.sql(
        `update app_config set value = '2'::jsonb where key = 'discovery.support_min_ratings.season'`,
      );
    }
  });

  it('computes the support floor over eligible contributors only', async () => {
    const db = await createTestDb();
    try {
      const make = async (name) => db.createUser({ username: name });
      const films = [];
      for (let i = 0; i < 4; i += 1) {
        films.push(await db.createMovie(`floor ${i}`, 6_900_000 + i));
      }
      // Five ineligible raters rank every film: alone they would put p90 at 5.
      for (let i = 0; i < 5; i += 1) {
        const who = await make(`floor_thin_${i}`);
        await db.actAs(who);
        for (const f of films) await db.rankToCompletion(f, 'loved', async (p) => p);
      }
      const floor = async () =>
        (await db.sql(`select community_support_floor('movie'::media_kind) as k`)).rows[0].k;
      assert.equal(await floor(), 3, 'no eligible rater: the per-medium minimum alone');
      // Four eligible raters on every film: p90 of 4.
      for (let i = 0; i < 4; i += 1) {
        const who = await make(`floor_full_${i}`);
        await db.actAs(who);
        for (const f of films) await db.rankToCompletion(f, 'loved', async (p) => p);
        await qualifyForMovies(db, who, 6);
      }
      assert.equal(await floor(), 4);
    } finally {
      await db.close();
    }
  });
});

describe('§4I: Following score is not a community score', () => {
  it('still counts a followed friend with two rankings', async () => {
    const me = await user();
    const friend = await user();
    const film = await movie('friend film');
    await rankAs(friend, film, 'loved');
    await addFillerRankings(t, friend, 'movies', 1);
    await t.sql(
      `insert into follows (follower_id, followee_id, state, approved_at)
       values ($1, $2, 'approved'::follow_state, now())`,
      [me, friend],
    );
    await t.actAs(me);
    const { rows } = await t.sql(`select * from following_score($1)`, [film]);
    assert.equal(rows[0].rating_count, 1);
    assert.equal(Number(rows[0].score), 10);
    assert.deepEqual(await cs(film), { score: null, rating_count: 0, min_ratings: 1 });
  });
});
