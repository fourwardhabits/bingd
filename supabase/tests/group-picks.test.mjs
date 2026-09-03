import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Group Picks — `20260907000100`.
 *
 * ---------------------------------------------------------------------------
 * THE THREE THINGS WORTH PINNING HERE
 *
 * **That membership is decided at query time, per member, from the caller's own
 * side.** The picker offers approved follows, and the server re-asks: a block, a
 * suspension, a flip to private, or a plain stranger's id contributes nothing and
 * is not in the denominator. The effective count is what the arithmetic ran over.
 *
 * **That the answer is aggregates and nothing else.** saved_count and never a
 * saver, watched_count and never a watcher. The function is security invoker, so
 * this is structural: the private tables answer empty for rows the caller may not
 * read, and the shape of a pick is asserted key by key below.
 *
 * **That a rewatch clears a positive floor or does not exist.** Every known
 * watcher in `loved` keeps a title eligible with a penalty; one `fine`, one
 * `not_for_me`, or an unbucketed log excludes it; a title the whole effective
 * group has met is excluded even if everybody loved it.
 */

let t;
let seq = 95000;

const picks = (who, memberIds, medium = 'movies', limit = null) =>
  t.asUser(who, async () => {
    const { rows } = await t.sql(`select group_picks($1::uuid[], $2, $3) as r`, [
      memberIds,
      medium,
      limit,
    ]);
    return rows[0].r;
  });

const ids = (result) => result.picks.map((p) => p.media_item_id);

const follow = (a, b, state = 'approved') =>
  t.sql(
    `insert into follows (follower_id, followee_id, state) values ($1, $2, $3)
     on conflict (follower_id, followee_id) do update set state = excluded.state`,
    [a, b, state],
  );

const rank = (user, item, bucket = 'loved', position = 1, category = 'movies') =>
  t.sql(
    `insert into rankings (user_id, media_item_id, category, bucket, position)
     values ($1, $2, $3::ranking_category, $4::taste_bucket, $5)
     on conflict (user_id, media_item_id) do update set bucket = excluded.bucket`,
    [user, item, category, bucket, position],
  );

const save = (user, item) =>
  t.sql(
    `insert into watchlist (user_id, media_item_id) values ($1, $2)
     on conflict do nothing`,
    [user, item],
  );

const similar = (anchor, similarIds) =>
  t.sql(
    `insert into media_cache (media_item_id, facet, payload, expires_at)
     values ($1, 'similar', jsonb_build_object('ids', $2::jsonb), now() + interval '7 days')
     on conflict (media_item_id, facet) do update
       set payload = excluded.payload, expires_at = excluded.expires_at`,
    [anchor, JSON.stringify(similarIds)],
  );

const wipe = (users) =>
  Promise.all([
    t.sql(`delete from rankings where user_id = any($1::uuid[])`, [users]),
    t.sql(`delete from watchlist where user_id = any($1::uuid[])`, [users]),
    t.sql(`delete from user_media where user_id = any($1::uuid[])`, [users]),
    t.sql(`delete from recommendation_feedback where user_id = any($1::uuid[])`, [users]),
    t.sql(`delete from title_recommendations where sender_id = any($1::uuid[])`, [users]),
  ]);

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t.close();
});

// ---------------------------------------------------------------------------

