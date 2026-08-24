import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb, one } from './harness.mjs';

/**
 * The production data contract for a ranked title (`20260825000200`).
 *
 * `ranking.test.mjs` owns the engine — bands, positions, the bisection — and asserts
 * I1 to I3 after every mutation. This file owns the three properties that migration
 * added on top of it, which are about *repeating* a call rather than about making one:
 *
 *   I5  a retried ranking mutation applies exactly once: no second movement, no second
 *       feed event, no second comparison, no second invite activation
 *   I6  Rank Again is atomic — one call, and a failure leaves the old position standing
 *   I8  clearing a watch date does not un-log a title that has another watch signal
 *
 * plus the two contracts the same migration settled: a season needs no completion
 * before it can be ranked (TV-1), and an open comparison session cannot outlive the
 * collection row it is placing.
 *
 * **Why replay is tested against observables rather than against row counts alone.**
 * `lib/operation-intent.ts` records the sharper form of the question: almost every RPC
 * in this schema assigns or replaces, so "can a replay store a duplicate row" is
 * answered no by functions with no idempotency at all. The test that bites is *does a
 * replay change any observable* — which for ranking means the position, the score, the
 * feed, the comparison history and the one-shot activation flag.
 */

let t;
let user;
let seq = 0;

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

beforeEach(async () => {
  seq += 1;
  user = await t.createUser({ username: `contract_${seq}` });
  await t.actAs(user);
});

const movie = (title) => t.createMovie(title, (seq += 1) + 90000);

const op = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

const rankingRows = async (item) =>
  (
    await t.sql(
      `select bucket, position, category from rankings
        where user_id = $1 and media_item_id = $2`,
      [user, item],
    )
  ).rows;

const collectionRow = async (item) =>
  (
    await t.sql(
      `select bucket, watched_on, progress, note from user_media
        where user_id = $1 and media_item_id = $2`,
      [user, item],
    )
  ).rows[0] ?? null;

const feedEvents = async (item, type = 'title_ranked') =>
  (
    await t.sql(
      `select payload from feed_events
        where actor_id = $1 and media_item_id = $2 and type = $3`,
      [user, item, type],
    )
  ).rows;

const comparisonCount = async () =>
  Number(
    (await t.sql(`select count(*)::int as n from comparisons where user_id = $1`, [user])).rows[0].n,
  );

const sessionsFor = async (item) =>
  (
    await t.sql(
      `select id, bucket, lo, hi, pivot, skips from ranking_sessions
        where user_id = $1 and media_item_id = $2`,
      [user, item],
    )
  ).rows;

// ---------------------------------------------------------------------------

