import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb, createTestDbBefore } from './harness.mjs';

/**
 * The award-unlock ledger — 20260828000100.
 *
 * The transition "user X newly earned tier Y" is detected by AFTER triggers on the
 * eight fact tables and recorded in `award_unlocks`, exactly once, ever. A new unlock
 * announces the HIGHEST tier crossed in that call: one `award_earned` feed event
 * (social tracks only — Hype Courier's count is withheld from visitors, so its
 * crossing must not be posted) and one actorless congratulations notification to the
 * earner. Lower tiers crossed in the same call go on the ledger quietly.
 *
 * What is pinned here, in order of what it would cost to lose:
 *
 *   1. **Below the threshold, silence.** Four mutuals produce no row anywhere.
 *   2. **At the threshold, exactly one of each** — unlock, feed post, congrats — with
 *      a payload that names the award and tier and *nothing else*. The payload is the
 *      public surface of the unlock; a fifth key is a privacy regression.
 *   3. **Replays and recomputes change nothing.** The detector may run any number of
 *      times after the crossing; the ledger absorbs all of them.
 *   4. **A span crossed in one call announces once**, at the top. The skipped tiers
 *      are history (`announced = false`), not spam.
 *   5. **The rollout backfill announces nobody.** Pre-existing progress goes on the
 *      ledger quietly, and only genuine post-migration crossings post.
 *   6. **The metrics agree with tracks.ts** — the genre vocabulary, the season
 *      inheritance, the language and date edge cases, the two-screen cap.
 *   7. **An award post is an ordinary activity**: visible by `can_i_view`, commentable,
 *      reactable, and NOT deleted when the earner unlogs a title — it has no media.
 *
 * Mutual Mania (bronze at 5) and Invite Instigator (bronze at 3) carry most of the
 * crossings because they are the cheapest facts to construct, and both go through the
 * REAL triggers: `award_on_follow` fires on direct inserts of approved edges, and
 * `award_on_invite_activation` on the UPDATE that sets `activated_at`.
 *
 * The exactly-once claim under true concurrency lives in
 * `concurrency/races/award-unlock.mjs`; PGlite is one connection and cannot express
 * two transactions. What this file covers of that invariant is the backstops: the
 * partial unique indexes must refuse a duplicate announcement outright.
 */

const MIGRATION = '20260828000100_an_award_that_says_so.sql';

let t;
let seq = 970000;

const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

/** An approved mutual, written directly — `award_on_follow` fires on direct inserts. */
const mutual = (a, b) =>
  t.sql(
    `insert into follows (follower_id, followee_id, state, approved_at)
     values ($1, $2, 'approved', now()), ($2, $1, 'approved', now())`,
    [a, b],
  );

/** `n` fresh accounts, each mutually following `who` — the cheapest metric there is. */
const giveMutuals = async (who, n, tag) => {
  const partners = [];
  for (let i = 0; i < n; i += 1) {
    const p = await t.createUser({ username: `${tag}_p${i}` });
    await mutual(who, p);
    partners.push(p);
  }
  return partners;
};

const unlocks = async (user, award) =>
  (
    await t.sql(
      `select tier_key, announced, value_at_unlock::int as value from award_unlocks
        where user_id = $1 and award_key = $2 order by earned_at, tier_key`,
      [user, award],
    )
  ).rows;

const awardPosts = async (user) =>
  (
    await t.sql(
      `select id, media_item_id, payload from feed_events
        where actor_id = $1 and type = 'award_earned' order by created_at`,
      [user],
    )
  ).rows;

const congrats = async (user) =>
  (
    await t.sql(
      `select actor_id, payload from notifications
        where recipient_id = $1 and type = 'award_earned' order by created_at`,
      [user],
    )
  ).rows;

const metric = async (user, award, threshold) =>
  Number(
    (await t.sql(`select _award_metric($1, $2, $3) as m`, [user, award, threshold])).rows[0].m,
  );