describe('who is in the group', () => {
  let me;
  let abby;
  let bo;
  let film;

  before(async () => {
    me = await t.createUser({ username: 'gp_me' });
    abby = await t.createUser({ username: 'gp_abby' });
    bo = await t.createUser({ username: 'gp_bo' });
    film = await t.createMovie('Group Saved', seq++);
    await follow(me, abby);
    await follow(me, bo);
  });

  beforeEach(() => wipe([me, abby, bo]));

  it('always includes the caller, whether or not their id is in the array', async () => {
    await save(abby, film);
    const without = await picks(me, [abby]);
    const withSelf = await picks(me, [abby, me]);
    assert.equal(without.effective_member_count, 2);
    assert.deepEqual(withSelf, without, 'the caller arriving in the array changes nothing');
  });

  it('collapses duplicate member ids', async () => {
    await save(abby, film);
    const result = await picks(me, [abby, abby, abby]);
    assert.equal(result.effective_member_count, 2);
    assert.equal(result.picks[0].saved_count, 1, 'one saver, not three');
  });

  it('behaves safely below the product minimum: a solo call is answered, not raised', async () => {
    await save(me, film);
    const result = await picks(me, []);
    assert.equal(result.status, 'ok');
    assert.equal(result.effective_member_count, 1);
  });

  it('refuses a seventh person', async () => {
    const extras = [];
    for (let i = 0; i < 6; i += 1) {
      extras.push(await t.createUser({ username: `gp_extra_${i}` }));
    }
    const error = await t.asUser(me, () =>
      t.errorFrom(`select group_picks($1::uuid[], 'movies', null)`, [extras]),
    );
    assert.equal(error?.code, '22023');
  });

  it('refuses a medium it does not know', async () => {
    const error = await t.asUser(me, () =>
      t.errorFrom(`select group_picks($1::uuid[], 'podcasts', null)`, [[abby]]),
    );
    assert.equal(error?.code, '22023');
  });

  it('tells an anonymous caller nothing', async () => {
    assert.ok(await t.asAnon(() => t.errorFrom(`select group_picks('{}'::uuid[], 'movies', null)`)));
  });

  it('drops a blocked member from the picks and from the denominator', async () => {
    await save(abby, film);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [abby, me]);
    try {
      const result = await picks(me, [abby]);
      assert.equal(result.effective_member_count, 1);
      assert.ok(!ids(result).includes(film), 'their watchlist must contribute nothing');
    } finally {
      await t.sql(`delete from blocks where blocker_id = $1`, [abby]);
    }
  });

  it('drops a private account whose follow is still pending', async () => {
    const priya = await t.createUser({ username: 'gp_priya', visibility: 'private' });
    await follow(me, priya, 'pending');
    await save(priya, film);
    try {
      const result = await picks(me, [priya]);
      assert.equal(result.effective_member_count, 1);
      assert.ok(!ids(result).includes(film));
    } finally {
      await t.sql(`delete from follows where followee_id = $1`, [priya]);
      await t.sql(`delete from watchlist where user_id = $1`, [priya]);
    }
  });

  it('drops a stranger the caller never followed', async () => {
    const stranger = await t.createUser({ username: 'gp_stranger' });
    await save(stranger, film);
    const result = await picks(me, [stranger]);
    assert.equal(result.effective_member_count, 1);
    assert.ok(!ids(result).includes(film));
  });

  it('drops a suspended member', async () => {
    await save(abby, film);
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [abby]);
    try {
      const result = await picks(me, [abby]);
      assert.equal(result.effective_member_count, 1);
      assert.ok(!ids(result).includes(film));
    } finally {
      await t.sql(`update profiles set status = 'active' where id = $1`, [abby]);
    }
  });

  it('counts exactly the members who survived the checks', async () => {
    const waiting = await t.createUser({ username: 'gp_waiting', visibility: 'private' });
    await follow(me, waiting, 'pending');
    await save(abby, film);
    await save(bo, film);
    try {
      const result = await picks(me, [abby, bo, waiting]);
      assert.equal(result.effective_member_count, 3, 'me, abby and bo; never the pending one');
      assert.equal(result.picks[0].saved_count, 2);
    } finally {
      await t.sql(`delete from follows where followee_id = $1`, [waiting]);
    }
  });
});

// ---------------------------------------------------------------------------