describe('I5: a replayed ranking mutation applies exactly once', () => {
  it('rank_start replayed returns the first answer and places nothing twice', async () => {
    const film = await movie('Replayed start');
    const id = await op();

    const first = await one(t.db, `select rank_start($1, 'loved', $2) as r`, [film, id]);
    const replay = await one(t.db, `select rank_start($1, 'loved', $2) as r`, [film, id]);

    assert.equal(first.done, true, 'an empty band places outright');
    assert.deepEqual(replay, first, 'the replay is answered with the stored result');
    assert.equal((await rankingRows(film)).length, 1);
    assert.equal((await feedEvents(film)).length, 1, 'one title_ranked event, not two');
    await t.assertValid(user);
  });

  it('rank_start replayed does not open a second session', async () => {
    // The other branch of the same function: a non-empty band answers with a session
    // rather than a placement, and a replay must hand back the *same* session id. A
    // fresh one would leave an orphan the unique constraint would then refuse.
    await one(t.db, `select rank_start($1, 'loved') as r`, [await movie('Anchor')]);

    const film = await movie('Replayed session');
    const id = await op();

    const first = await one(t.db, `select rank_start($1, 'loved', $2) as r`, [film, id]);
    const replay = await one(t.db, `select rank_start($1, 'loved', $2) as r`, [film, id]);

    assert.equal(first.done, false);
    assert.equal(replay.session_id, first.session_id);
    assert.equal((await sessionsFor(film)).length, 1);
  });

  /**
   * The scenario the whole tranche is shaped around.
   *
   * `rank_answer` records a comparison and, on the last one, finalises: it writes the
   * `rankings` row, the score and the `feed_events` entry, all in one transaction. So an
   * answer that commits and loses its HTTP reply is a title that *is* placed, reported
   * to the reader as a failure, over a control they will press again.
   *
   * Before this migration the second press was a second genuine answer. Now it is
   * recognised, and what comes back is what the lost reply said.
   */
  it('rank_answer replayed after finalising returns the placement, not a second one', async () => {
    const anchor = await movie('Answer anchor');
    await one(t.db, `select rank_start($1, 'loved') as r`, [anchor]);

    const film = await movie('Replayed answer');
    const started = await one(t.db, `select rank_start($1, 'loved') as r`, [film]);
    assert.equal(started.done, false, 'a second title in the band needs a comparison');

    const comparisonsBefore = await comparisonCount();
    const id = await op();

    const placed = await one(t.db, `select rank_answer($1, $2, $3) as r`, [
      started.session_id,
      film,
      id,
    ]);
    assert.equal(placed.done, true, 'a band of one is decided by a single comparison');

    const replay = await one(t.db, `select rank_answer($1, $2, $3) as r`, [
      started.session_id,
      film,
      id,
    ]);

    assert.deepEqual(replay, placed, 'the same position, score and activation flag');
    assert.equal((await rankingRows(film)).length, 1, 'one ranking');
    assert.equal((await feedEvents(film)).length, 1, 'one title_ranked event');
    assert.equal(
      await comparisonCount(),
      comparisonsBefore + 1,
      'one comparison recorded, not two — a replay is not a second judgement',
    );
    await t.assertValid(user);
  });

  it('rank_answer replayed mid-session does not narrow the range twice', async () => {
    // The non-finalising branch. A replay that re-ran would move `lo`/`hi` a second time
    // and push a duplicate frame onto the history, so Back would step through a
    // comparison the reader never saw.
    for (let i = 0; i < 4; i += 1) {
      await t.rankToCompletion(await movie(`Mid anchor ${i}`), 'loved', async (pivot) => pivot);
    }

    const film = await movie('Mid session replay');
    const started = await one(t.db, `select rank_start($1, 'loved') as r`, [film]);
    assert.equal(started.done, false);

    const id = await op();
    const answered = await one(t.db, `select rank_answer($1, $2, $3) as r`, [
      started.session_id,
      started.pivot,
      id,
    ]);
    assert.equal(answered.done, false, 'the band is wide enough to need another question');

    const afterFirst = (await sessionsFor(film))[0];
    const replay = await one(t.db, `select rank_answer($1, $2, $3) as r`, [
      started.session_id,
      started.pivot,
      id,
    ]);
    const afterReplay = (await sessionsFor(film))[0];

    assert.deepEqual(replay, answered);
    assert.deepEqual(
      { lo: afterReplay.lo, hi: afterReplay.hi, pivot: afterReplay.pivot },
      { lo: afterFirst.lo, hi: afterFirst.hi, pivot: afterFirst.pivot },
      'the session is exactly where the first answer left it',
    );
  });

  it('rank_skip replayed does not spend a second skip', async () => {
    for (let i = 0; i < 4; i += 1) {
      await t.rankToCompletion(await movie(`Skip anchor ${i}`), 'fine', async (pivot) => pivot);
    }

    const film = await movie('Replayed skip');
    const started = await one(t.db, `select rank_start($1, 'fine') as r`, [film]);
    const id = await op();

    const skipped = await one(t.db, `select rank_skip($1, $2) as r`, [started.session_id, id]);
    const afterFirst = (await sessionsFor(film))[0];
    const replay = await one(t.db, `select rank_skip($1, $2) as r`, [started.session_id, id]);
    const afterReplay = (await sessionsFor(film))[0];

    assert.deepEqual(replay, skipped, 'the same opponent, not the next one along');
    assert.equal(
      afterReplay.skips,
      afterFirst.skips,
      'the skip cap counts intents, not attempts — a replay must not bring the third skip forward',
    );
  });

  it('rank_unrank replayed does not close the gap twice', async () => {
    const a = await movie('Unrank A');
    const b = await movie('Unrank B');
    await t.rankToCompletion(a, 'loved', async (pivot) => pivot);
    await t.rankToCompletion(b, 'loved', async (pivot) => pivot);

    const id = await op();
    await t.sql(`select rank_unrank($1, $2)`, [a, id]);
    const afterFirst = await t.ranking(user);

    // A second shift would renumber the survivor to zero, which the position check
    // refuses — so without the claim this raises rather than merely miscounting.
    await t.sql(`select rank_unrank($1, $2)`, [a, id]);

    assert.deepEqual(await t.ranking(user), afterFirst, 'the ranking is untouched by the replay');
    await t.assertValid(user);
  });

  it('rank_reorder replayed does not move the title twice', async () => {
    const titles = [];
    for (let i = 0; i < 3; i += 1) {
      const film = await movie(`Reorder ${i}`);
      await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
      titles.push(film);
    }

    const target = (await rankingRows(titles[0]))[0];
    const id = await op();

    await t.sql(`select rank_reorder($1, $2, $3)`, [titles[0], target.position === 1 ? 3 : 1, id]);
    const afterFirst = await t.ranking(user);
    await t.sql(`select rank_reorder($1, $2, $3)`, [titles[0], target.position === 1 ? 3 : 1, id]);

    assert.deepEqual(await t.ranking(user), afterFirst);
    await t.assertValid(user);
  });

  it('refuses an operation id already spent on a different function', async () => {
    // One id, one intent. The dangerous case is a composite writer passing its single id
    // to two RPCs: the second finds the id taken, and without this guard it would report
    // `already_applied` having done nothing at all. `collection/writes.ts` documents the
    // near-miss this was found through.
    const film = await movie('Reused id');
    const id = await op();

    await t.sql(`select rank_start($1, 'loved', $2)`, [film, id]);
    const error = await t.errorFrom(`select rank_unrank($1, $2)`, [film, id]);

    assert.equal(error?.code, '22023');
    assert.match(error.message, /different operation/);
    assert.equal((await rankingRows(film)).length, 1, 'and the refusal changed nothing');
  });

  it('leaves the ledger clean when the call raised, so a real retry still runs', async () => {
    // The claim rolls back with everything else, which is what makes a refusal
    // retryable. Anything else would turn one bad request into a permanently poisoned
    // operation id.
    const series = await t.createSeries('Unrankable', (seq += 1) + 90000);
    const id = await op();

    const refused = await t.errorFrom(`select rank_start($1, 'loved', $2)`, [series, id]);
    assert.equal(refused?.code, '22023', 'a series cannot be ranked');

    const film = await movie('After a refusal');
    const ok = await one(t.db, `select rank_start($1, 'loved', $2) as r`, [film, id]);
    assert.equal(ok.done, true, 'the id was never spent, so it is still usable');
  });

  it('runs without an operation id, which is the installed-client path', async () => {
    // Every one of these RPCs defaults `p_operation_id` to null so the friend-beta build
    // keeps working against the new database (20260825000200 §9). A null claims nothing
    // and gets no replay protection — honestly, rather than by inventing an id
    // server-side, which would be fresh on every retry and so protect nothing.
    const film = await movie('No operation id');
    const placed = await one(t.db, `select rank_start($1, 'loved') as r`, [film]);

    assert.equal(placed.done, true);
    assert.equal(
      (await t.sql(`select count(*)::int as n from processed_operations where user_id = $1`, [user]))
        .rows[0].n,
      0,
      'nothing was written to the ledger',
    );
  });
});