/** A movie with the metadata the metric under test reads. */
const movieWith = async ({ genres = [], lang = null, release = null } = {}) => {
  const id = await t.createMovie(`award_fixture_${seq}`, seq++);
  await t.sql(
    `update media_items set genres = $2, original_language = $3, release_date = $4 where id = $1`,
    [id, genres, lang, release],
  );
  return id;
};

const log = (user, mediaItemId) =>
  t.sql(
    `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`,
    [user, mediaItemId],
  );

before(async () => {
  t = await createTestDb();
});

after(async () => t?.close());

// ---------------------------------------------------------------------------

describe('crossing a threshold', () => {
  it('four mutuals: no unlock, no feed event, no congratulations', async () => {
    const shy = await t.createUser({ username: 'aw_shy' });
    await giveMutuals(shy, 4, 'aw_shy');

    assert.equal(await metric(shy, 'mutual-mania', 5), 4, 'CONTROL: the count is real');
    assert.equal((await unlocks(shy, 'mutual-mania')).length, 0);
    assert.equal((await awardPosts(shy)).length, 0);
    assert.equal((await congrats(shy)).length, 0);
  });

  it('the fifth mutual announces bronze: one unlock, one post, one congratulations', async () => {
    const earner = await t.createUser({ username: 'aw_earner' });
    const partners = await giveMutuals(earner, 5, 'aw_earner');

    const rows = await unlocks(earner, 'mutual-mania');
    assert.equal(rows.length, 1, 'exactly one ledger row');
    assert.equal(rows[0].tier_key, 'hello');
    assert.equal(rows[0].announced, true, 'this row produced the announcement');
    assert.equal(rows[0].value, 5, 'the metric at the moment of unlock, for the record');

    const posts = await awardPosts(earner);
    assert.equal(posts.length, 1, 'exactly one feed post');
    assert.equal(posts[0].media_item_id, null, 'an award is not about a title');
    assert.deepEqual(
      posts[0].payload,
      { award: 'mutual-mania', tier: 'hello', award_name: 'Mutual Mania', tier_label: 'Hello' },
      'the payload names the award and tier and nothing else',
    );

    const inbox = await congrats(earner);
    assert.equal(inbox.length, 1, 'exactly one congratulations');
    assert.equal(inbox[0].actor_id, null, 'actorless — nobody did this to them');
    assert.deepEqual(inbox[0].payload, posts[0].payload, 'the same four keys, and only those');

    // The five partners each hold ONE mutual. The trigger ran for both parties of
    // every approval — that is its design — and correctly moved only the earner.
    for (const p of partners) {
      assert.equal((await unlocks(p, 'mutual-mania')).length, 0);
      assert.equal((await awardPosts(p)).length, 0);
    }
  });

  it('when the fifth mutual is the fifth for BOTH parties, each earns their own', async () => {
    // Both sides of one approval crossing together is exactly why this is a trigger
    // and not a caller-scoped hook — the qualifying action is somebody else's.
    const left = await t.createUser({ username: 'aw_left' });
    const right = await t.createUser({ username: 'aw_right' });
    await giveMutuals(left, 4, 'aw_left');
    await giveMutuals(right, 4, 'aw_right');

    await mutual(left, right);

    for (const who of [left, right]) {
      assert.equal((await unlocks(who, 'mutual-mania')).length, 1);
      assert.equal((await awardPosts(who)).length, 1, 'one post each, under their own name');
      assert.equal((await congrats(who)).length, 1);
    }
  });
});

// ---------------------------------------------------------------------------

