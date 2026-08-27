import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb, one } from './harness.mjs';

/**
 * A recommendation that hears back (20260827000600).
 *
 * The contract under test: when a recipient first reaches a completed RANKED state
 * for a title somebody recommended to them, each outstanding *delivered*
 * recommendation is fulfilled — once, ever — and each sender the feed itself would
 * answer receives one `recommendation_ranked` notification pointing at the exact
 * `title_ranked` feed event.
 *
 * The negative space is most of the file, because it is most of the design: a log is
 * not a rank, a Rank Again is not a first rank, a replay is not a second event, a
 * pending request is not a delivered recommendation, and a sender who cannot see the
 * ranking is not told about it.
 */

let t;
/** The recipient who ranks things. */
let suraj;
/** Two recommenders, mutual with suraj — the ordinary case. */
let abisola;
let ravi;
let seq = 70000;

const movie = (title) => t.createMovie(title, seq++);
const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

const follow = (a, b) =>
  t.sql(`insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`, [
    a,
    b,
  ]);

const mutual = async (a, b) => {
  await follow(a, b);
  await follow(b, a);
};

/** A send, performed as the sender. Returns recommend_title's own answer. */
const recommend = (sender, recipient, mediaItemId) =>
  t.asUser(sender, async () => {
    const { rows } = await t.sql(`select recommend_title($1, $2, $3) as r`, [
      await uuid(),
      recipient,
      mediaItemId,
    ]);
    return rows[0].r;
  });

/** Ranks to completion as the given user, answering every comparison "the new one". */
const rankAs = (userId, mediaItemId, bucket = 'fine') =>
  t.asUser(userId, () => t.rankToCompletion(mediaItemId, bucket, (_pivot, item) => item));

/** A provisional re-rank to completion, same answer policy. */
const finishSession = async (result, mediaItemId) => {
  let guard = 0;
  while (!result.done) {
    result = await one(t.db, `select rank_answer($1, $2) as r`, [result.session_id, mediaItemId]);
    if (++guard > 64) throw new Error('the session did not converge');
  }
  return result;
};

const rankAgainAs = (userId, mediaItemId, bucket = 'fine', newWatch = false) =>
  t.asUser(userId, async () => {
    const started = await one(t.db, `select rank_again($1, $2::taste_bucket, $3, $4) as r`, [
      mediaItemId,
      bucket,
      await uuid(),
      newWatch,
    ]);
    return finishSession(started, mediaItemId);
  });

const recommendationRow = async (sender, recipient, mediaItemId) => {
  const { rows } = await t.sql(
    `select id, state, fulfilled_at from title_recommendations
      where sender_id = $1 and recipient_id = $2 and media_item_id = $3`,
    [sender, recipient, mediaItemId],
  );
  return rows[0] ?? null;
};

/** The fulfilment notifications for one specific recommendation. */
const fulfillmentsFor = async (sender, recipient, mediaItemId) => {
  const rec = await recommendationRow(sender, recipient, mediaItemId);
  if (!rec) return [];
  const { rows } = await t.sql(
    `select id, recipient_id, actor_id, subject_type, subject_id, payload from notifications
      where type = 'recommendation_ranked'
        and (payload ->> 'recommendation_id')::uuid = $1
      order by created_at`,
    [rec.id],
  );
  return rows;
};

const allFulfillmentsTo = async (recipient) => {
  const { rows } = await t.sql(
    `select id from notifications where recipient_id = $1 and type = 'recommendation_ranked'`,
    [recipient],
  );
  return rows;
};

const rankedEventOf = async (actor, mediaItemId) => {
  const { rows } = await t.sql(
    `select id from feed_events
      where actor_id = $1 and media_item_id = $2 and type = 'title_ranked'
      order by created_at desc`,
    [actor, mediaItemId],
  );
  return rows[0]?.id ?? null;
};

before(async () => {
  t = await createTestDb();
  suraj = await t.createUser({ username: 'ff_suraj' });
  abisola = await t.createUser({ username: 'ff_abisola' });
  ravi = await t.createUser({ username: 'ff_ravi' });
  await mutual(suraj, abisola);
  await mutual(suraj, ravi);
  await t.sql(
    `update app_config set value = '1000'::jsonb where key like 'recommendations.max_per_%'`,
  );
});