// ---------------------------------------------------------------------------

describe('I6: Rank Again is one transaction', () => {
  it('drops the position and opens a fresh session in the same band', async () => {
    for (let i = 0; i < 3; i += 1) {
      await t.rankToCompletion(await movie(`Again anchor ${i}`), 'loved', async (p) => p);
    }
    const film = await movie('Ranked again');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);

    const before = (await rankingRows(film))[0];
    assert.ok(before, 'the title starts with a position');

    const step = await one(t.db, `select rank_again($1, 'loved', $2) as r`, [film, await op()]);

    assert.equal(step.done, false, 'a non-empty band re-enters comparison');
    assert.equal((await rankingRows(film)).length, 0, 'the old position is gone');
    assert.equal((await collectionRow(film)).bucket, 'loved', 'and the title is still logged');
    assert.equal((await sessionsFor(film)).length, 1);
    await t.assertValid(user);
  });

  it('is the same-band case rank_rebucket refuses', async () => {
    const film = await movie('Same band');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);

    const refused = await t.errorFrom(`select rank_rebucket($1, 'loved'::taste_bucket)`, [film]);
    assert.equal(refused?.code, '22023', 'rank_rebucket exists to change a band');

    const step = await one(t.db, `select rank_again($1, 'loved', $2) as r`, [film, await op()]);
    assert.equal(step.done, true, 'the band emptied when its only member was unranked');
  });

  it('does not treat an unranked title as an error', async () => {
    // The state this call was reaching for. The client used to absorb a P0002 from its
    // own `rank_unrank` here; the server takes the same reading now.
    const film = await movie('Never ranked');
    const step = await one(t.db, `select rank_again($1, 'fine', $2) as r`, [film, await op()]);

    assert.equal(step.done, true);
    assert.equal((await collectionRow(film)).bucket, 'fine');
    await t.assertValid(user);
  });

  /**
   * The property the migration exists for, and the one a client-side pair of calls could
   * not have.
   *
   * `rank_again` on a series raises inside `_rank_start_impl`, *after*
   * `_rank_unrank_impl` has already deleted the row. In one transaction that rollback
   * takes the deletion with it. As two client calls it would not have: the unrank would
   * be committed and the start refused, leaving the title logged and unranked with
   * nobody having asked for that.
   *
   * A series cannot be ranked in the first place, so it is used here only as a
   * guaranteed failure at the right point in the body. What is being asserted is the
   * rollback, not the refusal.
   */
  it('leaves the old position standing when the fresh session cannot be opened', async () => {
    const film = await movie('Atomic rank again');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
    const before = await t.ranking(user);

    // Forced from inside: the bucket is null, which `rank_again` refuses *before* it
    // unranks — so this asserts the guard rather than the rollback.
    const guarded = await t.errorFrom(`select rank_again($1, null, $2)`, [film, await op()]);
    assert.equal(guarded?.code, '22023');
    assert.deepEqual(await t.ranking(user), before);

    // And the rollback itself, forced at a point after the deletion has happened. The
    // trigger is disposable and exists only to fail the insert; nothing in the schema
    // depends on it.
    await t.exec(`
      create or replace function _test_refuse_ranking() returns trigger
      language plpgsql as $$
      begin
        raise exception 'refused for the test' using errcode = 'P0001';
      end;
      $$;
      create trigger _test_refuse_ranking before insert on rankings
        for each row execute function _test_refuse_ranking();
    `);

    const rolled = await t.errorFrom(`select rank_again($1, 'loved'::taste_bucket, $2)`, [
      film,
      await op(),
    ]);

    await t.exec(`drop trigger _test_refuse_ranking on rankings`);

    assert.equal(rolled?.code, 'P0001', 'the fresh placement was refused');
    assert.deepEqual(
      await t.ranking(user),
      before,
      'and the position it had already deleted came back with the rollback',
    );
    await t.assertValid(user);
  });

  it('replayed, does not unrank the title a second time', async () => {
    for (let i = 0; i < 3; i += 1) {
      await t.rankToCompletion(await movie(`Replay again anchor ${i}`), 'loved', async (p) => p);
    }
    const film = await movie('Replayed rank again');
    await t.rankToCompletion(film, 'loved', async (pivot) => pivot);

    const id = await op();
    const first = await one(t.db, `select rank_again($1, 'loved', $2) as r`, [film, id]);
    const replay = await one(t.db, `select rank_again($1, 'loved', $2) as r`, [film, id]);

    assert.deepEqual(replay, first, 'the same session, not a second one');
    assert.equal((await sessionsFor(film)).length, 1);
    await t.assertValid(user);
  });
});

