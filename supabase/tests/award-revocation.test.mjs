import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * An award the collection still supports — 20260904000100.
 *
 * A tier whose requirement is a claim about the user's CURRENT collection is held only
 * while the current collection satisfies it. Drop below the threshold and the tier goes,
 * with its feed post, its congratulations and any push still queued for it. Cross again
 * and it is earned again — one fresh post, one fresh congratulations, no duplicates.
 *
 * A tier whose requirement is a claim about acts that HAPPENED is permanent, and this
 * file pins that boundary in both directions: `award_tracks.metric_kind` is the whole of
 * it, and the five history tracks must survive everything the collection tracks lose.
 *
 * What is pinned here, in the order it would cost to lose it:
 *
 *   1. **The first tier goes when the collection stops supporting it** — ledger row,
 *      feed post and congratulations, together and atomically.
 *   2. **A higher tier goes while a lower one stands.** Each tier is measured against
 *      its own threshold, so losing Chaos Collector does not take Dabbler with it.
 *   3. **Still above the threshold, still earned.** A removal that leaves the count
 *      satisfied changes nothing at all.
 *   4. **Re-earning is a fresh cycle**, and exactly one of each — which is only possible
 *      because the revocation took the announcement's row out of the permanent partial
 *      unique index with it.
 *   5. **Every destructive entry point** reaches it: unlog, remove_from_collection,
 *      set_watchlist(false), the watchlist invariant, rank_unrank.
 *   6. **A rebucket announces nothing.** It deletes a ranking and re-inserts it in one
 *      transaction, which is exactly what a non-deferred trigger would have turned into
 *      a revoke-and-re-announce on every band move.
 *   7. **History tracks never revoke**, whatever is deleted.
 *   8. **The push outbox is emptied with the notification** — a queued push for a tier
 *      that no longer exists must not leave the server.
 *
 * True two-connection concurrency lives in `concurrency/races/award-revocation.mjs`;
 * PGlite is one connection. What this file covers of that invariant is the
 * single-transaction interleavings, which are the ones the deferred trigger settles.
 */

let t;
let seq = 980000;

const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

const unlocks = async (user, award) =>
  (
    await t.sql(
      `select tier_key, announced, value_at_unlock::int as value from award_unlocks
        where user_id = $1 and award_key = $2 order by tier_key`,
      [user, award],
    )
  ).rows;

const tierKeys = async (user, award) => (await unlocks(user, award)).map((row) => row.tier_key);

const posts = async (user, award) =>
  (
    await t.sql(
      `select id, payload from feed_events
        where actor_id = $1 and type = 'award_earned' and payload ->> 'award' = $2
        order by created_at`,
      [user, award],
    )
  ).rows;

const congrats = async (user, award) =>
  (
    await t.sql(
      `select id, payload from notifications
        where recipient_id = $1 and type = 'award_earned' and payload ->> 'award' = $2
        order by created_at`,
      [user, award],
    )
  ).rows;

const outbox = async (user) =>
  Number(
    (
      await t.sql(
        `select count(*)::int as n from push_outbox o
           join notifications n on n.id = o.notification_id
          where n.recipient_id = $1 and n.type = 'award_earned'`,
        [user],
      )
    ).rows[0].n,
  );

const metric = async (user, award, threshold) =>
  Number(
    (await t.sql(`select _award_metric($1, $2, $3) as m`, [user, award, threshold])).rows[0].m,
  );

/** A movie carrying the metadata a metric reads. */
const movieWith = async ({ genres = [] } = {}) => {
  const id = await t.createMovie(`revoke_fixture_${seq}`, seq++);
  await t.sql(`update media_items set genres = $2 where id = $1`, [id, genres]);
  return id;
};

/** A fixture season, whose series is its own so the numbers cannot collide. */
const season = async () => {
  const series = await t.createSeries(`revoke_series_${seq}`, seq++);
  return t.createSeason(series, 1, `Season 1`);
};

const log = (user, mediaItemId) =>
  t.sql(`insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`, [
    user,
    mediaItemId,
  ]);

const save = (user, mediaItemId) =>
  t.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [user, mediaItemId]);