describe('replay and recompute', () => {
  let steady;

  before(async () => {
    steady = await t.createUser({ username: 'aw_steady' });
    await giveMutuals(steady, 5, 'aw_steady');
  });

  it('running the detector again for an earned award changes nothing', async () => {
    const snapshot = async () => ({
      unlocks: (await unlocks(steady, 'mutual-mania')).length,
      posts: (await awardPosts(steady)).length,
      inbox: (await congrats(steady)).length,
    });

    const before = await snapshot();
    assert.deepEqual(before, { unlocks: 1, posts: 1, inbox: 1 }, 'CONTROL: bronze is earned');

    await t.sql(`select _maybe_award_unlocks($1, array['mutual-mania'])`, [steady]);
    await t.sql(`select _maybe_award_unlocks($1, array['mutual-mania'])`, [steady]);

    assert.deepEqual(await snapshot(), before, 'the ledger absorbed both recomputes');
  });

  it('a sixth mutual, below silver, announces nothing new', async () => {
    await giveMutuals(steady, 1, 'aw_sixth');

    assert.equal(await metric(steady, 'mutual-mania', 5), 6);
    assert.equal((await unlocks(steady, 'mutual-mania')).length, 1, 'still bronze only');
    assert.equal((await awardPosts(steady)).length, 1);
    assert.equal((await congrats(steady)).length, 1);
  });

  it('the backstop indexes refuse a duplicate announcement outright', async () => {
    // The mechanism is the award_unlocks insert; these are the restatement a future
    // writer cannot miss. Both must answer a duplicate with 23505, not a second row.
    const [post] = await awardPosts(steady);

    const feedDupe = await t.errorFrom(
      `insert into feed_events (actor_id, type, payload) values ($1, 'award_earned', $2)`,
      [steady, post.payload],
    );
    assert.equal(feedDupe?.code, '23505', 'feed_events_one_award_post holds');

    const inboxDupe = await t.errorFrom(
      `insert into notifications (recipient_id, type, payload) values ($1, 'award_earned', $2)`,
      [steady, post.payload],
    );
    assert.equal(inboxDupe?.code, '23505', 'notifications_one_award_congrats holds');
  });
});

// ---------------------------------------------------------------------------

describe('a span of tiers', () => {
  let inviter;

  it('milestones reached one action at a time each announce once: bronze at 3, silver at 15', async () => {
    inviter = await t.createUser({ username: 'aw_inviter' });

    // Fifteen accepted attributions, activated one by one — the UPDATE is what
    // `award_on_invite_activation` watches, and it is the invitee's action, not the
    // inviter's, which is the case that makes server-side detection non-optional.
    const invitees = [];
    for (let i = 0; i < 15; i += 1) {
      const invitee = await t.createUser({ username: `aw_invitee${i}` });
      await t.sql(
        `insert into invite_attributions (invitee_id, inviter_id, accepted_at) values ($1, $2, now())`,
        [invitee, inviter],
      );
      invitees.push(invitee);
    }

    for (let i = 0; i < 15; i += 1) {
      await t.sql(`update invite_attributions set activated_at = now() where invitee_id = $1`, [
        invitees[i],
      ]);

      const posts = await awardPosts(inviter);
      if (i < 2) assert.equal(posts.length, 0, `no post at ${i + 1} activations`);
      else if (i < 14) assert.equal(posts.length, 1, `bronze only, at ${i + 1} activations`);
    }

    const rows = await unlocks(inviter, 'invite-instigator');
    assert.deepEqual(
      rows.map((r) => [r.tier_key, r.announced]),
      [
        ['bronze', true],
        ['silver', true],
      ],
      'each milestone was its own crossing, so each announced',
    );

    const posts = await awardPosts(inviter);
    assert.equal(posts.length, 2, 'one post per distinct milestone, ever');
    assert.deepEqual(
      posts.map((p) => p.payload.tier),
      ['bronze', 'silver'],
    );
    assert.equal((await congrats(inviter)).length, 2);
  });

  it('the payload of an Invite Instigator post names no invitee — the four keys and nothing more', async () => {
    // 20260827001100 made the COUNT public achievement data; the invitees, tokens and
    // timestamps stayed private. The payload is where that boundary would leak.
    const posts = await awardPosts(inviter);
    const inbox = await congrats(inviter);
    assert.equal(posts.length, 2, 'CONTROL: the posts from the previous test');

    for (const { payload } of [...posts, ...inbox]) {
      assert.deepEqual(
        Object.keys(payload).sort(),
        ['award', 'award_name', 'tier', 'tier_label'],
        'no invitee id, token or timestamp rides along',
      );
      assert.equal(payload.award, 'invite-instigator');
      assert.equal(payload.award_name, 'Invite Instigator');
    }
  });

  it('two tiers crossed in ONE call announce only the highest; the skipped tier is quiet history', async () => {
    // The metric jumps past bronze and silver between detector runs. Constructing
    // that honestly needs the trigger out of the way while the facts accumulate —
    // the shape of a backfill gap or a long-offline device syncing at once.
    const burst = await t.createUser({ username: 'aw_burst' });

    await t.sql(`alter table follows disable trigger award_on_follow`);
    try {
      await giveMutuals(burst, 24, 'aw_burst');
    } finally {
      await t.sql(`alter table follows enable trigger award_on_follow`);
    }

    // The 25th mutual arrives through the live trigger: one call, metric 25, and
    // both bronze (5) and silver (25) are newly crossed.
    await giveMutuals(burst, 1, 'aw_burst25');

    const rows = await unlocks(burst, 'mutual-mania');
    assert.deepEqual(
      rows.map((r) => [r.tier_key, r.announced]).sort(),
      [
        ['hello', false],
        ['inner-circle', true],
      ],
      'bronze is recorded, silver is announced — the ledger keeps both, the feed one',
    );

    const posts = await awardPosts(burst);
    assert.equal(posts.length, 1, 'one breath, one post');
    assert.deepEqual(posts[0].payload, {
      award: 'mutual-mania',
      tier: 'inner-circle',
      award_name: 'Mutual Mania',
      tier_label: 'Inner Circle',
    });
    assert.equal((await congrats(burst)).length, 1);
  });
});