// ---------------------------------------------------------------------------

describe('I4: a session cannot outlive the collection row it is placing', () => {
  it('unlog deletes the open comparison session with the row', async () => {
    await t.rankToCompletion(await movie('Session anchor'), 'loved', async (pivot) => pivot);

    const film = await movie('Unlogged mid-session');
    const started = await one(t.db, `select rank_start($1, 'loved') as r`, [film]);
    assert.equal(started.done, false);
    assert.equal((await sessionsFor(film)).length, 1);

    await t.sql(`select unlog($1, $2)`, [await op(), film]);

    assert.equal(await collectionRow(film), null, 'the row is gone');
    assert.equal((await sessionsFor(film)).length, 0, 'and so is the session placing it');

    // Which is what makes the orphan unreachable: answering the session now finds
    // nothing, rather than finalising a ranking for a title the reader removed.
    const error = await t.errorFrom(`select rank_answer($1, $2)`, [started.session_id, film]);
    assert.equal(error?.code, 'P0002');
    assert.equal((await rankingRows(film)).length, 0);
  });

  it('leaves other titles’ sessions alone', async () => {
    await t.rankToCompletion(await movie('Other anchor'), 'loved', async (pivot) => pivot);

    const kept = await movie('Kept');
    const removed = await movie('Removed');
    const keptSession = await one(t.db, `select rank_start($1, 'loved') as r`, [kept]);
    await t.sql(`select set_bucket($1, $2, 'loved'::taste_bucket)`, [await op(), removed]);

    await t.sql(`select unlog($1, $2)`, [await op(), removed]);

    assert.equal((await sessionsFor(kept)).length, 1);
    assert.equal(keptSession.done, false);
  });
});