describe('what the group is offered, and in what order', () => {
  let me;
  let abby;
  let bo;
  let anchor;
  let sharedSave;
  let novel;
  let onlyTrending;

  before(async () => {
    me = await t.createUser({ username: 'gp_order_me' });
    abby = await t.createUser({ username: 'gp_order_abby' });
    bo = await t.createUser({ username: 'gp_order_bo' });
    anchor = await t.createMovie('Everyone Loved This', seq++);
    sharedSave = await t.createMovie('Both Saved This', seq++);
    novel = await t.createMovie('Nobody Saved This', seq++);
    onlyTrending = await t.createMovie('Merely Trending', seq++);
    await follow(me, abby);
    await follow(me, bo);
  });

  beforeEach(async () => {
    await wipe([me, abby, bo]);
    await t.sql(`delete from media_cache where facet = 'similar'`);
    await t.sql(`delete from provider_list_cache`);
  });

  it('puts a shared explicit save above an otherwise similar unsaved title', async () => {
    // Both titles sit in the similar list of a loved anchor; only one is saved.
    await rank(abby, anchor, 'loved', 1);
    await similar(anchor, [sharedSave, novel]);
    await save(abby, sharedSave);
    await save(bo, sharedSave);

    const result = await picks(me, [abby, bo]);
    const order = ids(result);
    assert.ok(order.indexOf(sharedSave) < order.indexOf(novel), 'explicit intent leads');
    const saved = result.picks.find((p) => p.media_item_id === sharedSave);
    assert.equal(saved.saved_count, 2);
    assert.equal(saved.source, 'saved');
  });

  it('surfaces a novel title from the similar infrastructure that nobody saved', async () => {
    await rank(abby, anchor, 'loved', 1);
    await similar(anchor, [novel]);

    const result = await picks(me, [abby]);
    const pick = result.picks.find((p) => p.media_item_id === novel);
    assert.ok(pick, 'discovery is the point of the wider pool');
    assert.equal(pick.source, 'group');
    assert.equal(pick.saved_count, 0);
  });

  it('keeps trending last, capped beneath every group-derived candidate', async () => {
    await rank(abby, anchor, 'loved', 1);
    await similar(anchor, [novel]);
    await t.sql(
      `insert into provider_list_cache (list_key, payload, expires_at)
       values ('trending.movie.week', jsonb_build_object('ids', $1::jsonb), now() + interval '6 hours')`,
      [JSON.stringify([onlyTrending])],
    );

    const result = await picks(me, [abby]);
    const order = ids(result);
    assert.ok(order.includes(onlyTrending), 'trending still fills a sparse pool');
    assert.ok(order.indexOf(novel) < order.indexOf(onlyTrending), 'and never leads it');
    const trendingPick = result.picks.find((p) => p.media_item_id === onlyTrending);
    assert.equal(trendingPick.source, 'trending');
    assert.ok(Number(trendingPick.group_score) <= 0.15);
  });

  it('reads a stale trending list rather than an empty one, like the client fallback', async () => {
    await t.sql(
      `insert into provider_list_cache (list_key, payload, expires_at)
       values ('trending.movie.week', jsonb_build_object('ids', $1::jsonb), now() - interval '1 day')`,
      [JSON.stringify([onlyTrending])],
    );
    const result = await picks(me, [abby]);
    assert.ok(ids(result).includes(onlyTrending), 'TREND-1: nothing refreshes the list yet');
  });

  it('counts savers accurately per title', async () => {
    await save(abby, sharedSave);
    await save(bo, sharedSave);
    await save(me, novel);

    const result = await picks(me, [abby, bo]);
    const two = result.picks.find((p) => p.media_item_id === sharedSave);
    const one = result.picks.find((p) => p.media_item_id === novel);
    assert.equal(two.saved_count, 2);
    assert.equal(one.saved_count, 1);
  });

  it('vetoes a title the caller dismissed, whoever saved it', async () => {
    await save(abby, sharedSave);
    await save(bo, sharedSave);
    await t.sql(
      `insert into recommendation_feedback (user_id, media_item_id, kind)
       values ($1, $2, 'dismiss')`,
      [me, sharedSave],
    );
    const result = await picks(me, [abby, bo]);
    assert.ok(!ids(result).includes(sharedSave));
  });

  it('answers two identical calls with the identical list', async () => {
    await rank(abby, anchor, 'loved', 1);
    await similar(anchor, [sharedSave, novel]);
    await save(abby, sharedSave);
    await t.sql(
      `insert into provider_list_cache (list_key, payload, expires_at)
       values ('trending.movie.week', jsonb_build_object('ids', $1::jsonb), now() + interval '6 hours')`,
      [JSON.stringify([onlyTrending])],
    );

    const first = await picks(me, [abby, bo]);
    const second = await picks(me, [abby, bo]);
    assert.deepEqual(second, first);
  });
});

// ---------------------------------------------------------------------------

