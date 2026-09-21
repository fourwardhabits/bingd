import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb, one } from './harness.mjs';

/**
 * `20261014000100` — the #196 founder-QA pass.
 *
 *   1. Goals load on the new client (the relationship the goal read embeds across).
 *   2. A viewing carries its own note and companions, privately.
 *   3. A historical feed post keeps its own viewing's score.
 */

let t;
let user;
let friend;
let stranger;
let seq = 0;

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

beforeEach(async () => {
  seq += 1;
  user = await t.createUser({ username: `wd_user_${seq}` });
  friend = await t.createUser({ username: `wd_friend_${seq}` });
  stranger = await t.createUser({ username: `wd_stranger_${seq}` });
  // A mutual follow is the tagging rule's precondition.
  await t.sql(
    `insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved'), ($2, $1, 'approved')`,
    [user, friend],
  );
  await t.actAs(user);
});

const movie = (title) => t.createMovie(title, (seq += 1) + 7_300_000);
const op = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
const call = async (sql, params) => (await t.sql(`select ${sql} as r`, params)).rows[0].r;

const finish = async (step, subject) => {
  let current = step;
  let guard = 0;
  while (!current.done) {
    current = await one(t.db, `select rank_answer($1, $2, $3) as r`, [
      current.session_id,
      subject,
      await op(),
    ]);
    if ((guard += 1) > 32) throw new Error('did not converge');
  }
  return current;
};

const anchors = async (n, bucket) => {
  for (let i = 0; i < n; i += 1) {
    const film = await movie(`Anchor ${bucket} ${i} ${seq}`);
    await t.rankToCompletion(film, bucket, async (pivot) => pivot);
  }
};

// ---------------------------------------------------------------------------
// 1. The goal read's embed
// ---------------------------------------------------------------------------