// ---------------------------------------------------------------------------

describe('Hype Courier stays off the feed', () => {
  it('earning it files the congratulations and posts nothing', async () => {
    // The one track marked social = false: the product refuses to show a visitor
    // this count, so a public post would disclose the crossing of it.
    const courier = await t.createUser({ username: 'aw_courier' });
    const friend = await t.createUser({ username: 'aw_courier_friend' });

    for (let i = 0; i < 25; i += 1) {
      const film = await movieWith({});
      await t.sql(
        `insert into title_recommendations (sender_id, recipient_id, media_item_id)
         values ($1, $2, $3)`,
        [courier, friend, film],
      );
    }

    const rows = await unlocks(courier, 'hype-courier');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tier_key, 'nudge');
    // `announced` marks the row that produced the announcement, and for this track
    // the announcement is the private congratulations alone.
    assert.equal(rows[0].announced, true);

    assert.equal((await awardPosts(courier)).length, 0, 'no feed post, by design');

    const inbox = await congrats(courier);
    assert.equal(inbox.length, 1, 'the earner is still congratulated');
    assert.deepEqual(inbox[0].payload, {
      award: 'hype-courier',
      tier: 'nudge',
      award_name: 'Hype Courier',
      tier_label: 'Nudge',
    });
  });
});

// ---------------------------------------------------------------------------