after(async () => {
  await t?.close();
});

// ---------------------------------------------------------------------------

describe('a first ranking fulfils', () => {
  it('files exactly one notification, pointing at the exact ranking event', async () => {
    const film = await movie('The Martian FF');
    await recommend(abisola, suraj, film);
    assert.equal((await fulfillmentsFor(abisola, suraj, film)).length, 0, 'notified early');

    await rankAs(suraj, film);

    const rows = await fulfillmentsFor(abisola, suraj, film);
    assert.equal(rows.length, 1, 'expected exactly one fulfilment');
    assert.equal(rows[0].recipient_id, abisola, 'the recommender is the recipient');
    assert.equal(rows[0].actor_id, suraj, 'the ranker is the actor');
    assert.ok(
      (await recommendationRow(abisola, suraj, film)).fulfilled_at,
      'the recommendation row was not marked fulfilled',
    );

    // The founder's explicit requirement: the exact Feed post — not the title page,
    // not the profile, not the top of the Feed.
    assert.equal(rows[0].subject_type, 'feed_event');
    assert.equal(rows[0].subject_id, await rankedEventOf(suraj, film));
  });

  it('never notifies the ranker about their own rank', async () => {
    assert.equal((await allFulfillmentsTo(suraj)).length, 0);
  });

  it('is push-eligible, and the claim resolves the title through the ranker, not the recipient', async () => {
    const film = await movie('Push Fulfilment FF');
    await recommend(abisola, suraj, film);
    await t.asUser(abisola, async () =>
      t.sql(`select register_device_token($1, 'ExponentPushToken[ffffffffffffffffffff1]', 'ios')`, [
        await uuid(),
      ]),
    );
    await rankAs(suraj, film);

    const [notif] = await fulfillmentsFor(abisola, suraj, film);
    const { rows: queued } = await t.sql(
      `select notification_id from push_outbox where notification_id = $1`,
      [notif.id],
    );
    assert.ok(queued[0], 'the fulfilment was not queued for push');

    const jobs = (await t.sql(`select claim_push_batch(50) as jobs`)).rows[0].jobs;
    const job = jobs.find((j) => j.notification_id === notif.id);
    assert.ok(job, 'claim_push_batch did not carry the fulfilment');
    assert.equal(job.type, 'recommendation_ranked');
    assert.equal(job.media_title, 'Push Fulfilment FF');
    assert.equal(job.feed_event_id, notif.subject_id);
    // Nothing written rides along: no excerpt, no note, no score.
    assert.equal(job.comment_excerpt ?? null, null);
  });

  it('resolves the title for the recommender in my_notifications the same way', async () => {
    const film = await movie('Inbox Fulfilment FF');
    await recommend(abisola, suraj, film);
    await rankAs(suraj, film);

    const rows = await t.asUser(abisola, async () => {
      const { rows: r } = await t.sql(`select * from my_notifications(100)`);
      return r;
    });
    const row = rows.find(
      (r) => r.kind === 'recommendation_ranked' && r.media_title === 'Inbox Fulfilment FF',
    );
    assert.ok(row, 'the recommender cannot see the fulfilment with its title resolved');
    assert.equal(row.subject_type, 'feed_event');
    assert.ok(row.subject_id, 'the inbox row lost the event it should open');
    assert.equal(row.actor_username, 'ff_suraj');
  });
});

// ---------------------------------------------------------------------------

