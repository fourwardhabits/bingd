import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * A watchlist add is activity (20260820000300).
 *
 * Specification: founder Feed finalization 2026-08-20, items 3, 4, 5 and 6.
 *
 * The happy path — an add writes an event — is one assertion and the least
 * interesting thing here. What is worth a test is every way the rule could be wrong
 * without anybody noticing until a beta user's feed has two of something:
 *
 *   - a retry of the same operation, which the ledger must absorb,
 *   - a *second genuine call* with a fresh operation id, which the ledger cannot see
 *     and the partial unique index has to refuse,
 *   - a removal, which must not manufacture an add and must not delete the history,
 *   - watching the title, where `_leave_watchlist` deletes the row out from under the
 *     event and the event must survive it,
 *   - `unlog`, which deletes three other event types for the same title and must
 *     leave this one alone,
 *   - and the whole of it being visible to somebody who may not see the actor.
 */
describe('a watchlist add is activity', () => {
  let t;
  let owner;
  let follower;
  let stranger;

  before(async () => {
    t = await createTestDb();
    owner = await t.createUser({ username: 'owner' });
    follower = await t.createUser({ username: 'follower' });
    stranger = await t.createUser({ username: 'stranger' });
    await t.actAs(owner);
  });

  after(async () => t.close());

  const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

  const call = async (sql, params) => {
    const { rows } = await t.sql(`select ${sql} as result`, params);
    return rows[0].result;
  };

  /** Every add goes through the canonical writer. There is no other route. */
  const add = async (mediaItemId, operationId) =>
    call(`set_watchlist($1, $2, true)`, [operationId ?? (await uuid()), mediaItemId]);

  const remove = async (mediaItemId) =>
    call(`set_watchlist($1, $2, false)`, [await uuid(), mediaItemId]);

  const events = async (mediaItemId, actor = owner) => {
    const { rows } = await t.sql(
      `select id, type from feed_events
        where actor_id = $1 and media_item_id = $2 and type = 'watchlist_added'`,
      [actor, mediaItemId],
    );
    return rows;
  };

  const watchlisted = async (mediaItemId, forUser = owner) => {
    const { rows } = await t.sql(
      `select 1 from watchlist where user_id = $1 and media_item_id = $2`,
      [forUser, mediaItemId],
    );
    return rows.length === 1;
  };

  describe('the canonical add', () => {
    it('writes exactly one event, in the same transaction as the row', async () => {
      const film = await t.createMovie('Dune', 90001);
      await add(film);

      assert.equal(await watchlisted(film), true);
      assert.equal((await events(film)).length, 1);
    });

    it('writes no event for a removal', async () => {
      // A remove must not manufacture an "add". Obvious, and it is the shape of
      // mistake that a writer branching on the wrong variable produces.
      const film = await t.createMovie('Arrival', 90002);
      await remove(film);

      assert.equal(await watchlisted(film), false);
      assert.equal((await events(film)).length, 0);
    });

    it('writes nothing at all when the title does not exist', async () => {
      const missing = await uuid();
      const error = await t.errorFrom(`select set_watchlist($1, $2, true)`, [
        await uuid(),
        missing,
      ]);

      assert.ok(error, 'a title that does not exist must be refused');
      assert.equal((await events(missing)).length, 0);
    });

    it('accepts a whole series, which is the one collection write that does', async () => {
      // Reachable in the feed only through this event type, and the reason the row's
      // Recommend control has to keep its series guard.
      const show = await t.createSeries('Severance', 90003);
      await add(show);

      assert.equal((await events(show)).length, 1);
    });
  });

  describe('no duplicate activity', () => {
    it('absorbs a retry of the same operation', async () => {
      // The lost-response case `mustReconcile` exists for: the write committed and
      // the reply never arrived, so the client sends the identical operation again.
      const film = await t.createMovie('Sicario', 90004);
      const operation = await uuid();

      assert.equal((await add(film, operation)).status, 'ok');
      assert.equal((await add(film, operation)).status, 'already_applied');

      assert.equal((await events(film)).length, 1);
    });

    it('refuses a second event for a fresh operation id', async () => {
      // What the ledger cannot catch: a double tap on two devices, a reconciliation
      // that re-issues, a rerender that fires twice. Each is a genuinely new
      // operation, and only the partial unique index stands between them and a
      // duplicate row in somebody's feed.
      const film = await t.createMovie('Prisoners', 90005);
      await add(film);
      await add(film);
      await add(film);

      assert.equal((await events(film)).length, 1);
    });

    it('creates no second event when the same title is re-added after a remove', async () => {
      // The founder's beta rule: one durable event per (person, title). The re-add
      // restores the row and inherits the original activity, whose reactions and
      // comments are the reason it is the one that lasts.
      const film = await t.createMovie('Enemy', 90006);
      await add(film);
      const [first] = await events(film);

      await remove(film);
      await add(film);

      const after = await events(film);
      assert.equal(after.length, 1);
      assert.equal(after[0].id, first.id, 'the original event must be the survivor');
      assert.equal(await watchlisted(film), true);
    });

    it('leaves other event types free to repeat', async () => {
      // The index is partial on purpose. `_rank_finalize` writes a new title_ranked
      // on every rerank and rebucket, and 20260817001100 reads the latest of many.
      const film = await t.createMovie('Blade Runner 2049', 90007);
      await t.sql(
        `insert into feed_events (actor_id, type, media_item_id)
         values ($1, 'title_ranked', $2), ($1, 'title_ranked', $2)`,
        [owner, film],
      );

      const { rows } = await t.sql(
        `select 1 from feed_events where actor_id = $1 and media_item_id = $2
          and type = 'title_ranked'`,
        [owner, film],
      );
      assert.equal(rows.length, 2);
    });
  });

  describe('the event outlives the row', () => {
    it('survives the user removing the title from their watchlist', async () => {
      // "Added" is a past-tense fact and stays true. Deleting the event would take
      // other people's reactions and comments with it through the cascade —
      // destroying a conversation because its subject changed their mind.
      const film = await t.createMovie('Nightcrawler', 90008);
      await add(film);
      await remove(film);

      assert.equal(await watchlisted(film), false);
      assert.equal((await events(film)).length, 1);
    });

    it('survives the user watching the title, which deletes the row itself', async () => {
      // `_leave_watchlist` (20260815040000) removes the entry the moment the title is
      // logged. The founder named this case: the activity must not disappear because
      // the person did the thing it was about.
      const film = await t.createMovie('Whiplash', 90009);
      await add(film);
      await call(`log_watched($1, $2, '2026-08-01', null)`, [await uuid(), film]);

      assert.equal(await watchlisted(film), false);
      assert.equal((await events(film)).length, 1);
    });

    it('survives unlog, which takes the three collection-state events with it', async () => {
      // 20260818000100 deletes title_ranked, title_logged and season_completed
      // because each asserts the title is in the collection and removal makes that
      // false. "Added it to their watchlist" is not a claim about the collection, so
      // it is deliberately not on that list — the same line that migration drew for
      // list_added.
      const film = await t.createMovie('Sinners', 90010);
      await add(film);
      await call(`log_watched($1, $2, '2026-08-01', null)`, [await uuid(), film]);

      const logged = await t.sql(
        `select 1 from feed_events where actor_id = $1 and media_item_id = $2
          and type = 'title_logged'`,
        [owner, film],
      );

      await call(`unlog($1, $2)`, [await uuid(), film]);

      const survivors = await t.sql(
        `select type from feed_events where actor_id = $1 and media_item_id = $2`,
        [owner, film],
      );
      assert.deepEqual(
        survivors.rows.map((row) => row.type),
        ['watchlist_added'],
        `unlog removed ${logged.rows.length} collection event(s) and must leave the watchlist one`,
      );
    });
  });

  describe('privacy', () => {
    it('is readable by somebody who may see the actor', async () => {
      const film = await t.createMovie('Past Lives', 90011);
      await add(film);

      const visible = await t.asUser(follower, async () => {
        const { rows } = await t.sql(
          `select 1 from feed_events where actor_id = $1 and type = 'watchlist_added'`,
          [owner],
        );
        return rows.length > 0;
      });
      assert.equal(visible, true, 'a public actor’s activity is readable');
    });

    it('is invisible across a block, in either direction', async () => {
      // `feed_events_read` is can_view_profile(auth.uid(), actor_id), which returns
      // false across a block. The event inherits that rather than restating it, which
      // is the whole reason nothing was added to the read path.
      const film = await t.createMovie('Aftersun', 90012);
      await add(film);
      await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [
        owner,
        stranger,
      ]);

      const seen = await t.asUser(stranger, async () => {
        const { rows } = await t.sql(
          `select 1 from feed_events where actor_id = $1 and media_item_id = $2`,
          [owner, film],
        );
        return rows.length;
      });
      assert.equal(seen, 0, 'a blocked account must gain no new oracle');
    });

    it('is invisible on a private account the viewer does not follow', async () => {
      const shy = await t.createUser({ username: 'shy', visibility: 'private' });
      const film = await t.createMovie('Perfect Days', 90013);

      await t.actAs(shy);
      await add(film);
      await t.actAs(owner);

      const seen = await t.asUser(stranger, async () => {
        const { rows } = await t.sql(
          `select 1 from feed_events where actor_id = $1 and media_item_id = $2`,
          [shy, film],
        );
        return rows.length;
      });
      assert.equal(seen, 0);

      // And the watchlist row behind it is hidden by the same answer, so the feed
      // discloses nothing the table would not (20260820000200).
      const rowSeen = await t.asUser(stranger, async () => {
        const { rows } = await t.sql(`select 1 from watchlist where user_id = $1`, [shy]);
        return rows.length;
      });
      assert.equal(rowSeen, 0);
    });

    it('cannot be forged: there is no client insert on feed_events', async () => {
      // The alternative architecture, refused. If a client could write its own feed
      // row then privacy would be the only thing between a forged activity and a
      // follower's feed, rather than the second line of defence.
      const film = await t.createMovie('Anatomy of a Fall', 90014);
      const error = await t.asUser(stranger, () =>
        t.errorFrom(
          `insert into feed_events (actor_id, type, media_item_id)
           values ($1, 'watchlist_added', $2)`,
          [stranger, film],
        ),
      );
      assert.ok(error, 'feed_events has no insert policy and must deny by default');
    });
  });

  describe('reactions and comments work on it generically', () => {
    it('takes a comment and a reaction like any other activity', async () => {
      // Nothing in `add_comment` or `set_reaction` reads `feed_events.type`: both
      // resolve existence and visibility in one query keyed on the event id. This is
      // the assertion that says so, rather than a claim in a comment.
      // `asUser` restores the *role* and not the claims, so the identity of whichever
      // policy test ran last is still in `request.jwt.claims`. Said here rather than
      // left implicit: without this the add below is written as `stranger` and the
      // lookup two lines down finds nothing, which reads as a broken writer.
      await t.actAs(owner);

      const film = await t.createMovie('Challengers', 90015);
      await add(film);
      const [activity] = await events(film);

      await t.actAs(follower);
      await call(`add_comment($1, $2, 'want to watch that too', false)`, [
        await uuid(),
        activity.id,
      ]);
      await call(`set_reaction($1, $2, 'love')`, [await uuid(), activity.id]);
      await t.actAs(owner);

      const { rows: comments } = await t.sql(
        `select 1 from comments where feed_event_id = $1`,
        [activity.id],
      );
      const { rows: reactions } = await t.sql(
        `select 1 from reactions where feed_event_id = $1`,
        [activity.id],
      );
      assert.equal(comments.length, 1);
      assert.equal(reactions.length, 1);
    });
  });
});