/** The eighteen canonical genres, which is what Genre Gremlin counts distinct of. */
const GENRES = [
  'Action',
  'Adventure',
  'Animation',
  'Comedy',
  'Crime',
  'Documentary',
  'Drama',
  'Family',
  'Fantasy',
  'History',
  'Horror',
  'Music',
  'Mystery',
  'Romance',
  'Science Fiction',
  'Thriller',
  'War',
  'Western',
];

/**
 * One title per genre, logged, up to `n` distinct genres.
 *
 * Genre Gremlin is the cheapest three-tier crossing there is: 14, 16 and 17 distinct
 * genres, so seventeen titles buy all three tiers and one removal drops exactly one.
 */
const giveGenres = async (who, n) => {
  const films = [];
  for (let i = 0; i < n; i += 1) {
    const film = await movieWith({ genres: [GENRES[i]] });
    await log(who, film);
    films.push(film);
  }
  return films;
};

/** `n` logged seasons, which is Season Snacker's metric. Bronze is fifteen. */
const giveSeasons = async (who, n) => {
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const id = await season();
    await log(who, id);
    ids.push(id);
  }
  return ids;
};

before(async () => {
  t = await createTestDb();
});

after(async () => t?.close());

// ---------------------------------------------------------------------------

describe('the classification is a table, and every tier belongs to one', () => {
  it('classifies all twenty tracks, and no tier escapes the key', async () => {
    const rows = (
      await t.sql(`select metric_kind, count(*)::int as n from award_tracks group by 1 order by 1`)
    ).rows;
    assert.deepEqual(rows, [
      { metric_kind: 'collection', n: 15 },
      { metric_kind: 'history', n: 5 },
    ]);

    const orphans = (
      await t.sql(
        `select t.award_key from award_tiers t
          left join award_tracks k on k.award_key = t.award_key
          where k.award_key is null`,
      )
    ).rows;
    assert.deepEqual(orphans, [], 'every seeded tier belongs to a classified track');
  });

  it('names the five histories explicitly, so widening the set is a visible edit', async () => {
    const history = (
      await t.sql(`select award_key from award_tracks where metric_kind = 'history' order by 1`)
    ).rows.map((row) => row.award_key);

    assert.deepEqual(history, [
      'comment-gremlin',
      'heart-magnet',
      'hype-courier',
      'invite-instigator',
      'mutual-mania',
    ]);
  });

  it('refuses a tier whose track is not classified', async () => {
    await assert.rejects(
      () =>
        t.sql(
          `insert into award_tiers (award_key, tier_index, tier_key, tier_label, display_name, threshold)
           values ('not-a-track', 1, 'x', 'X', 'X', 1)`,
        ),
      /foreign key|award_tiers_track_fk/i,
      'a twenty-first track must be classified rather than defaulting to permanent',
    );
  });
});

// ---------------------------------------------------------------------------