describe('the metrics agree with tracks.ts', () => {
  it('classifies genres by the seeded vocabulary, with the season inheritance', async () => {
    const viewer = await t.createUser({ username: 'aw_genres' });

    for (const genres of [
      ['Horror'], //            \yhorror\y
      ['Slasher Film'], //      \yslasher\y — Horror by synonym
      ['romantic comedy'], //   Romance AND Comedy, one title each
      ['animated film'], //     \yanimat(ed)\y
      ['Anime'], //             lowered first, then matched
      ['Sword and Sorcery'], // Fantasy by synonym
      ['warfare'], //           must NOT match \ywar\y — no word boundary inside
      ['Western'],
    ]) {
      await log(viewer, await movieWith({ genres }));
    }

    // A season with no genres of its own borrows the series'; one with its own
    // does not — media-metadata.ts's rule, reproduced by _award_effective_genres.
    const spooky = await t.createSeries('aw_spooky_show', seq++);
    await t.sql(`update media_items set genres = '{Horror}' where id = $1`, [spooky]);
    await log(viewer, await t.createSeason(spooky, 1, 'Season 1'));

    const funny = await t.createSeries('aw_funny_show', seq++);
    await t.sql(`update media_items set genres = '{Horror}' where id = $1`, [funny]);
    const ownVoice = await t.createSeason(funny, 1, 'Season 1');
    await t.sql(`update media_items set genres = '{Comedy}' where id = $1`, [ownVoice]);
    await log(viewer, ownVoice);

    assert.equal(await metric(viewer, 'scream-snack', 25), 3, 'Horror + Slasher + inherited season');
    assert.equal(await metric(viewer, 'lol-mode', 25), 2, 'romantic comedy + the season with its own voice');
    assert.equal(await metric(viewer, 'softie-hours', 25), 1, 'Romance reaches Drama-or-Romance');
    assert.equal(await metric(viewer, 'toon-bloom', 20), 2, 'animated film + Anime');
    assert.equal(await metric(viewer, 'boom-club', 25), 0);
    assert.equal(
      await metric(viewer, 'genre-gremlin', 14),
      6,
      'Horror, Comedy, Romance, Animation, Fantasy, Western — and warfare matched nothing',
    );
  });

  it('passport-mode counts non-English, with the season inheriting the series language', async () => {
    const traveler = await t.createUser({ username: 'aw_passport' });

    await log(traveler, await movieWith({ lang: 'ja' }));
    await log(traveler, await movieWith({ lang: 'en' }));
    await log(traveler, await movieWith({ lang: null }));
    await log(traveler, await movieWith({ lang: '  ' })); // trimmed empty is missing, not foreign

    const show = await t.createSeries('aw_korean_show', seq++);
    await t.sql(`update media_items set original_language = 'ko' where id = $1`, [show]);
    await log(traveler, await t.createSeason(show, 1, 'Season 1'));

    assert.equal(await metric(traveler, 'passport-mode', 15), 2, 'ja + the inherited ko');
  });

  it('time-hopper counts releases before 2000 and stays silent on missing dates', async () => {
    const hopper = await t.createUser({ username: 'aw_hopper' });

    await log(hopper, await movieWith({ release: '1999-01-01' }));
    await log(hopper, await movieWith({ release: '2000-01-01' }));
    await log(hopper, await movieWith({ release: null }));

    assert.equal(await metric(hopper, 'time-hopper', 25), 1);
  });

  it('two-screen-life caps each side at half the tier threshold', async () => {
    const twoScreens = await t.createUser({ username: 'aw_twoscreen' });

    for (let i = 0; i < 20; i += 1) await log(twoScreens, await movieWith({}));
    const show = await t.createSeries('aw_twoscreen_show', seq++);
    for (const n of [1, 2]) await log(twoScreens, await t.createSeason(show, n, `Season ${n}`));

    assert.equal(
      await metric(twoScreens, 'two-screen-life', 30),
      17,
      'min(20, 15) + min(2, 15): the lopsided collection cannot buy the tier on movies alone',
    );
  });
});

// ---------------------------------------------------------------------------