// ---------------------------------------------------------------------------

describe('I3: a finalise reconciles the collection row it is a claim about', () => {
  it('re-asserts the bucket when a set_bucket moved it mid-session', async () => {
    /**
     * A session spans transactions, so no lock inside one of them reaches the gap
     * between two. Between `rank_start` and the `rank_answer` that finalises, a
     * `set_bucket` from another device is a legitimate write that changes
     * `user_media.bucket` — and the finalise then writes a `rankings` row carrying the
     * *session's* bucket. That is I3 broken by two correct calls.
     *
     * The insertion of a `rankings` row is the one moment the app can state the whole
     * truth about a title, so it states it.
     */
    await t.rankToCompletion(await movie('Reconcile anchor'), 'loved', async (pivot) => pivot);

    const film = await movie('Reconciled');
    const started = await one(t.db, `select rank_start($1, 'loved') as r`, [film]);
    assert.equal(started.done, false);

    // Reaches past `set_bucket`, which refuses a ranked title and would refuse this for
    // the wrong reason. The point is a `user_media.bucket` that disagrees with the
    // session by the time the session finalises, however it got that way.
    await t.sql(
      `update user_media set bucket = 'fine' where user_id = $1 and media_item_id = $2`,
      [user, film],
    );

    const placed = await one(t.db, `select rank_answer($1, $2) as r`, [started.session_id, film]);
    assert.equal(placed.done, true);

    const ranked = (await rankingRows(film))[0];
    const logged = await collectionRow(film);
    assert.equal(logged.bucket, ranked.bucket, 'the collection agrees with the ranking');
    await t.assertValid(user);
  });

  it('re-creates a collection row deleted from under an open session', async () => {
    await t.rankToCompletion(await movie('Orphan anchor'), 'loved', async (pivot) => pivot);

    const film = await movie('Orphan candidate');
    const started = await one(t.db, `select rank_start($1, 'loved') as r`, [film]);

    // Again reaching past `unlog`, which now cancels the session and so cannot produce
    // this state. The assertion is that the finalise is safe even if some future writer
    // does.
    await t.sql(`delete from user_media where user_id = $1 and media_item_id = $2`, [user, film]);

    await one(t.db, `select rank_answer($1, $2) as r`, [started.session_id, film]);

    assert.ok(await collectionRow(film), 'a ranked title is a logged title (I1)');
    await t.assertValid(user);
  });
});

// ---------------------------------------------------------------------------