describe('losing a tier the collection no longer supports', () => {
  it('takes the ledger row, the feed post and the congratulations together', async () => {
    const reader = await t.createUser({ username: 'rv_first' });
    const seasons = await giveSeasons(reader, 15);

    assert.equal(await metric(reader, 'season-snacker', 15), 15, 'CONTROL: at the threshold');
    assert.deepEqual(await tierKeys(reader, 'season-snacker'), ['bronze']);
    assert.equal((await posts(reader, 'season-snacker')).length, 1, 'CONTROL: it was announced');
    assert.equal((await congrats(reader, 'season-snacker')).length, 1);

    await t.actAs(reader);
    await t.sql(`select unlog($1, $2) as r`, [await uuid(), seasons[0]]);

    assert.equal(await metric(reader, 'season-snacker', 15), 14, 'one below');
    assert.deepEqual(await tierKeys(reader, 'season-snacker'), [], 'the tier is gone');
    assert.equal((await posts(reader, 'season-snacker')).length, 0, 'and so is the feed post');
    assert.equal((await congrats(reader, 'season-snacker')).length, 0, 'and the congratulations');
  });

  it('takes the queued push with the notification, so it never leaves the server', async () => {
    // `push_outbox` keys to the notification with `on delete cascade`. A push already
    // delivered to a phone cannot be recalled — that limitation is stated in the
    // migration header — but one still sitting in the outbox must not be sent for a
    // tier that no longer exists.
    const reader = await t.createUser({ username: 'rv_push' });
    await t.sql(
      `insert into device_tokens (user_id, token, platform) values ($1, 'rv_push_token', 'ios')`,
      [reader],
    );
    const seasons = await giveSeasons(reader, 15);

    assert.equal(await outbox(reader), 1, 'CONTROL: the congratulations queued a push');

    await t.actAs(reader);
    await t.sql(`select unlog($1, $2) as r`, [await uuid(), seasons[0]]);

    assert.equal(await outbox(reader), 0, 'the queued push went with the notification');
  });

  it('keeps every lower tier whose own threshold is still met', async () => {
    // Genre Gremlin: 14 / 16 / 17 distinct genres. Seventeen titles earn all three;
    // one removal fails only the top one. Each tier is measured against ITS OWN
    // threshold, which is also what makes Two-Screen Life's per-tier cap correct.
    const reader = await t.createUser({ username: 'rv_ladder' });
    const films = await giveGenres(reader, 17);

    assert.deepEqual(
      (await tierKeys(reader, 'genre-gremlin')).sort(),
      ['chaos-collector', 'dabbler', 'mixer'],
      'CONTROL: all three',
    );

    await t.actAs(reader);
    await t.sql(`select unlog($1, $2) as r`, [await uuid(), films[16]]);

    assert.equal(await metric(reader, 'genre-gremlin', 17), 16);
    assert.deepEqual(
      (await tierKeys(reader, 'genre-gremlin')).sort(),
      ['dabbler', 'mixer'],
      'only the unsupported tier went',
    );
    // Each tier was crossed on its own insert, so each was announced. The top tier's
    // post goes with the top tier; the two below it are announcements of tiers that are
    // still earned, and deleting them would be erasing a true statement.
    assert.deepEqual(
      (await posts(reader, 'genre-gremlin')).map((row) => row.payload.tier).sort(),
      ['dabbler', 'mixer'],
      'the top tier\'s post went; the posts for the tiers that stand did not',
    );
  });

  it('changes nothing at all while the count is still above the threshold', async () => {
    const reader = await t.createUser({ username: 'rv_safe' });
    const seasons = await giveSeasons(reader, 16);

    const before = await unlocks(reader, 'season-snacker');
    const postId = (await posts(reader, 'season-snacker'))[0].id;

    await t.actAs(reader);
    await t.sql(`select unlog($1, $2) as r`, [await uuid(), seasons[0]]);

    assert.equal(await metric(reader, 'season-snacker', 15), 15, 'exactly at it, which counts');
    assert.deepEqual(await unlocks(reader, 'season-snacker'), before, 'the ledger row is untouched');
    assert.equal(
      (await posts(reader, 'season-snacker'))[0].id,
      postId,
      'the same feed event, not a replacement',
    );
  });
});

// ---------------------------------------------------------------------------

describe('earning it again', () => {
  it('is a fresh cycle: one new post, one new congratulations, no duplicates', async () => {
    const reader = await t.createUser({ username: 'rv_again' });
    const seasons = await giveSeasons(reader, 15);
    const firstPost = (await posts(reader, 'season-snacker'))[0].id;
    const firstCongrats = (await congrats(reader, 'season-snacker'))[0].id;

    await t.actAs(reader);
    await t.sql(`select unlog($1, $2) as r`, [await uuid(), seasons[0]]);
    assert.deepEqual(await tierKeys(reader, 'season-snacker'), [], 'CONTROL: revoked');

    // Back over the line. The partial unique indexes on feed_events and notifications
    // are permanent, so this only works because the revocation took their rows too.
    await t.sql(`reset role`);
    await giveSeasons(reader, 1);

    const rows = await unlocks(reader, 'season-snacker');
    assert.equal(rows.length, 1, 'exactly one ledger row');
    assert.equal(rows[0].tier_key, 'bronze');
    assert.equal(rows[0].announced, true, 'this row produced the new announcement');
    assert.equal(rows[0].value, 15);

    const after = await posts(reader, 'season-snacker');
    assert.equal(after.length, 1, 'exactly one feed post — not two, not zero');
    assert.notEqual(after[0].id, firstPost, 'and it is a new one');

    const inbox = await congrats(reader, 'season-snacker');
    assert.equal(inbox.length, 1, 'exactly one congratulations');
    assert.notEqual(inbox[0].id, firstCongrats);
  });

  it('survives three cycles without accumulating anything', async () => {
    const reader = await t.createUser({ username: 'rv_cycles' });
    let seasons = await giveSeasons(reader, 15);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await t.actAs(reader);
      await t.sql(`select unlog($1, $2) as r`, [await uuid(), seasons[cycle]]);
      assert.deepEqual(await tierKeys(reader, 'season-snacker'), [], `cycle ${cycle}: revoked`);
      assert.equal((await posts(reader, 'season-snacker')).length, 0);

      await t.sql(`reset role`);
      seasons = seasons.concat(await giveSeasons(reader, 1));
      assert.deepEqual(await tierKeys(reader, 'season-snacker'), ['bronze'], `cycle ${cycle}: back`);
      assert.equal((await posts(reader, 'season-snacker')).length, 1, 'still exactly one post');
      assert.equal((await congrats(reader, 'season-snacker')).length, 1, 'still exactly one');
    }
  });
});