describe('the rewatch floor', () => {
  let me;
  let abby;
  let bo;
  let film;

  before(async () => {
    me = await t.createUser({ username: 'gp_rw_me' });
    abby = await t.createUser({ username: 'gp_rw_abby' });
    bo = await t.createUser({ username: 'gp_rw_bo' });
    film = await t.createMovie('Seen Before', seq++);
    await follow(me, abby);
    await follow(me, bo);
  });

  beforeEach(() => wipe([me, abby, bo]));

  it('keeps a title one member loved and the rest have not met, flagged and penalised', async () => {
    await rank(abby, film, 'loved', 1);
    await save(bo, film);

    const result = await picks(me, [abby, bo]);
    const pick = result.picks.find((p) => p.media_item_id === film);
    assert.ok(pick, 'a positive rewatch stays eligible');
    assert.equal(pick.rewatch, true);
    assert.equal(pick.watched_count, 1);
  });

  it('excludes a title any known watcher found merely fine', async () => {
    await rank(abby, film, 'fine', 1);
    await save(bo, film);
    const result = await picks(me, [abby, bo]);
    assert.ok(!ids(result).includes(film), '"it was fine" is not a reason to watch it again');
  });

  it('excludes a title any known watcher rejected', async () => {
    await rank(abby, film, 'not_for_me', 1);
    await save(bo, film);
    const result = await picks(me, [abby, bo]);
    assert.ok(!ids(result).includes(film));
  });

  it('excludes a title one watcher loved and another found fine', async () => {
    await rank(abby, film, 'loved', 1);
    await rank(bo, film, 'fine', 1);
    const third = await t.createUser({ username: 'gp_rw_cara' });
    await follow(me, third);
    try {
      const result = await picks(me, [abby, bo, third]);
      assert.ok(!ids(result).includes(film), 'one neutral opinion sinks the rewatch');
    } finally {
      await t.sql(`delete from follows where followee_id = $1`, [third]);
    }
  });

  it('excludes a title the caller logged without an opinion', async () => {
    await t.sql(`insert into user_media (user_id, media_item_id) values ($1, $2)`, [me, film]);
    await save(abby, film);
    const result = await picks(me, [abby]);
    assert.ok(!ids(result).includes(film), 'an unknown opinion does not clear a positive floor');
  });

  it('excludes a title every effective member has met, even loved by all', async () => {
    await rank(abby, film, 'loved', 1);
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`,
      [me, film],
    );
    const result = await picks(me, [abby]);
    assert.ok(!ids(result).includes(film), 'the whole group has seen it; there is nothing to pick');
  });

  it('penalises an eligible rewatch beneath an equal unwatched candidate', async () => {
    const fresh = await t.createMovie('Never Seen', seq++);
    try {
      await save(abby, film);
      await save(abby, fresh);
      await rank(bo, film, 'loved', 1);

      const result = await picks(me, [abby, bo]);
      const order = ids(result);
      assert.ok(order.indexOf(fresh) < order.indexOf(film), 'the first watch leads at equal intent');
    } finally {
      await t.sql(`delete from media_items where id = $1`, [fresh]);
    }
  });
});

// ---------------------------------------------------------------------------

describe('tv answers are series', () => {
  let me;
  let abby;
  let series;
  let s1;
  let s2;
  let otherSeries;

  before(async () => {
    me = await t.createUser({ username: 'gp_tv_me' });
    abby = await t.createUser({ username: 'gp_tv_abby' });
    series = await t.createSeries('The Watched Show', seq++);
    s1 = await t.createSeason(series, 1, 'The Watched Show S1');
    s2 = await t.createSeason(series, 2, 'The Watched Show S2');
    otherSeries = await t.createSeries('The Saved Show', seq++);
    await follow(me, abby);
  });

  beforeEach(async () => {
    await wipe([me, abby]);
    await t.sql(`delete from media_cache where facet = 'similar'`);
  });

  it('rolls a season watchlist row up to its series', async () => {
    await save(abby, s1);
    const result = await picks(me, [abby], 'tv');
    assert.ok(ids(result).includes(series), 'the series, not the season');
    assert.ok(!ids(result).includes(s1));
  });

  it('anchors on the parent series of loved seasons and answers with series', async () => {
    await rank(abby, s1, 'loved', 1, 'tv_seasons');
    await similar(series, [otherSeries]);

    const result = await picks(me, [abby], 'tv');
    assert.ok(ids(result).includes(otherSeries));
    assert.ok(
      !ids(result).includes(s1) && !ids(result).includes(s2),
      'season rows never appear in the answer',
    );
  });

  it('treats a member with one fine season as a known non-positive watcher of the series', async () => {
    await rank(abby, s1, 'loved', 1, 'tv_seasons');
    await rank(abby, s2, 'fine', 2, 'tv_seasons');
    await save(me, series);
    const result = await picks(me, [abby], 'tv');
    assert.ok(!ids(result).includes(series), 'the worst known season opinion is the opinion');
  });

  it('keeps movies out of tv and tv out of movies', async () => {
    const film = await t.createMovie('A Film Among Shows', seq++);
    try {
      await save(abby, film);
      await save(abby, s1);
      const tv = await picks(me, [abby], 'tv');
      const movies = await picks(me, [abby], 'movies');
      assert.ok(!ids(tv).includes(film));
      assert.ok(ids(tv).includes(series));
      assert.ok(ids(movies).includes(film));
      assert.ok(!ids(movies).includes(series));
    } finally {
      await t.sql(`delete from media_items where id = $1`, [film]);
    }
  });
});

// ---------------------------------------------------------------------------

describe('what the answer discloses, and what it never can', () => {
  let me;
  let abby;
  let bo;
  let anchor;
  let novel;
  let saved;

  before(async () => {
    me = await t.createUser({ username: 'gp_priv_me' });
    abby = await t.createUser({ username: 'gp_priv_abby' });
    bo = await t.createUser({ username: 'gp_priv_bo' });
    anchor = await t.createMovie('Private Anchor', seq++);
    novel = await t.createMovie('Derived Candidate', seq++);
    saved = await t.createMovie('Saved Candidate', seq++);
    await follow(me, abby);
    await follow(me, bo);
  });

  beforeEach(async () => {
    await wipe([me, abby, bo]);
    await t.sql(`delete from media_cache where facet = 'similar'`);
  });

  it('returns aggregate keys and nothing else on every pick', async () => {
    await rank(abby, anchor, 'loved', 1);
    await similar(anchor, [novel]);
    await save(bo, saved);

    const result = await picks(me, [abby, bo]);
    assert.ok(result.picks.length >= 2);
    for (const pick of result.picks) {
      assert.deepEqual(Object.keys(pick).sort(), [
        'community_score',
        'group_score',
        'media_item_id',
        'rewatch',
        'saved_count',
        'source',
        'watched_count',
      ]);
    }
    assert.deepEqual(Object.keys(result).sort(), [
      'effective_member_count',
      'picks',
      'status',
    ]);
  });

  it('never carries a member id anywhere in the payload', async () => {
    await rank(abby, anchor, 'loved', 1);
    await similar(anchor, [novel]);

    const result = await picks(me, [abby, bo]);
    const raw = JSON.stringify(result);
    for (const memberId of [me, abby, bo]) {
      assert.ok(!raw.includes(memberId), 'no member id may appear in the answer');
    }
    // The anchor itself MAY appear -- one member loved it and nobody else has met it,
    // which is precisely the eligible-rewatch family -- but only as the same seven
    // aggregate keys as every other pick, never attributed to the member it came from.
    const asPick = result.picks.find((p) => p.media_item_id === anchor);
    assert.ok(asPick, 'a loved title others have not met is an eligible rewatch');
    assert.equal(asPick.rewatch, true);
  });

  it('keeps an ineligible anchor out of the payload entirely', async () => {
    // The caller logged the anchor with no opinion, so the rewatch floor excludes it.
    // What is being pinned: exclusion means absent -- not present with a low score,
    // and not reachable by any other family it also happens to sit in.
    await rank(abby, anchor, 'loved', 1);
    await similar(anchor, [novel]);
    await save(bo, anchor);
    await t.sql(`insert into user_media (user_id, media_item_id) values ($1, $2)`, [me, anchor]);

    const result = await picks(me, [abby, bo]);
    assert.ok(!JSON.stringify(result).includes(anchor));
  });

  it('is unmoved by other people’s title_recommendations', async () => {
    await save(bo, saved);
    const before = await picks(me, [abby, bo]);

    await t.sql(
      `insert into title_recommendations (sender_id, recipient_id, media_item_id)
       values ($1, $2, $3)`,
      [abby, bo, novel],
    );
    try {
      const after = await picks(me, [abby, bo]);
      assert.deepEqual(after, before, 'private inboxes are not a candidate source');
    } finally {
      await t.sql(`delete from title_recommendations where sender_id = $1`, [abby]);
    }
  });

  it('carries the community score as the only displayed number, withheld below the sample floor', async () => {
    await save(bo, saved);
    const result = await picks(me, [abby, bo]);
    const pick = result.picks.find((p) => p.media_item_id === saved);
    assert.equal(pick.community_score, null, 'no ratings yet: withheld, exactly as the title page would');
  });
});
