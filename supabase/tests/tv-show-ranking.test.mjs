import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb, one } from './harness.mjs';
import { tvRanking } from './tv-ranking-support.mjs';

/**
 * A whole show is ranked in its own pool (20261114000100, 20261114000200).
 *
 * `tv_shows` sits beside `movies` and `tv_seasons`. Shows compare with shows, seasons
 * with seasons. Nothing is derived across the two TV levels: no show score from its
 * seasons, no implicit show ranking from a season, and neither level moves because the
 * other changed. Every assertion is against observables: positions, scores, the ledger.
 */
const ctx = { t: null, user: null, seq: 0 };
const {
  op,
  movie,
  series,
  taste,
  prefer,
  drive,
  rank,
  correct,
  positions,
  posts,
  scoreOf,
  fixture,
} = tvRanking(ctx);

before(async () => {
  ctx.t = await createTestDb();
});

after(async () => {
  await ctx.t?.close();
});

beforeEach(async () => {
  ctx.seq += 1;
  ctx.user = await ctx.t.createUser({ username: `tvshow_${ctx.seq}` });
  await ctx.t.actAs(ctx.user);
});

describe('a show is ranked in its own pool', () => {
  it('starts, completes and persists as a tv_shows ranking', async () => {
    const { shows, main } = await fixture();
    const placed = await rank(main, 'loved', 80);

    assert.equal(placed.category, 'tv_shows');
    assert.equal(placed.position, 2, 'between Show A (90) and Show B (70)');
    const list = await positions('tv_shows');
    assert.deepEqual(
      list.map((r) => r.media_item_id),
      [shows[0], main, shows[1], shows[2]],
    );
    await ctx.t.assertValid(ctx.user, 'tv_shows');
    const um = (
      await ctx.t.sql(
        `select bucket from user_media where user_id = $1 and media_item_id = $2`,
        [ctx.user, main],
      )
    ).rows[0];
    assert.equal(um.bucket, 'loved', 'I3: the show is logged in the band it is ranked in');
  });

  it('never compares a show with a season, a film, or anything outside its pool', async () => {
    const { main, seasons } = await fixture();
    const film = await movie('A film');
    await rank(film, 'loved', 99);
    await rank(seasons[0], 'loved', 99);

    const offered = new Set();
    taste.set(main, 80);
    await drive(
      await one(ctx.t.db, `select rank_start($1, 'loved', $2) as r`, [main, await op()]),
      main,
      async (pivot, subject) => {
        offered.add(pivot);
        return prefer(pivot, subject);
      },
    );
    const kinds = (
      await ctx.t.sql(`select distinct kind from media_items where id = any($1)`, [
        [...offered],
      ])
    ).rows.map((r) => r.kind);
    assert.deepEqual(kinds, ['series']);
  });

  it('refuses a comparison row pairing a show with one of its seasons', async () => {
    const { main, seasons } = await fixture();
    const err = await ctx.t.errorFrom(
      `insert into comparisons (user_id, winner_id, loser_id) values ($1, $2, $3)`,
      [ctx.user, main, seasons[0]],
    );
    assert.equal(err?.code, '22023');
  });

  it('keeps movies exactly as they were', async () => {
    const a = await movie('Heat');
    const b = await movie('Sicario');
    await rank(a, 'loved', 90);
    await rank(b, 'loved', 80);
    const { main } = await fixture();
    await rank(main, 'loved', 95);

    assert.deepEqual(
      (await positions('movies')).map((r) => r.media_item_id),
      [a, b],
    );
    await ctx.t.assertValid(ctx.user, 'movies');
  });
});

describe('the two TV levels never move each other', () => {
  it('ranking a season leaves every show position where it was, and the reverse', async () => {
    const { main, seasons } = await fixture();
    await rank(main, 'loved', 80);
    const showsBefore = await positions('tv_shows');

    await rank(seasons[3], 'loved', 60);
    await rank(seasons[4], 'fine', 40);
    assert.deepEqual(await positions('tv_shows'), showsBefore, 'seasons moved no show');

    const seasonsBefore = await positions('tv_seasons');
    await correct(main, 'fine');
    assert.deepEqual(await positions('tv_seasons'), seasonsBefore, 'the show moved no season');
  });

  it('never creates a show ranking when a season is ranked', async () => {
    const main = await series('Only seasons');
    const s1 = await ctx.t.createSeason(main, 1, 'Season 1');
    await rank(s1, 'loved', 50);
    assert.equal((await positions('tv_shows')).length, 0);
    assert.equal(await scoreOf(main), undefined, 'and no artificial show score');
  });

  it('scores each pool against its own bucket sizes', async () => {
    // One loved show, and four loved seasons. The show is the only member of its band, so
    // it scores the band's high; a season's score comes from its own band of four.
    const main = await series('Solo show');
    await rank(main, 'loved', 50);
    const other = await series('Other');
    const ss = [];
    for (let n = 1; n <= 4; n += 1) {
      const s = await ctx.t.createSeason(other, n, `Season ${n}`);
      await rank(s, 'loved', 100 - n);
      ss.push(s);
    }
    assert.equal(Number(await scoreOf(main)), 10, 'a band of one scores the high');
    assert.equal(
      Number(await scoreOf(ss[3])),
      7,
      'the last of four loved seasons scores the low',
    );
    const placed = await ctx.t.sql(
      `select category, band_size from ranking_placements
        where user_id = $1 and media_item_id = $2 order by created_at desc limit 1`,
      [ctx.user, main],
    );
    assert.equal(placed.rows[0].band_size, 1);
    assert.equal(placed.rows[0].category, 'tv_shows');
  });
});