describe('once means once', () => {
  it('a Rank Again notifies nobody a second time, another watch included', async () => {
    const film = await movie('Rank Again FF');
    await recommend(abisola, suraj, film);
    await rankAs(suraj, film);
    assert.equal((await fulfillmentsFor(abisola, suraj, film)).length, 1);

    await rankAgainAs(suraj, film);
    await rankAgainAs(suraj, film, 'fine', true); // another watch posts a feed event...
    assert.equal(
      (await fulfillmentsFor(abisola, suraj, film)).length,
      1,
      '...but fulfils nothing: the recommendation was answered the first time',
    );
  });

  it('a bucket change notifies nobody', async () => {
    const film = await movie('Rebucket FF');
    await recommend(abisola, suraj, film);
    await rankAs(suraj, film);

    await t.asUser(suraj, async () => {
      const started = await one(t.db, `select rank_rebucket($1, 'not_for_me', $2) as r`, [
        film,
        await uuid(),
      ]);
      await finishSession(started, film);
    });

    assert.equal((await fulfillmentsFor(abisola, suraj, film)).length, 1);
  });

  it('a replayed operation returns its prior answer and files nothing new', async () => {
    const film = await movie('Replay FF');
    await recommend(abisola, suraj, film);

    const op = await uuid();
    await t.asUser(suraj, async () => {
      // 'loved' with nothing loved yet: the band is empty, so this finalises at once —
      // and the retry below is the lost-response case, verbatim.
      await one(t.db, `select rank_start($1, 'loved', $2) as r`, [film, op]);
      await one(t.db, `select rank_start($1, 'loved', $2) as r`, [film, op]);
    });

    assert.equal((await fulfillmentsFor(abisola, suraj, film)).length, 1);
  });

  it('the backstop index refuses a second notification for one recommendation outright', async () => {
    const film = await movie('Backstop FF');
    await recommend(abisola, suraj, film);
    await rankAs(suraj, film);
    const rec = await recommendationRow(abisola, suraj, film);

    const error = await t.errorFrom(
      `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
       values ($1, 'recommendation_ranked', $2, 'feed_event', gen_random_uuid(),
               jsonb_build_object('recommendation_id', $3::uuid))`,
      [abisola, suraj, rec.id],
    );
    assert.equal(error?.code, '23505', 'a duplicate fulfilment notification was accepted');
  });
});

// ---------------------------------------------------------------------------

describe('what does not fulfil', () => {
  it('a log without a rank', async () => {
    const film = await movie('Logged Only FF');
    await recommend(abisola, suraj, film);
    await t.asUser(suraj, async () => t.sql(`select log_watched($1, $2)`, [await uuid(), film]));

    assert.equal((await fulfillmentsFor(abisola, suraj, film)).length, 0);
    assert.equal((await recommendationRow(abisola, suraj, film)).fulfilled_at, null);
  });

  it('a watchlist add', async () => {
    const film = await movie('Watchlisted FF');
    await recommend(abisola, suraj, film);
    await t.asUser(suraj, async () =>
      t.sql(`select set_watchlist($1, $2, true)`, [await uuid(), film]),
    );

    assert.equal((await fulfillmentsFor(abisola, suraj, film)).length, 0);
    assert.equal((await recommendationRow(abisola, suraj, film)).fulfilled_at, null);
  });

  it('an abandoned ranking session', async () => {
    const film = await movie('Abandoned FF');
    await recommend(abisola, suraj, film);

    await t.asUser(suraj, async () => {
      const started = await one(t.db, `select rank_start($1, 'fine') as r`, [film]);
      assert.ok(started.session_id, 'fixture: the session should need answers');
      // The sheet is closed. Nothing is finalised.
    });

    assert.equal((await fulfillmentsFor(abisola, suraj, film)).length, 0);
    assert.equal((await recommendationRow(abisola, suraj, film)).fulfilled_at, null);
  });

  it('a recommendation that arrived after the rank — no retroactive credit', async () => {
    const film = await movie('Already Ranked FF');
    await rankAs(suraj, film);
    const sent = await recommend(abisola, suraj, film);
    assert.equal(sent.status, 'ok', 'the current contract allows recommending a ranked title');

    assert.equal((await fulfillmentsFor(abisola, suraj, film)).length, 0);
    assert.equal((await recommendationRow(abisola, suraj, film)).fulfilled_at, null);

    // And a later correction still is not a first ranking.
    await rankAgainAs(suraj, film, 'fine', true);
    assert.equal((await fulfillmentsFor(abisola, suraj, film)).length, 0);
  });

  it('unless the recipient unranks and genuinely ranks again — a new first ranking', async () => {
    const film = await movie('Unranked Then Ranked FF');
    await rankAs(suraj, film);
    await recommend(abisola, suraj, film);

    await t.asUser(suraj, async () => t.sql(`select rank_unrank($1)`, [film]));
    await rankAs(suraj, film);

    // The recommendation preceded the qualifying rank, which is the invariant.
    assert.equal((await fulfillmentsFor(abisola, suraj, film)).length, 1);
  });

  it('a pending request the recipient never accepted', async () => {
    const carol = await t.createUser({ username: 'ff_carol' });
    // One-way: carol may send (she follows suraj), but suraj does not follow her
    // back, so the recommendation is held as a request.
    await follow(carol, suraj);
    const film = await movie('Held Request FF');
    const sent = await recommend(carol, suraj, film);
    assert.equal(sent.delivered, false, 'fixture: this should be a held request');

    await rankAs(suraj, film);

    assert.equal((await allFulfillmentsTo(carol)).length, 0, 'a held request fulfilled');
    const rec = await recommendationRow(carol, suraj, film);
    assert.equal(rec.state, 'pending');
    assert.equal(rec.fulfilled_at, null);

    // Accepting it afterwards delivers a recommendation for a ranked title, which
    // simply never fulfils: it did not precede the ranking.
    await t.asUser(suraj, async () => t.sql(`select add_recommendation($1)`, [rec.id]));
    assert.equal((await allFulfillmentsTo(carol)).length, 0);
  });
});