describe('I8: clearing a watch date', () => {
  it('leaves a bucketed title logged', async () => {
    const film = await movie('Dated and bucketed');
    await t.sql(`select log_watched($1, $2, current_date)`, [await op(), film]);
    await t.sql(`select set_bucket($1, $2, 'loved'::taste_bucket)`, [await op(), film]);

    await t.sql(`select clear_watch_date($1, $2)`, [await op(), film]);

    const row = await collectionRow(film);
    assert.equal(row.watched_on, null, 'the date is forgotten');
    assert.equal(row.bucket, 'loved', 'the title is still logged, because a bucket says so');
  });

  it('refuses when the date is the only watch signal', async () => {
    const film = await movie('Dated only');
    await t.sql(`select log_watched($1, $2, current_date)`, [await op(), film]);

    const error = await t.errorFrom(`select clear_watch_date($1, $2)`, [await op(), film]);
    assert.equal(error?.code, '22023');
    assert.ok((await collectionRow(film)).watched_on, 'and the date is still there');
  });
});

// ---------------------------------------------------------------------------

/**
 * TV-1, decided by the founder on 2026-08-24 and closed here.
 *
 * The documents said a season became rankable only once marked *Completed*. Nothing
 * enforced it at any layer, and the state it depended on was unreachable by any user —
 * `set_season_progress` has no client call site, so `user_media.progress` was null for
 * every row in existence. `open-questions.md` §TV-1 has the full statement.
 *
 * The decision is that **ranking a season is the completion claim.** The "How was it?"
 * that opens the flow already says the reader watched it, so a separate prerequisite
 * would be asking the same question twice — and the model stays one model for movies
 * and seasons alike.
 *
 * These tests are the fence around that. They are written as *absences*: what they pin
 * is that no completion gate exists, which is the thing a future guard added to
 * `rank_start` or `set_bucket` would quietly break.
 */
describe('TV-1: ranking a season is the watch claim', () => {
  const season = async (label) => {
    const series = await t.createSeries(`${label} series`, (seq += 1) + 90000);
    return t.createSeason(series, 1, `${label} season 1`);
  };

  it('ranks a season that has never been touched by set_season_progress', async () => {
    const item = await season('Untouched');

    const placed = await one(t.db, `select rank_start($1, 'loved') as r`, [item]);

    assert.equal(placed.done, true, 'no prerequisite, no refusal');
    assert.equal(placed.category, 'tv_seasons');
    assert.equal((await collectionRow(item)).bucket, 'loved');
    await t.assertValid(user, 'tv_seasons');
  });

  it('does not write progress as a side effect of ranking', async () => {
    // Evaluated narrowly, as the decision asks. `progress = 'completed'` has exactly two
    // consumers: `clear_watch_date`'s watch-signal check, which a ranked title already
    // satisfies through its bucket, and the `season_completed` feed event, which has no
    // writer. Neither needs this, so ranking does not invent it — the schema stays
    // dormant rather than becoming a second, partial record of the same claim.
    const item = await season('No progress');
    await t.rankToCompletion(item, 'loved', async (pivot) => pivot);

    assert.equal((await collectionRow(item)).progress, null);
  });

  it('buckets a season with no progress set', async () => {
    const item = await season('Bucketed');
    await t.sql(`select set_bucket($1, $2, 'fine'::taste_bucket)`, [await op(), item]);

    assert.equal((await collectionRow(item)).bucket, 'fine');
  });

  it('still refuses to rank a whole series', async () => {
    // The one TV rule that is real and stays real: PRD §10 makes the season the unit,
    // because "I watched this show" is ambiguous about which of it.
    const series = await t.createSeries('Whole show', (seq += 1) + 90000);
    const error = await t.errorFrom(`select rank_start($1, 'loved')`, [series]);

    assert.equal(error?.code, '22023');
    assert.match(error.message, /series cannot be ranked/);
  });

  it('ranks a season that is marked watching rather than completed', async () => {
    // The stronger form of the same point. Even where the dormant column *is* set, and
    // set to the value the retired rule would have refused on, ranking proceeds.
    const item = await season('Still watching');
    await t.sql(`select set_season_progress($1, $2, 'watching'::season_progress)`, [
      await op(),
      item,
    ]);

    const placed = await one(t.db, `select rank_start($1, 'loved') as r`, [item]);
    assert.equal(placed.done, true);
    assert.equal((await collectionRow(item)).progress, 'watching', 'and the value is left alone');
  });
});