describe('re-ranking a show', () => {
  it('moves far up within its band, starting from where it was', async () => {
    const shows = [];
    for (let i = 0; i < 9; i += 1) {
      const id = await series(`S${i}`);
      await rank(id, 'loved', 100 - i * 10);
      shows.push(id);
    }
    const last = shows[8];
    taste.set(last, 1000);
    const placed = await correct(last, 'loved');
    assert.equal(placed.position, 1);
    assert.equal(placed.movement.outcome, 'moved');
    assert.equal(placed.movement.from_position, 9);
    await ctx.t.assertValid(ctx.user, 'tv_shows');
  });

  it('moves far down and across bands, through the band chooser', async () => {
    const { shows, main } = await fixture();
    await rank(main, 'loved', 95);
    const placed = await correct(main, 'not_for_me');
    assert.equal(placed.bucket, 'not_for_me');
    assert.equal(placed.position, 4, 'below every loved show');
    assert.deepEqual(
      (await positions('tv_shows')).map((r) => r.media_item_id),
      [...shows, main],
    );
    await ctx.t.assertValid(ctx.user, 'tv_shows');
  });

  it('keeps the old placement when the re-rank is abandoned', async () => {
    const { main } = await fixture();
    await rank(main, 'loved', 80);
    const before = await positions('tv_shows');
    const score = await scoreOf(main);

    taste.set(main, 1);
    const step = await one(ctx.t.db, `select rank_again($1, 'loved', $2) as r`, [
      main,
      await op(),
    ]);
    assert.equal(step.done, false);
    await ctx.t.sql(`select rank_cancel($1)`, [step.session_id]);

    assert.deepEqual(await positions('tv_shows'), before);
    assert.equal(await scoreOf(main), score);
  });

  it('resumes an unfinished first ranking with its answers', async () => {
    const { main } = await fixture();
    taste.set(main, 80);
    const first = await one(ctx.t.db, `select rank_start($1, 'loved', $2) as r`, [
      main,
      await op(),
    ]);
    const second = await one(ctx.t.db, `select rank_answer($1, $2, $3) as r`, [
      first.session_id,
      prefer(first.pivot, main),
      await op(),
    ]);
    assert.equal(second.done, false);

    const resumed = await one(ctx.t.db, `select rank_start($1, 'loved', $2) as r`, [
      main,
      await op(),
    ]);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.pivot, second.pivot, 'the comparison on screen when the reader left');
    const placed = await drive(resumed, main);
    assert.equal(placed.position, 2);
  });

  it('applies a retried completion once', async () => {
    const { main } = await fixture();
    taste.set(main, 80);
    let r = await one(ctx.t.db, `select rank_start($1, 'loved', $2) as r`, [main, await op()]);
    let last;
    while (!r.done) {
      const id = await op();
      last = { session: r.session_id, winner: prefer(r.pivot, main), id };
      r = await one(ctx.t.db, `select rank_answer($1, $2, $3) as r`, [
        last.session,
        last.winner,
        id,
      ]);
    }
    const replay = await one(ctx.t.db, `select rank_answer($1, $2, $3) as r`, [
      last.session,
      last.winner,
      last.id,
    ]);
    assert.equal(replay.position, r.position);
    assert.equal((await posts(main)).length, 1, 'one ranking, one activity');
  });
});

describe('scores a reader sees for a show', () => {
  it('come from explicit show rankings only, never from seasons', async () => {
    const main = await series('Community');
    const s1 = await ctx.t.createSeason(main, 1, 'Season 1');
    const readers = [];
    for (let i = 0; i < 3; i += 1) {
      const id = await ctx.t.createUser({ username: `tvcommunity_${ctx.seq}_${i}` });
      readers.push(id);
      await ctx.t.actAs(id);
      await rank(s1, 'loved', 1);
    }
    let community = (await ctx.t.sql(`select * from community_score($1)`, [main])).rows[0];
    assert.equal(community.rating_count, 0, 'three season rankings are not a show rating');
    assert.equal(community.score, null);

    for (const id of readers) {
      await ctx.t.actAs(id);
      await rank(main, 'fine', 1);
    }
    community = (await ctx.t.sql(`select * from community_score($1)`, [main])).rows[0];
    assert.equal(community.rating_count, 3);
    assert.equal(
      Number(community.score),
      6.9,
      'each reader’s one fine show scores the fine high',
    );
    const season = (await ctx.t.sql(`select * from community_score($1)`, [s1])).rows[0];
    assert.equal(Number(season.score), 10, 'and the season keeps its own');
    await ctx.t.actAs(ctx.user);
  });
});

describe('the profile count follows the collection precedence', () => {
  it('counts a show alone, or its ranked seasons instead of it', async () => {
    const main = await series('Counted');
    const s1 = await ctx.t.createSeason(main, 1, 'Season 1');
    const s2 = await ctx.t.createSeason(main, 2, 'Season 2');
    const count = async () =>
      (await ctx.t.sql(`select tv from profile_title_counts($1)`, [ctx.user])).rows[0].tv;

    await rank(main, 'loved', 1);
    assert.equal(await count(), 1, 'show only: the show');
    await rank(s1, 'loved', 2);
    assert.equal(await count(), 1, 'show + S1: S1');
    await rank(s2, 'loved', 1);
    assert.equal(await count(), 2, 'show + S1 + S2: both seasons');
  });
});

describe('goals stay on movies and seasons', () => {
  it('refuses a whole-show goal, so one series is never counted twice', async () => {
    const err = await ctx.t.errorFrom(
      `select set_watch_goal(2026, 'tv_shows'::ranking_category, 5)`,
    );
    assert.equal(err?.code, '22023');
    const ok = await one(
      ctx.t.db,
      `select set_watch_goal(2026, 'tv_seasons'::ranking_category, 5) as r`,
    );
    assert.equal(ok.status, 'ok');
  });
});