describe('the relationship the goal read embeds across', () => {
  it('exists: watch_events has a foreign key to media_items', async () => {
    const { rows } = await t.sql(
      `select 1 from pg_constraint c
        where c.contype = 'f'
          and c.conrelid = 'public.watch_events'::regclass
          and c.confrelid = 'public.media_items'::regclass`,
    );
    // Without it PostgREST answers `watch_events?select=…,media_items!inner(…)` with
    // PGRST200, and the new client's goals read "Could not load your goals".
    assert.equal(rows.length, 1);
  });

  it('is indexed on the referencing side, so deleting a title does not scan every viewing', async () => {
    const { rows } = await t.sql(
      `select indexdef from pg_indexes
        where tablename = 'watch_events' and indexname = 'watch_events_media_item'`,
    );
    assert.equal(rows.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 2. A viewing's own details
// ---------------------------------------------------------------------------

describe('a viewing with its own details', () => {
  const logAgain = async (film, note, companions) =>
    call(`log_rewatch_with_details($1, $2, current_date, 'today_default', $3, $4)`, [
      await op(),
      film,
      note,
      companions,
    ]);

  const details = async (eventId) => {
    const note = (await t.sql(`select note from watch_events where id = $1`, [eventId])).rows[0]
      ?.note;
    const companions = (
      await t.sql(
        `select companion_id from watch_event_companions where watch_event_id = $1 order by 1`,
        [eventId],
      )
    ).rows.map((r) => r.companion_id);
    return { note, companions };
  };

  it('saves the note and companions on the new viewing, in one call', async () => {
    const film = await movie('With friends');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);

    const result = await logAgain(film, '  Better on the big screen  ', [friend]);
    assert.equal(result.status, 'ok');

    assert.deepEqual(await details(result.watch_event_id), {
      note: 'Better on the big screen',
      companions: [friend],
    });
  });

  it('leaves the title-level note exactly where it was', async () => {
    const film = await movie('A review stays a review');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    await t.sql(`update user_media set note = 'The review' where user_id = $1 and media_item_id = $2`, [
      user,
      film,
    ]);

    await logAgain(film, 'A diary line', []);

    const um = (
      await t.sql(`select note from user_media where user_id = $1 and media_item_id = $2`, [user, film])
    ).rows[0];
    assert.equal(um.note, 'The review', 'a viewing note overwrote the review');
  });

  it('refuses a companion who is not a mutual follow, and saves nothing', async () => {
    const film = await movie('Not a friend');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    const before = (
      await t.sql(`select count(*)::int as n from watch_events where user_id = $1 and media_item_id = $2`, [
        user,
        film,
      ])
    ).rows[0].n;

    await assert.rejects(() => logAgain(film, null, [stranger]), /follow you back/);
    const afterCount = (
      await t.sql(`select count(*)::int as n from watch_events where user_id = $1 and media_item_id = $2`, [
        user,
        film,
      ])
    ).rows[0].n;
    // One transaction: a refused companion list does not leave a half-saved viewing.
    assert.equal(afterCount, before);
  });

  it('refuses a note over 1,000 characters', async () => {
    const film = await movie('Long note');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    await assert.rejects(() => logAgain(film, 'x'.repeat(1001), []));
  });

  it('is private: nobody else can read the note or the companions — not even the companion', async () => {
    const film = await movie('Private diary');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    const { watch_event_id: eventId } = await logAgain(film, 'Just for me', [friend]);

    for (const other of [friend, stranger]) {
      const events = await t.asUser(other, async () =>
        (await t.sql(`select id from watch_events where id = $1`, [eventId])).rows,
      );
      const companions = await t.asUser(other, async () =>
        (await t.sql(`select 1 from watch_event_companions where watch_event_id = $1`, [eventId]))
          .rows,
      );
      assert.equal(events.length, 0, 'another account read the viewing');
      assert.equal(companions.length, 0, 'another account read the companions');
    }
    const own = await t.asUser(user, async () =>
      (await t.sql(`select companion_id from watch_event_companions where watch_event_id = $1`, [eventId]))
        .rows,
    );
    assert.equal(own.length, 1, 'the owner cannot read their own companions');
  });

  it('answers a replay with the same viewing, and does not duplicate it', async () => {
    const film = await movie('Replayed');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    const id = await op();

    const first = await call(
      `log_rewatch_with_details($1, $2, current_date, 'today_default', 'Once', $3)`,
      [id, film, [friend]],
    );
    const again = await call(
      `log_rewatch_with_details($1, $2, current_date, 'today_default', 'Once', $3)`,
      [id, film, [friend]],
    );
    assert.equal(again.watch_event_id, first.watch_event_id);
    const count = (
      await t.sql(`select count(*)::int as n from watch_events where user_id = $1 and media_item_id = $2`, [
        user,
        film,
      ])
    ).rows[0].n;
    assert.equal(count, 2, 'the replay logged a third viewing');
  });

  it('edits one viewing from the pencil: replace, clear, or leave the companions', async () => {
    const film = await movie('Edited');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    const { watch_event_id: eventId } = await logAgain(film, 'First draft', [friend]);

    // Null companions: note changes, companions stay.
    await call(`set_watch_details($1, $2, $3, null)`, [await op(), eventId, 'Second draft']);
    assert.deepEqual(await details(eventId), { note: 'Second draft', companions: [friend] });

    // An empty array clears; a blank note clears.
    await call(`set_watch_details($1, $2, $3, $4)`, [await op(), eventId, '   ', []]);
    assert.deepEqual(await details(eventId), { note: null, companions: [] });
  });

  it('refuses an edit to somebody else’s viewing', async () => {
    const film = await movie('Not yours');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    const { watch_event_id: eventId } = await logAgain(film, 'Mine', []);

    await t.actAs(stranger);
    const hijack = await op();
    await assert.rejects(
      () => call(`set_watch_details($1, $2, 'hijack', null)`, [hijack, eventId]),
      /no such watch/,
    );
    await t.actAs(user);
    assert.equal((await details(eventId)).note, 'Mine');
  });
});

// ---------------------------------------------------------------------------
// 3. Each post keeps its own viewing's score
// ---------------------------------------------------------------------------

describe('a historical feed post keeps its own viewing’s score', () => {
  const posts = async (item) =>
    (
      await t.sql(
        `select id, payload from feed_events
          where actor_id = $1 and media_item_id = $2 and type = 'title_ranked'
          order by created_at, id`,
        [user, item],
      )
    ).rows;

  const scores = async (ids, viewer = user) =>
    t.asUser(viewer, async () =>
      (await t.sql(`select * from feed_watch_scores($1)`, [ids])).rows,
    );

  const liveScore = async (item) =>
    Number(
      (
        await t.sql(`select score from ranking_placements where user_id = $1 and media_item_id = $2
                      order by created_at desc limit 1`, [user, item])
      ).rows[0].score,
    );

  it('keeps watch 1 at its score and watch 2 at its own after a re-rank', async () => {
    await anchors(3, 'loved');
    await anchors(3, 'fine');
    const film = await movie('Heat');
    await t.rankToCompletion(film, 'fine', async (pivot) => pivot);
    const firstScore = await liveScore(film);

    const logged = await call(`log_rewatch($1, $2, current_date, 'today_default')`, [await op(), film]);
    await finish(
      await one(t.db, `select rank_again($1, 'loved', $2, true, $3) as r`, [
        film,
        await op(),
        logged.watch_event_id,
      ]),
      film,
    );
    const secondScore = await liveScore(film);
    assert.notEqual(secondScore, firstScore, 'the fixture did not move the score');

    const [firstPost, secondPost] = await posts(film);
    const rows = await scores([firstPost.id, secondPost.id]);
    const byId = new Map(rows.map((r) => [r.event_id, r]));

    assert.equal(Number(byId.get(firstPost.id).score), firstScore, 'watch 1 took the new score');
    // The latest viewing is not frozen: it keeps the live score the client already drew.
    assert.equal(byId.get(secondPost.id).score, null, 'the latest viewing was frozen');
    assert.equal(byId.get(secondPost.id).bucket, null);
    assert.equal(secondScore > 0, true);
    assert.equal(byId.get(secondPost.id).watch_number, 2, 'the rewatch is not the 2nd watch');
    // No position or movement leaves the function.
    assert.deepEqual(Object.keys(rows[0]).sort(), ['bucket', 'event_id', 'score', 'watch_number']);
  });

  it('lets a correction amend the latest viewing, never the one before', async () => {
    await anchors(3, 'loved');
    await anchors(3, 'fine');
    const film = await movie('Corrected after the rewatch');
    await t.rankToCompletion(film, 'fine', async (pivot) => pivot);
    const firstScore = await liveScore(film);

    const logged = await call(`log_rewatch($1, $2, current_date, 'today_default')`, [await op(), film]);
    await finish(
      await one(t.db, `select rank_again($1, 'fine', $2, true, $3) as r`, [
        film,
        await op(),
        logged.watch_event_id,
      ]),
      film,
    );
    // Update your rating — no new viewing — into another band.
    await finish(
      await one(t.db, `select rank_rebucket($1, 'loved', $2) as r`, [film, await op()]),
      film,
    );
    const corrected = await liveScore(film);

    const [firstPost, secondPost] = await posts(film);
    const byId = new Map((await scores([firstPost.id, secondPost.id])).map((r) => [r.event_id, r]));
    assert.equal(Number(byId.get(firstPost.id).score), firstScore, 'the correction reached watch 1');
    // Watch 2 is the latest viewing, so it reads live — which is the corrected score.
    assert.equal(byId.get(secondPost.id).score, null);
    assert.ok(corrected > 0);
  });

  it('returns nothing for a single-viewing title — its live score is its score', async () => {
    const film = await movie('Seen once');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    const [post] = await posts(film);
    assert.deepEqual(await scores([post.id]), []);
  });

  it('shows another account nothing for a post it cannot see', async () => {
    await t.sql(`update profiles set visibility = 'private' where id = $1`, [user]);
    await anchors(2, 'loved');
    const film = await movie('Private rewatch');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    await call(`log_rewatch($1, $2, current_date, 'today_default')`, [await op(), film]);

    const ids = (await posts(film)).map((p) => p.id);
    assert.deepEqual(await scores(ids, stranger), []);
    assert.ok((await scores(ids, user)).length > 0, 'the owner lost their own scores');
  });

  it('refuses more than fifty ids', async () => {
    const ids = await Promise.all(Array.from({ length: 51 }, () => op()));
    await assert.rejects(() => scores(ids), /at most 50/);
  });
});