describe('an award post is an ordinary activity', () => {
  let hermit; // private account with bronze Mutual Mania
  let confidant; // one of the mutuals — an approved follower
  let stranger;
  let postId;

  before(async () => {
    hermit = await t.createUser({ username: 'aw_hermit', visibility: 'private' });
    [confidant] = await giveMutuals(hermit, 5, 'aw_hermit');
    stranger = await t.createUser({ username: 'aw_stranger' });
    [{ id: postId }] = await awardPosts(hermit);
    assert.ok(postId, 'CONTROL: the private account earned bronze');
  });

  const canSee = (viewer) =>
    t.asUser(viewer, async () => {
      const { rows } = await t.sql(`select 1 from feed_events where id = $1`, [postId]);
      return rows.length === 1;
    });

  it("obeys feed_events_read: a private account's award post is for approved followers only", async () => {
    assert.equal(await canSee(confidant), true, 'an approved follower sees the post');
    assert.equal(await canSee(stranger), false, 'a stranger sees nothing — not an error, nothing');
  });

  it('is invisible to somebody the earner blocked', async () => {
    const outcast = await t.createUser({ username: 'aw_outcast' });
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [hermit, outcast]);
    assert.equal(await canSee(outcast), false);
  });

  it('takes comments and reactions through the real writers', async () => {
    // Nothing in add_comment or set_reaction reads the event type — that is the
    // migration's claim, exercised through a viewer who genuinely can see the post.
    const comment = await t.asUser(confidant, async () =>
      (
        await t.sql(`select add_comment($1, $2, $3) as r`, [
          await uuid(),
          postId,
          'the people person award!',
        ])
      ).rows[0].r,
    );
    assert.equal(comment.status, 'ok');

    const reaction = await t.asUser(confidant, async () =>
      (
        await t.sql(`select set_reaction($1, $2, 'love') as r`, [await uuid(), postId])
      ).rows[0].r,
    );
    assert.equal(reaction.status, 'ok');
  });

  it('survives the earner unlogging a title — an award has no media to take it with', async () => {
    const film = await movieWith({});
    await log(hermit, film);
    await t.sql(
      `insert into feed_events (actor_id, type, media_item_id) values ($1, 'title_logged', $2)`,
      [hermit, film],
    );

    await t.actAs(hermit);
    const result = (await t.sql(`select unlog($1, $2) as r`, [await uuid(), film])).rows[0].r;
    assert.equal(result.status, 'ok');

    const gone = await t.sql(
      `select 1 from feed_events where actor_id = $1 and media_item_id = $2`,
      [hermit, film],
    );
    assert.equal(gone.rows.length, 0, 'CONTROL: unlog took the title activity');
    assert.equal((await awardPosts(hermit)).length, 1, 'and left the award standing');
  });
});

// ---------------------------------------------------------------------------

describe('who can reach what', () => {
  it('no client role may call the detector: a caller who could would be probing counts', async () => {
    const anyone = await t.createUser({ username: 'aw_probe' });

    const asAnon = await t.asAnon(() =>
      t.errorFrom(`select _maybe_award_unlocks($1, array['mutual-mania'])`, [anyone]),
    );
    assert.equal(asAnon?.code, '42501');

    const asAuthed = await t.asUser(anyone, () =>
      t.errorFrom(`select _maybe_award_unlocks($1, array['mutual-mania'])`, [anyone]),
    );
    assert.equal(asAuthed?.code, '42501');
  });

  it('the seed tables are internal — the client has the source', async () => {
    const reader = await t.createUser({ username: 'aw_reader' });
    for (const table of ['award_tiers', 'award_genre_patterns']) {
      const error = await t.asUser(reader, () => t.errorFrom(`select * from ${table}`));
      assert.equal(error?.code, '42501', `${table} is not client-readable`);
    }
  });

  it('the ledger shows the owner their own rows and nobody else anything', async () => {
    const owner = await t.createUser({ username: 'aw_owner' });
    const passerby = await t.createUser({ username: 'aw_passerby' });
    await giveMutuals(owner, 5, 'aw_owner');

    const mine = await t.asUser(owner, async () =>
      (await t.sql(`select award_key from award_unlocks where user_id = $1`, [owner])).rows,
    );
    assert.equal(mine.length, 1, 'the owner reads their unlock');

    const theirs = await t.asUser(passerby, async () =>
      (await t.sql(`select award_key from award_unlocks where user_id = $1`, [owner])).rows,
    );
    assert.equal(theirs.length, 0, 'filtered, not refused — absence discloses nothing');
  });
});

// ---------------------------------------------------------------------------