// ---------------------------------------------------------------------------

describe('every destructive entry point reaches it', () => {
  it('Remove from collection, which is rank_unrank and then unlog', async () => {
    // `removeFromCollection` (collection/writes.ts) is two round trips, not one RPC: it
    // clears the ranking and then unlogs. Both halves delete a row a collection metric
    // counts, in two separate transactions, and the tier must go on the second.
    const reader = await t.createUser({ username: 'rv_remove' });
    const seasons = await giveSeasons(reader, 15);
    await t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       values ($1, $2, 'tv_seasons', 'loved', 1)`,
      [reader, seasons[0]],
    );

    await t.actAs(reader);
    await t.sql(`select rank_unrank($1, $2) as r`, [seasons[0], await uuid()]);
    await t.sql(`select unlog($1, $2) as r`, [await uuid(), seasons[0]]);

    assert.equal(await metric(reader, 'season-snacker', 15), 14);
    assert.deepEqual(await tierKeys(reader, 'season-snacker'), []);
    assert.equal((await posts(reader, 'season-snacker')).length, 0);
  });

  it('set_watchlist(false), which is Queue Dragon', async () => {
    const reader = await t.createUser({ username: 'rv_queue' });
    const saved = [];
    for (let i = 0; i < 25; i += 1) {
      const film = await movieWith({});
      await save(reader, film);
      saved.push(film);
    }
    assert.deepEqual(await tierKeys(reader, 'queue-dragon'), ['seedling'], 'CONTROL: earned');

    await t.actAs(reader);
    await t.sql(`select set_watchlist($1, $2, false) as r`, [await uuid(), saved[0]]);

    assert.equal(await metric(reader, 'queue-dragon', 25), 24);
    assert.deepEqual(await tierKeys(reader, 'queue-dragon'), []);
    assert.equal((await posts(reader, 'queue-dragon')).length, 0);
  });

  it('the watchlist invariant, which takes a title off the list when it is logged', async () => {
    // 20260815040000 deletes the watchlist row server-side the moment the title is
    // logged. That is a Queue Dragon decrease nobody pressed a button for, and it goes
    // through the same trigger by construction.
    const reader = await t.createUser({ username: 'rv_invariant' });
    const saved = [];
    for (let i = 0; i < 25; i += 1) {
      const film = await movieWith({});
      await save(reader, film);
      saved.push(film);
    }
    assert.deepEqual(await tierKeys(reader, 'queue-dragon'), ['seedling'], 'CONTROL: earned');

    await log(reader, saved[0]);

    assert.equal(await metric(reader, 'queue-dragon', 25), 24, 'the invariant removed the row');
    assert.deepEqual(await tierKeys(reader, 'queue-dragon'), []);
  });

  it('rank_unrank, which is Rating Rascal', async () => {
    const reader = await t.createUser({ username: 'rv_rank' });
    // Rating Rascal's first tier is 100 rankings, which is a lot of fixtures — so the
    // tier is put on the ledger directly and the *revocation* is what is under test.
    // The unlock path is covered in award-unlocks.test.mjs.
    const films = [];
    for (let i = 0; i < 3; i += 1) {
      const film = await movieWith({});
      await log(reader, film);
      films.push(film);
      await t.sql(
        `insert into rankings (user_id, media_item_id, category, bucket, position)
         values ($1, $2, 'movies', 'loved', $3)`,
        [reader, film, i + 1],
      );
    }
    await t.sql(
      `insert into award_unlocks (user_id, award_key, tier_key, value_at_unlock, announced)
       values ($1, 'rating-rascal', 'scribbler', 100, true)`,
      [reader],
    );
    await t.sql(
      `insert into feed_events (actor_id, type, payload)
       values ($1, 'award_earned', jsonb_build_object(
         'award', 'rating-rascal', 'tier', 'scribbler',
         'award_name', 'Rating Rascal', 'tier_label', 'Scribbler'))`,
      [reader],
    );

    await t.actAs(reader);
    await t.sql(`select rank_unrank($1, $2) as r`, [films[2], await uuid()]);

    assert.deepEqual(await tierKeys(reader, 'rating-rascal'), [], 'the unsupported tier went');
    assert.equal((await posts(reader, 'rating-rascal')).length, 0);
  });
});

// ---------------------------------------------------------------------------

describe('a transaction is judged by what it ends with', () => {
  it('a rebucket announces nothing, because it lost nothing', async () => {
    // `rank_rebucket` ends at `_rank_finalize`, which DELETES the old `rankings` row and
    // INSERTS the new one in a single transaction. An immediate AFTER DELETE trigger
    // fires between those two statements, sees one ranking fewer than the threshold and
    // revokes Rating Rascal — deleting the feed post — and the insert that follows
    // re-earns it and posts again. Moving a title between bands would announce an award
    // the reader already had, every time. The deferred trigger measures the
    // transaction's final state, where nothing was lost.
    //
    // Scribbler is a hundred rankings, and this needs the tier to be GENUINELY earned:
    // a seeded ledger row over a count that does not support it would be revoked here
    // correctly, and would prove nothing about the deferral.
    const reader = await t.createUser({ username: 'rv_rebucket' });
    const films = [];
    for (let i = 0; i < 100; i += 1) films.push(await movieWith({}));

    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket)
       select $1, id, 'loved' from unnest($2::uuid[]) as id`,
      [reader, films],
    );
    await t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       select $1, id, 'movies', 'loved', ord
         from unnest($2::uuid[]) with ordinality as f(id, ord)`,
      [reader, films],
    );

    assert.equal(await metric(reader, 'rating-rascal', 100), 100, 'CONTROL: exactly at Scribbler');
    assert.deepEqual(await tierKeys(reader, 'rating-rascal'), ['scribbler'], 'CONTROL: earned');
    const announced = await posts(reader, 'rating-rascal');
    assert.equal(announced.length, 1, 'CONTROL: announced once');

    // Into an empty band, so the comparison session settles inside this one call and
    // `_rank_finalize` runs its delete and its insert in one transaction.
    await t.actAs(reader);
    await t.sql(`select rank_rebucket($1, 'fine', $2) as r`, [films[0], await uuid()]);
    await t.sql(`reset role`);

    assert.equal(await metric(reader, 'rating-rascal', 100), 100, 'still a hundred rankings');
    assert.deepEqual(
      await tierKeys(reader, 'rating-rascal'),
      ['scribbler'],
      'a band move is not a loss',
    );
    assert.equal(
      (await posts(reader, 'rating-rascal'))[0].id,
      announced[0].id,
      'and not a re-announcement',
    );
    assert.equal((await congrats(reader, 'rating-rascal')).length, 1, 'still exactly one congrats');
  });
  it('a removal and a re-addition in one transaction revoke nothing', async () => {
    const reader = await t.createUser({ username: 'rv_swap' });
    const seasons = await giveSeasons(reader, 15);
    const post = (await posts(reader, 'season-snacker'))[0].id;
    const replacement = await season();

    await t.sql(`begin`);
    await t.sql(`delete from user_media where user_id = $1 and media_item_id = $2`, [
      reader,
      seasons[0],
    ]);
    await t.sql(`insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`, [
      reader,
      replacement,
    ]);
    await t.sql(`commit`);

    assert.equal(await metric(reader, 'season-snacker', 15), 15, 'fifteen, all along');
    assert.deepEqual(await tierKeys(reader, 'season-snacker'), ['bronze']);
    assert.equal((await posts(reader, 'season-snacker'))[0].id, post, 'the same announcement');
  });

  it('a removal that ends below the line still revokes, however it was written', async () => {
    const reader = await t.createUser({ username: 'rv_two' });
    const seasons = await giveSeasons(reader, 16);

    await t.sql(`begin`);
    await t.sql(`delete from user_media where user_id = $1 and media_item_id = any($2)`, [
      reader,
      [seasons[0], seasons[1]],
    ]);
    await t.sql(`commit`);

    assert.equal(await metric(reader, 'season-snacker', 15), 14);
    assert.deepEqual(await tierKeys(reader, 'season-snacker'), []);
  });
});

// ---------------------------------------------------------------------------

describe('the permanent side of the boundary', () => {
  it('does not revoke a history track when its own count falls', async () => {
    // Comment Gremlin counts comments authored; deleting a comment does not un-write
    // it. Widening reversibility to a history track would be a different product
    // decision, and `award_tracks` is where it would have to be made.
    const author = await t.createUser({ username: 'rv_history' });
    await t.sql(
      `insert into award_unlocks (user_id, award_key, tier_key, value_at_unlock, announced)
       values ($1, 'comment-gremlin', 'whisper', 20, true)`,
      [author],
    );
    await t.sql(
      `insert into feed_events (actor_id, type, payload)
       values ($1, 'award_earned', jsonb_build_object(
         'award', 'comment-gremlin', 'tier', 'whisper',
         'award_name', 'Comment Gremlin', 'tier_label', 'Whisper'))`,
      [author],
    );

    assert.equal(await metric(author, 'comment-gremlin', 20), 0, 'CONTROL: nothing supports it');

    // A collection removal is exactly the event that fires the revocation triggers.
    const film = await movieWith({});
    await log(author, film);
    await t.actAs(author);
    await t.sql(`select unlog($1, $2) as r`, [await uuid(), film]);

    assert.deepEqual(await tierKeys(author, 'comment-gremlin'), ['whisper'], 'still earned');
    assert.equal((await posts(author, 'comment-gremlin')).length, 1, 'and still posted');
  });

  it('leaves Mutual Mania alone when a follow is dropped', async () => {
    const reader = await t.createUser({ username: 'rv_mutual' });
    const partners = [];
    for (let i = 0; i < 5; i += 1) {
      const p = await t.createUser({ username: `rv_mutual_p${i}` });
      await t.sql(
        `insert into follows (follower_id, followee_id, state, approved_at)
         values ($1, $2, 'approved', now()), ($2, $1, 'approved', now())`,
        [reader, p],
      );
      partners.push(p);
    }
    assert.deepEqual(await tierKeys(reader, 'mutual-mania'), ['hello'], 'CONTROL: earned');

    await t.sql(`delete from follows where follower_id = $1 and followee_id = $2`, [
      reader,
      partners[0],
    ]);

    assert.equal(await metric(reader, 'mutual-mania', 5), 4, 'the count really fell');
    assert.deepEqual(
      await tierKeys(reader, 'mutual-mania'),
      ['hello'],
      'and the badge stands: one person unfollowing must not delete another person’s award',
    );
  });
});

// ---------------------------------------------------------------------------

describe('deleting the account', () => {
  it('does not stall or fail on the cascade, and leaves nothing behind', async () => {
    // `delete_account` removes the auth user; profiles cascades, and user_media with
    // it. Every deleted row queues a deferred revocation, and each must exit at once on
    // a profile that is already gone rather than counting a collection nobody owns.
    const leaver = await t.createUser({ username: 'rv_leaver' });
    await giveSeasons(leaver, 15);
    assert.deepEqual(await tierKeys(leaver, 'season-snacker'), ['bronze'], 'CONTROL: earned');

    await t.actAs(leaver);
    // The confirmation is the username, which is what `delete_account` demands.
    const result = (await t.sql(`select delete_account('rv_leaver') as r`)).rows[0].r;
    assert.equal(result.status, 'ok');

    await t.sql(`reset role`);
    assert.equal((await t.sql(`select 1 from profiles where id = $1`, [leaver])).rows.length, 0);
    assert.equal((await unlocks(leaver, 'season-snacker')).length, 0, 'the ledger cascaded');
  });
});

// ---------------------------------------------------------------------------

describe('who can reach it', () => {
  it('lets no client role call the revocation', async () => {
    // A caller who could call this could strip anybody's awards by id — which is a
    // worse capability than the detector's, and the detector is already unreachable.
    const anyone = await t.createUser({ username: 'rv_probe' });

    const asAnon = await t.asAnon(() =>
      t.errorFrom(`select _award_revoke_unsupported($1, array['movie-muncher'])`, [anyone]),
    );
    assert.equal(asAnon?.code, '42501');

    const asAuthed = await t.asUser(anyone, () =>
      t.errorFrom(`select _award_revoke_unsupported($1, array['movie-muncher'])`, [anyone]),
    );
    assert.equal(asAuthed?.code, '42501');
  });

  it('lets no client role read the classification — the client has the source', async () => {
    const anyone = await t.createUser({ username: 'rv_reader' });

    assert.equal((await t.asAnon(() => t.errorFrom(`select * from award_tracks`)))?.code, '42501');
    assert.equal(
      (await t.asUser(anyone, () => t.errorFrom(`select * from award_tracks`)))?.code,
      '42501',
    );
  });
});

// ---------------------------------------------------------------------------

/**
 * **The claim-to-send window** — independent review 78, MAJOR.
 *
 * `push_outbox` cascading from the notification stops a *queued* push leaving the server.
 * It does not stop one the sender has already claimed: `claim_push_batch` hands over the
 * payload and leases the row for five minutes, and the sender is holding a copy of it
 * while it builds messages and talks to Expo. A revocation committing in that window
 * deletes a row nobody is reading any more.
 *
 * `live_push_jobs` is the sender's last look before it dispatches. What is left after it
 * is a payload already in flight to Apple or Google, which no call recalls.
 */
describe('a push claimed but not yet sent', () => {
  it('stops being live the moment the tier is revoked', async () => {
    const reader = await t.createUser({ username: 'rv_claimed' });
    await t.sql(
      `insert into device_tokens (user_id, token, platform) values ($1, 'rv_claimed_token', 'ios')`,
      [reader],
    );
    const seasons = await giveSeasons(reader, 15);

    const notification = (
      await t.sql(
        `select id from notifications where recipient_id = $1 and type = 'award_earned'`,
        [reader],
      )
    ).rows[0].id;

    // The sender claims it. The row is now leased, and the payload is in the sender's
    // hands — which is the state this test exists for.
    const claimed = (await t.sql(`select claim_push_batch(20) as jobs`)).rows[0].jobs;
    assert.equal(claimed.length, 1, 'fixture: the congratulations was claimed');
    assert.equal(claimed[0].notification_id, notification);
    assert.equal(
      (
        await t.sql(`select count(*)::int as n from push_outbox where notification_id = $1`, [
          notification,
        ])
      ).rows[0].n,
      1,
      'fixture: and the row is leased rather than gone',
    );

    const live = async () =>
      (await t.sql(`select live_push_jobs($1::uuid[]) as id`, [[notification]])).rows;

    assert.equal((await live()).length, 1, 'CONTROL: live before the removal');

    // The reader removes a title while the sender is mid-flight.
    await t.actAs(reader);
    await t.sql(`select unlog($1, $2) as r`, [await uuid(), seasons[0]]);
    await t.sql(`reset role`);

    assert.deepEqual(await tierKeys(reader, 'season-snacker'), [], 'the tier went');
    assert.equal(
      (await live()).length,
      0,
      'and the claimed job is no longer live, so the sender drops it before dispatch',
    );
  });

  it('answers only about the ids it was given, and only for service_role', async () => {
    const reader = await t.createUser({ username: 'rv_live_probe' });

    // It takes ids the caller already holds and returns nothing it was not asked about,
    // so it discloses no queue contents — but it is still service_role only, because a
    // client that could call it could test whether an arbitrary id is queued.
    assert.equal(
      (await t.asAnon(() => t.errorFrom(`select live_push_jobs(array[gen_random_uuid()])`)))?.code,
      '42501',
    );
    assert.equal(
      (
        await t.asUser(reader, () =>
          t.errorFrom(`select live_push_jobs(array[gen_random_uuid()])`),
        )
      )?.code,
      '42501',
    );

    assert.deepEqual(
      (await t.sql(`select live_push_jobs($1::uuid[]) as id`, [[]])).rows,
      [],
      'an empty request is an empty answer rather than the whole queue',
    );
  });
});