// ---------------------------------------------------------------------------

describe('several recommenders', () => {
  it('each outstanding recommender receives their own single notification', async () => {
    const film = await movie('Two Senders FF');
    await recommend(abisola, suraj, film);
    await recommend(ravi, suraj, film);

    await rankAs(suraj, film);

    const toAbisola = await fulfillmentsFor(abisola, suraj, film);
    const toRavi = await fulfillmentsFor(ravi, suraj, film);
    assert.equal(toAbisola.length, 1);
    assert.equal(toRavi.length, 1);
    assert.equal(toAbisola[0].recipient_id, abisola);
    assert.equal(toRavi[0].recipient_id, ravi);
    // Both point at the same event, because there was one rank.
    assert.equal(toAbisola[0].subject_id, toRavi[0].subject_id);
  });
});

// ---------------------------------------------------------------------------

describe('who is not told', () => {
  it('a blocked recommender: the row is consumed silently', async () => {
    const dana = await t.createUser({ username: 'ff_dana' });
    await mutual(suraj, dana);
    const film = await movie('Blocked Sender FF');
    await recommend(dana, suraj, film);

    await t.asUser(suraj, async () => t.sql(`select block($1, $2)`, [await uuid(), dana]));
    await rankAs(suraj, film);

    assert.equal((await allFulfillmentsTo(dana)).length, 0, 'a blocked sender was told');
    const rec = await recommendationRow(dana, suraj, film);
    assert.ok(rec, 'fixture: block() should leave a delivered recommendation in place');
    assert.ok(
      rec.fulfilled_at,
      'the row must still be consumed, or unblocking would fire a stale notification later',
    );
  });

  it('a sender who can no longer see a private ranker', async () => {
    const noor = await t.createUser({ username: 'ff_noor' });
    const erin = await t.createUser({ username: 'ff_erin' });
    await t.sql(`update profiles set visibility = 'private' where id = $1`, [noor]);
    await mutual(erin, noor);

    const film = await movie('Private Ranker FF');
    const sent = await recommend(erin, noor, film);
    assert.equal(sent.delivered, true, 'fixture: mutual, so delivered');

    // Erin walks away before noor ranks. The feed would now show her nothing.
    await t.sql(`delete from follows where follower_id = $1 and followee_id = $2`, [erin, noor]);

    await rankAs(noor, film);

    assert.equal(
      (await allFulfillmentsTo(erin)).length,
      0,
      'a notification told a sender about a ranking the feed would not show them',
    );
    assert.ok((await recommendationRow(erin, noor, film)).fulfilled_at, 'still consumed');
  });

  it('a recommender who switched the recommendations conversation off', async () => {
    const femi = await t.createUser({ username: 'ff_femi' });
    await mutual(suraj, femi);
    await t.asUser(femi, async () =>
      t.sql(`select set_notification_preference('recommendations', false)`),
    );

    const film = await movie('Muted Category FF');
    await recommend(femi, suraj, film);
    await rankAs(suraj, film);

    assert.equal((await allFulfillmentsTo(femi)).length, 0, 'the preference gate was bypassed');
    assert.ok(
      (await recommendationRow(femi, suraj, film)).fulfilled_at,
      'suppression must still consume the row',
    );
  });
});