/**
 * The rollout, against a database that actually had progress in it.
 *
 * `createTestDb` reloads a snapshot in which every migration has already run, so the
 * backfill has necessarily executed against an empty database — a guaranteed no-op.
 * This is the one shape in which "existing accounts do not spam the feed on deploy"
 * can fail, so it is built the long way.
 */
describe('the rollout backfill', () => {
  let t2;

  after(async () => t2?.close());

  it('records earned history quietly, and only genuine new crossings announce', async () => {
    t2 = await createTestDbBefore(MIGRATION);

    const veteran = await t2.createUser({ username: 'aw_veteran' });

    // Four mutuals — one short of bronze — and three fully activated invites, all
    // facts that predate the ledger's existence.
    const partners = [];
    for (let i = 0; i < 4; i += 1) {
      const p = await t2.createUser({ username: `aw_vet_p${i}` });
      await t2.sql(
        `insert into follows (follower_id, followee_id, state, approved_at)
         values ($1, $2, 'approved', now()), ($2, $1, 'approved', now())`,
        [veteran, p],
      );
      partners.push(p);
    }
    for (let i = 0; i < 3; i += 1) {
      const invitee = await t2.createUser({ username: `aw_vet_i${i}` });
      await t2.sql(
        `insert into invite_attributions (invitee_id, inviter_id, accepted_at, activated_at)
         values ($1, $2, now(), now())`,
        [invitee, veteran],
      );
    }

    await t2.applyMigration(MIGRATION);

    const backfilled = (
      await t2.sql(
        `select award_key, tier_key, announced, value_at_unlock::int as value
           from award_unlocks where user_id = $1 order by award_key`,
        [veteran],
      )
    ).rows;
    assert.deepEqual(
      backfilled,
      [{ award_key: 'invite-instigator', tier_key: 'bronze', announced: false, value: 3 }],
      'the earned tier is on the ledger, quietly; four mutuals earned nothing',
    );

    const posts = await t2.sql(`select 1 from feed_events where type = 'award_earned'`);
    assert.equal(posts.rows.length, 0, 'the deploy posted nothing for anybody');
    const inbox = await t2.sql(`select 1 from notifications where type = 'award_earned'`);
    assert.equal(inbox.rows.length, 0, 'and congratulated nobody');

    // The fifth mutual arrives AFTER the migration — a genuine crossing, and the
    // first thing this account does announce.
    const fifth = await t2.createUser({ username: 'aw_vet_p4' });
    await t2.sql(
      `insert into follows (follower_id, followee_id, state, approved_at)
       values ($1, $2, 'approved', now()), ($2, $1, 'approved', now())`,
      [veteran, fifth],
    );

    const fresh = (
      await t2.sql(
        `select tier_key, announced from award_unlocks
          where user_id = $1 and award_key = 'mutual-mania'`,
        [veteran],
      )
    ).rows;
    assert.deepEqual(fresh, [{ tier_key: 'hello', announced: true }]);

    const newPosts = (
      await t2.sql(
        `select payload from feed_events where actor_id = $1 and type = 'award_earned'`,
        [veteran],
      )
    ).rows;
    assert.equal(newPosts.length, 1, 'exactly one post, for exactly the new crossing');
    assert.deepEqual(newPosts[0].payload, {
      award: 'mutual-mania',
      tier: 'hello',
      award_name: 'Mutual Mania',
      tier_label: 'Hello',
    });

    const newInbox = (
      await t2.sql(
        `select actor_id from notifications where recipient_id = $1 and type = 'award_earned'`,
        [veteran],
      )
    ).rows;
    assert.equal(newInbox.length, 1);
    assert.equal(newInbox[0].actor_id, null);

    // The backfilled invite bronze did not announce retroactively either.
    const inviteRows = (
      await t2.sql(
        `select announced from award_unlocks
          where user_id = $1 and award_key = 'invite-instigator'`,
        [veteran],
      )
    ).rows;
    assert.deepEqual(inviteRows, [{ announced: false }]);
  });
});
