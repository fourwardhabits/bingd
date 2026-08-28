import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * `dismiss_for_you` — 20260827000700.
 *
 * Founder tranche 2026-08-27 §12: a restrained X on the For You poster wall, whose
 * dismissal persists across refetch and relaunch. The table it writes
 * (`recommendation_feedback`, 20260813001000) existed for three days short of a
 * fortnight with no writer at all, so every property below is being exercised for the
 * first time through a client-reachable path.
 *
 * What carries the feature:
 *
 *   1. **One row, owner-scoped, kind `dismiss`.** The client subtracts the set from
 *      the slate; a second row for the same title would be noise it has to dedupe,
 *      and any other `kind` would be surface for an engine that does not exist.
 *   2. **Idempotent twice over** — by ledger (a retried tap replays) and by shape
 *      (two devices dismissing the same tile race into `on conflict do nothing`).
 *      Both matter separately, because they answer different failures.
 *   3. **It is about the wall, not the catalogue.** Dismissing a title must not
 *      touch rankings, the watchlist, or the collection — a dismissal is "stop
 *      recommending this", never "undo what I said about it".
 *   4. **The standard writer gates**: P0002 for a title that is not there, 42501 for
 *      anon and for a suspended account, and RLS that shows the caller only their
 *      own feedback.
 */

let t;
let alice;
let bob;
let seq = 95000;

const movie = (title) => t.createMovie(title, seq++);
const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

/** Dismisses as whoever actAs last named, defaulting the operation id to a fresh one. */
const dismiss = async (mediaItemId, operationId) => {
  const { rows } = await t.sql(`select dismiss_for_you($1, $2) as r`, [
    operationId ?? (await uuid()),
    mediaItemId,
  ]);
  return rows[0].r;
};

/** The feedback rows for one (user, title), read as the owner so RLS cannot hide them. */
const feedbackRows = async (userId, mediaItemId) => {
  const { rows } = await t.sql(
    `select kind from recommendation_feedback where user_id = $1 and media_item_id = $2`,
    [userId, mediaItemId],
  );
  return rows;
};

before(async () => {
  t = await createTestDb();
  alice = await t.createUser({ username: 'alice_rf' });
  bob = await t.createUser({ username: 'bob_rf' });
  await t.actAs(alice);
});

after(async () => t?.close());

// ---------------------------------------------------------------------------

describe('what a dismissal writes', () => {
  it('inserts exactly one row, kind dismiss, for the caller and the named title', async () => {
    const film = await movie('rf_first');

    const result = await dismiss(film);
    assert.equal(result.status, 'ok');

    const rows = await feedbackRows(alice, film);
    assert.equal(rows.length, 1, 'one row, not a log');
    assert.equal(rows[0].kind, 'dismiss', 'the only kind this writer is allowed to mint');

    // And for nobody else: owner-scoped means the row names the caller.
    assert.equal((await feedbackRows(bob, film)).length, 0);
  });

  it('answers a replayed operation id without writing a second row', async () => {
    // The ledger half of idempotence: a retried tap after a network wobble is the
    // same operation, and the answer is the past tense.
    const film = await movie('rf_replay');
    const operation = await uuid();

    assert.equal((await dismiss(film, operation)).status, 'ok');
    assert.equal((await dismiss(film, operation)).status, 'already_applied');

    assert.equal((await feedbackRows(alice, film)).length, 1);
  });

  it('accepts a fresh operation id for an already-dismissed title, and keeps one row', async () => {
    // The shape half: two devices each dismiss the same tile with their own ids.
    // Neither call is a replay, both asked for a state the table already holds, and
    // `on conflict do nothing` makes the second an ok rather than a 23505.
    const film = await movie('rf_again');

    assert.equal((await dismiss(film)).status, 'ok');
    assert.equal((await dismiss(film)).status, 'ok');

    assert.equal((await feedbackRows(alice, film)).length, 1);
  });

  it('refuses a title that does not exist, with P0002', async () => {
    // Named rather than left to the foreign key: the client maps SQLSTATEs, and a
    // bare 23503 would read as a server defect instead of "no such title".
    const error = await t.errorFrom(`select dismiss_for_you($1, $2)`, [
      await uuid(),
      await uuid(),
    ]);
    assert.equal(error?.code, 'P0002');
  });
});

// ---------------------------------------------------------------------------

describe('what a dismissal does not touch', () => {
  it('leaves the ranking, the watchlist and the collection exactly as they were', async () => {
    // The founder's line: this is about the wall, not the catalogue. A person who
    // ranked a film and queued it, then declined it as a recommendation, has
    // expressed three compatible opinions — losing either of the first two to the
    // third would be the writer overreaching.
    const film = await movie('rf_untouched');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    await t.sql(`select set_watchlist($1, $2, true)`, [await uuid(), film]);

    const snapshot = async () => {
      const { rows } = await t.sql(
        `select (select count(*)::int from rankings   where user_id = $1 and media_item_id = $2) as ranked,
                (select count(*)::int from watchlist  where user_id = $1 and media_item_id = $2) as queued,
                (select count(*)::int from user_media where user_id = $1 and media_item_id = $2) as logged`,
        [alice, film],
      );
      return rows[0];
    };

    const before = await snapshot();
    assert.equal(before.ranked, 1, 'CONTROL: the ranking exists to be endangered');
    assert.equal(before.queued, 1, 'CONTROL: so does the watchlist row');

    assert.equal((await dismiss(film)).status, 'ok');

    assert.deepEqual(await snapshot(), before, 'the dismissal wrote feedback and nothing else');
  });
});

// ---------------------------------------------------------------------------

describe('who may dismiss, and who may read it back', () => {
  it('shows the caller their own dismissals and nobody else’s', async () => {
    // `recommendation_feedback_own` (20260813001000) has never been exercised by a
    // client until now, because nothing could put a row behind it. The select-own
    // policy is what lets the app subtract the set from the slate on launch.
    const film = await movie('rf_rls');
    await dismiss(film);

    const mine = await t.asUser(alice, async () => {
      const { rows } = await t.sql(
        `select media_item_id, kind from recommendation_feedback where media_item_id = $1`,
        [film],
      );
      return rows;
    });
    assert.equal(mine.length, 1);
    assert.equal(mine[0].kind, 'dismiss');

    // Another signed-in account sees zero rows, not an error: RLS filters, and the
    // absence must not disclose that alice dismissed anything.
    const theirs = await t.asUser(bob, async () => {
      const { rows } = await t.sql(
        `select media_item_id from recommendation_feedback where media_item_id = $1`,
        [film],
      );
      return rows;
    });
    assert.equal(theirs.length, 0);
  });

  it('is not reachable by an unauthenticated caller at all', async () => {
    const film = await movie('rf_anon');

    const error = await t.asAnon(() =>
      t.errorFrom(`select dismiss_for_you(gen_random_uuid(), $1)`, [film]),
    );
    await t.actAs(alice);
    assert.equal(error?.code, '42501', 'anon must not hold EXECUTE on dismiss_for_you');
  });

  it('refuses a suspended account before anything is written', async () => {
    // assert_can_write runs first, so the refusal is the same 42501 every other
    // writer gives a suspended account — and the table stays empty for them.
    const film = await movie('rf_suspended');
    const banned = await t.createUser({ username: 'rf_banned' });
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [banned]);

    await t.actAs(banned);
    const error = await t.errorFrom(`select dismiss_for_you($1, $2)`, [await uuid(), film]);
    await t.actAs(alice);

    assert.equal(error?.code, '42501');
    assert.equal((await feedbackRows(banned, film)).length, 0);
  });
});
