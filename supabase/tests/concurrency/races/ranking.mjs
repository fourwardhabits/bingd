import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { fire, newOp, raceContext } from './_shared.mjs';

/**
 * Same-title concurrency, with real sessions.
 *
 * ---------------------------------------------------------------------------
 * The finding this suite closes
 * ---------------------------------------------------------------------------
 *
 * `public-launch-risk-register.md` **M3**, and `20260813002300`'s own header before
 * it: every advisory lock in the ranking family was keyed on `(user_id, category)`,
 * which serialises the *band arithmetic* and nothing else. Two writers naming the same
 * **title** collided only if they happened to share a category, and `set_bucket` and
 * `unlog` took no advisory lock at all — so `set_bucket`'s `_assert_unranked` and its
 * upsert were two statements with a committing `rank_start` free to land between them.
 *
 * `20260825000200` adds `_lock_media(user, media_item)` and takes it in every writer
 * that can change whether a title is logged, bucketed or ranked.
 *
 * ---------------------------------------------------------------------------
 * What is asserted, and why in this shape
 * ---------------------------------------------------------------------------
 *
 * **Blocking, observed rather than grepped.** Each test drives the second transaction
 * into `awaitBlocked` correlated with the key `_lock_media` computes for that exact
 * (user, title) pair. Delete the lock from the writer and the call returns immediately,
 * `awaitBlocked` throws, and the test goes red — which is the property `lock-pair.mjs`
 * established for the social writers and the reason this file cannot pass on an
 * interleaving that merely happened to resolve well.
 *
 * A row lock would make several of these block *anyway*: `_rank_start_impl` upserts
 * `user_media` before it finalises, so a concurrent `set_bucket` contends on the row
 * even with no advisory lock in sight. That is exactly why the correlation matters. An
 * `awaitBlocked()` with no key would be satisfied by the row lock and would pass over a
 * schema with the media lock removed.
 *
 * **And the final state, every time.** Blocking is only half the claim. `assertValid`
 * runs after each race, because a lock that serialises two writers into a consistent
 * order is worth nothing if the order it produces still violates I1–I3.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  /** The bucket and position a title ended up with, or null if it is not ranked. */
  const rankingOf = async (db, user, item) => {
    const rows = await db.rows(
      `select bucket, position, category from rankings where user_id = $1 and media_item_id = $2`,
      [user, item],
    );
    return rows[0] ?? null;
  };

  const collectionOf = async (db, user, item) => {
    const rows = await db.rows(
      `select bucket, watched_on from user_media where user_id = $1 and media_item_id = $2`,
      [user, item],
    );
    return rows[0] ?? null;
  };

  /**
   * I1 to I3, from the schema's own checker rather than from an assertion written
   * here — `assert_ranking_valid` has held the definition since `20260813000700` and a
   * second copy of it in a test file would be a second thing to keep in step.
   */
  const assertValid = (db, user, category = 'movies') =>
    db.sql(`select assert_ranking_valid($1, $2::ranking_category)`, [user, category]);

  describe('same-title writes serialise on the media lock', () => {
    before(() => rc.open());
    after(() => rc.close());

    it('M3: set_bucket waits for a rank_start on the same title, and I3 survives', async () => {
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const film = await fx.createMovie('Set bucket versus rank start');

      // The band is empty, so `rank_start` runs straight through to `_rank_finalize`
      // and reaches the `rankings` insert the barrier is armed on — which is the only
      // moment in the flow where the ranking exists and the transaction is still open.
      await db.armBarrier('rankings', 'sb-vs-start');
      const ctl = await db.controller();
      await ctl.hold('sb-vs-start');

      const ranker = await db.session('ranker');
      const bucketer = await db.session('bucketer');
      await ranker.actAs(user);
      await bucketer.actAs(user);

      await ranker.begin();
      await ranker.pauseAt('sb-vs-start');
      const ranking = fire(ranker, `rank_start($1, 'loved')`, [film]);
      await ranker.awaitBlocked();

      await bucketer.begin();
      const bucketing = bucketer.errorFrom(`select set_bucket($1, $2, 'fine'::taste_bucket)`, [
        await newOp(db),
        film,
      ]);

      // Correlated with `_lock_media`'s own key. Without that correlation this would be
      // satisfied by the `user_media` row lock `rank_start` is already holding, and the
      // test would pass against a `set_bucket` with no advisory lock at all.
      const waiting = await bucketer.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.mediaKey(user, film),
      });
      assert.equal(waiting.wait_event, 'advisory');

      await ctl.release('sb-vs-start');
      await ranking;
      await ranker.commit();

      const refusal = await bucketing;
      await bucketer.commit();

      // The defined outcome. `set_bucket` refuses a ranked title with 55000 by design
      // (PRD §18: a band move is not queueable), and the lock is what makes that check
      // see a ranking that is now committed rather than one still in flight.
      assert.equal(refusal?.code, '55000', 'a ranked title is not bucketable');

      const ranked = await rankingOf(db, user, film);
      const logged = await collectionOf(db, user, film);
      assert.equal(ranked?.bucket, 'loved');
      assert.equal(logged?.bucket, 'loved', 'user_media.bucket must equal rankings.bucket (I3)');
      await assertValid(db, user);

      await ranker.end();
      await bucketer.end();
      await ctl.end();
    });

    it('M3: a rank_start waits for a set_bucket on the same title', async () => {
      // The other direction, because a lock that only works one way round is a lock
      // that works by luck. `set_bucket` is stopped at its `user_media` write and the
      // ranking has to wait — and then, because the bucket the reader chose second is
      // the one that opens the session, the two agree.
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const film = await fx.createMovie('Rank start versus set bucket');

      await db.armBarrier('user_media', 'start-vs-sb');
      const ctl = await db.controller();
      await ctl.hold('start-vs-sb');

      const bucketer = await db.session('bucketer');
      const ranker = await db.session('ranker');
      await bucketer.actAs(user);
      await ranker.actAs(user);

      await bucketer.begin();
      await bucketer.pauseAt('start-vs-sb');
      const bucketing = fire(bucketer, `set_bucket($1, $2, 'fine'::taste_bucket)`, [
        await newOp(db),
        film,
      ]);
      await bucketer.awaitBlocked();

      await ranker.begin();
      const ranking = fire(ranker, `rank_start($1, 'loved')`, [film]);

      await ranker.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.mediaKey(user, film),
      });

      await ctl.release('start-vs-sb');
      await bucketing;
      await bucketer.commit();
      await ranking;
      await ranker.commit();

      const ranked = await rankingOf(db, user, film);
      const logged = await collectionOf(db, user, film);
      assert.equal(ranked?.bucket, 'loved', 'the ranking is what the ranker chose');
      assert.equal(logged?.bucket, 'loved', 'and the collection agrees with it (I3)');
      await assertValid(db, user);

      await bucketer.end();
      await ranker.end();
      await ctl.end();
    });

    it('unlog waits for a rank_start, and cannot orphan the ranking', async () => {
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const film = await fx.createMovie('Unlog versus rank start');
      await fx.logWatch(user, film, 'loved');

      await db.armBarrier('rankings', 'unlog-vs-start');
      const ctl = await db.controller();
      await ctl.hold('unlog-vs-start');

      const ranker = await db.session('ranker');
      const remover = await db.session('remover');
      await ranker.actAs(user);
      await remover.actAs(user);

      await ranker.begin();
      await ranker.pauseAt('unlog-vs-start');
      const ranking = fire(ranker, `rank_start($1, 'loved')`, [film]);
      await ranker.awaitBlocked();

      await remover.begin();
      const removal = remover.errorFrom(`select unlog($1, $2)`, [await newOp(db), film]);
      await remover.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.mediaKey(user, film),
      });

      await ctl.release('unlog-vs-start');
      await ranking;
      await ranker.commit();

      const refusal = await removal;
      await remover.commit();

      // The unacceptable outcomes named in the tranche: a ranking with no collection
      // row, or a collection row deleted out from under one. Neither is reachable —
      // the removal simply arrives second and is told the title is ranked.
      assert.equal(refusal?.code, '55000', 'a ranked title must be unranked before removal');
      assert.ok(await rankingOf(db, user, film), 'the ranking survives');
      assert.ok(await collectionOf(db, user, film), 'and so does the row it depends on');
      await assertValid(db, user);

      await ranker.end();
      await remover.end();
      await ctl.end();
    });

    it('a rank_start after an unlog re-creates the row it needs, rather than orphaning', async () => {
      // The other order, and the one with a genuinely open question. The removal wins,
      // so the collection row and any open session go; the ranking that arrives second
      // is then a fresh first ranking of a title that is not in the collection, and
      // `_rank_start_impl` logs it before placing it. Ranked and logged, or neither —
      // never one without the other.
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const film = await fx.createMovie('Rank start after unlog');
      await fx.logWatch(user, film, 'loved');

      await db.armBarrier('user_media', 'start-after-unlog', { event: 'delete' });
      const ctl = await db.controller();
      await ctl.hold('start-after-unlog');

      const remover = await db.session('remover');
      const ranker = await db.session('ranker');
      await remover.actAs(user);
      await ranker.actAs(user);

      await remover.begin();
      await remover.pauseAt('start-after-unlog');
      const removal = fire(remover, `unlog($1, $2)`, [await newOp(db), film]);
      await remover.awaitBlocked();

      await ranker.begin();
      const ranking = fire(ranker, `rank_start($1, 'fine')`, [film]);
      await ranker.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.mediaKey(user, film),
      });

      await ctl.release('start-after-unlog');
      await removal;
      await remover.commit();
      await ranking;
      await ranker.commit();

      const ranked = await rankingOf(db, user, film);
      const logged = await collectionOf(db, user, film);
      assert.ok(ranked, 'the second writer placed the title');
      assert.ok(logged, 'and the collection row it stands on exists');
      assert.equal(logged.bucket, ranked.bucket, 'I3');
      await assertValid(db, user);

      await remover.end();
      await ranker.end();
      await ctl.end();
    });

    /**
     * Independent review 39's BLOCKER, and the reason it was worth asking a reviewer to
     * check the contract against the *schema* rather than against the list of writers in
     * the brief.
     *
     * `set_season_progress` writes a column TV-1 leaves dormant — nothing reads
     * `progress`, and ranking neither requires nor sets it — so it reads like a function
     * with nothing at stake. But its upsert **creates the `user_media` row**, and a row
     * is a Logged title however it got there. Unserialised, it can put back the row an
     * `unlog` has just deleted, and the reader watches a removal complete and finds the
     * season still in their collection.
     */
    it('set_season_progress waits for an unlog on the same season', async () => {
      const { db, fx } = ctx;
      const user = await fx.createUser();

      const series = (
        await db.rows(
          `insert into media_items (kind, tmdb_id, title, provenance)
           values ('series', -910001, 'Race series', 'manual') returning id`,
        )
      )[0].id;
      const season = (
        await db.rows(
          `insert into media_items (kind, parent_id, season_number, title, provenance)
           values ('season', $1, 1, 'Race season 1', 'manual') returning id`,
          [series],
        )
      )[0].id;
      await fx.logWatch(user, season, 'loved');

      await db.armBarrier('user_media', 'progress-vs-unlog', { event: 'delete' });
      const ctl = await db.controller();
      await ctl.hold('progress-vs-unlog');

      const remover = await db.session('remover');
      const progresser = await db.session('progresser');
      await remover.actAs(user);
      await progresser.actAs(user);

      await remover.begin();
      await remover.pauseAt('progress-vs-unlog');
      const removal = fire(remover, `unlog($1, $2)`, [await newOp(db), season]);
      await remover.awaitBlocked();

      await progresser.begin();
      const progressing = fire(progresser, `set_season_progress($1, $2, 'completed')`, [
        await newOp(db),
        season,
      ]);
      await progresser.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.mediaKey(user, season),
      });

      await ctl.release('progress-vs-unlog');
      await removal;
      await remover.commit();
      await progressing;
      await progresser.commit();
      await ctl.end();

      // The write still lands — it arrived second and nothing refuses it, which is the
      // correct outcome for a caller that asked to record progress on a season. What
      // the lock buys is that it is *ordered*: the row it creates is the one this call
      // asked for and not a resurrection of the one the removal was deleting, and the
      // two are no longer interleaved inside a single upsert.
      const rows = await db.rows(
        `select bucket, progress, watched_on from user_media
          where user_id = $1 and media_item_id = $2`,
        [user, season],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].progress, 'completed');
      assert.equal(rows[0].bucket, null, 'the bucket the unlog removed did not come back');

      await remover.end();
      await progresser.end();
    });

    /**
     * Review 39's second finding, at the grain it actually bites.
     *
     * `rank_cancel` deletes a session; `rank_answer` reads one, records a comparison and
     * writes it back. Unserialised, a cancel landing inside that window lets the answer
     * charge the reader a judgement and then update zero rows — answering with a
     * `session_id` and a pivot for a session that no longer exists.
     */
    it('rank_cancel waits for an answer that is mid-flight', async () => {
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const anchor = await fx.createMovie('Cancel anchor');
      const subject = await fx.createMovie('Cancel subject');

      const solo = await db.session('setup');
      await solo.actAs(user);
      await solo.q(`select rank_start($1, 'loved')`, [anchor]);
      const started = (await solo.one(`select rank_start($1, 'loved') as r`, [subject])).r;
      await solo.end();
      assert.equal(started.done, false, 'the fixture must leave a session open');

      // The answer finalises — the band holds one title — so it reaches the `rankings`
      // insert, which is where it can be stopped while holding the media lock.
      await db.armBarrier('rankings', 'cancel-vs-answer');
      const ctl = await db.controller();
      await ctl.hold('cancel-vs-answer');

      const answerer = await db.session('answerer');
      const canceller = await db.session('canceller');
      await answerer.actAs(user);
      await canceller.actAs(user);

      await answerer.begin();
      await answerer.pauseAt('cancel-vs-answer');
      const answering = fire(answerer, `rank_answer($1, $2)`, [started.session_id, subject]);
      await answerer.awaitBlocked();

      await canceller.begin();
      const cancelling = canceller.errorFrom(`select rank_cancel($1)`, [started.session_id]);
      await canceller.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.mediaKey(user, subject),
      });

      await ctl.release('cancel-vs-answer');
      await answering;
      await answerer.commit();

      const refusal = await cancelling;
      await canceller.commit();
      await ctl.end();

      // The answer finalised, which deletes the session itself — so the cancel arrives
      // to find it already gone and says so. `session.ts` reads that P0002 as the
      // outcome the caller wanted, which is exactly what it is.
      assert.equal(refusal?.code, 'P0002', 'the session was finalised, not cancelled');
      assert.ok(await rankingOf(db, user, subject), 'and the title was placed');
      await assertValid(db, user);

      await answerer.end();
      await canceller.end();
    });

    /**
     * **The window `20260826000500` opened, and the lock that closes it.**
     *
     * A re-ranking used to destroy the old position when the session *opened* — in its
     * own transaction, minutes before the placement. Since the founder's device pass it
     * does not: `_rank_finalize` now drops the old row and inserts the new one in one
     * transaction, so there is a moment inside that function where the title has no
     * position and the band is one shorter than it will be.
     *
     * That moment is inside the category advisory lock, which `_rank_finalize` takes as
     * its first act and which `_rank_unrank_impl` re-enters — advisory transaction locks
     * being re-entrant for one session, so the nested take is a hash lookup rather than
     * a self-deadlock. Anything else placing into the same band has to wait for the
     * whole drop-and-place, which is what makes the intermediate shape unobservable.
     *
     * Remove that lock and this test fails in the shape that matters: the second
     * finalise reads a band count taken while the subject was gone, shifts against it,
     * and `assert_ranking_valid` refuses the result. The assertion is therefore both —
     * the second writer blocked *on that key*, and I1–I3 survived.
     */
    it('a re-ranking finalise holds the band while it drops and replaces', async () => {
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const subject = await fx.createMovie('Reranked under load');
      const anchor = await fx.createMovie('Rerank band anchor');

      const solo = await db.session('setup');
      await solo.actAs(user);
      await solo.q(`select rank_start($1, 'loved')`, [anchor]);
      // Two in the band, so the subject genuinely holds a position to be replaced.
      const placing = (await solo.one(`select rank_start($1, 'loved') as r`, [subject])).r;
      await solo.q(`select rank_answer($1, $2)`, [placing.session_id, subject]);
      // The re-ranking session: opened, and the old position deliberately still there.
      const again = (
        await solo.one(`select rank_again($1, 'loved', $2, true) as r`, [subject, await newOp(db)])
      ).r;
      await solo.end();
      assert.equal(again.done, false, 'the fixture must leave a provisional session open');
      assert.ok(
        await rankingOf(db, user, subject),
        'and the title must still be ranked while it is open',
      );

      await db.armBarrier('rankings', 'rerank-vs-reorder');
      const ctl = await db.controller();
      await ctl.hold('rerank-vs-reorder');

      const reranker = await db.session('reranker');
      const reorderer = await db.session('reorderer');
      await reranker.actAs(user);
      await reorderer.actAs(user);

      // The answer finalises the provisional session, so it reaches the `rankings`
      // insert — which is *after* the old row has been dropped. That is the window.
      await reranker.begin();
      await reranker.pauseAt('rerank-vs-reorder');
      const reranking = fire(reranker, `rank_answer($1, $2)`, [again.session_id, subject]);
      await reranker.awaitBlocked();

      /**
       * A drag on the *other* title in the band, so the media lock cannot be what
       * serialises these two — `_lock_media` is keyed on (user, title) and these are two
       * different titles. Only the category lock can, which is the whole point of
       * correlating the wait on its key rather than merely observing a wait.
       */
      await reorderer.begin();
      const reordering = fire(reorderer, `rank_reorder($1, 1, $2)`, [anchor, await newOp(db)]);
      await reorderer.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.categoryKey(user, 'movies'),
      });

      await ctl.release('rerank-vs-reorder');
      await reranking;
      await reranker.commit();
      await reordering;
      await reorderer.commit();
      await ctl.end();

      const after = await rankingOf(db, user, subject);
      assert.ok(after, 'the subject came out of it with a position');
      assert.equal(after.bucket, 'loved', 'in the band it never left');
      assert.equal((await rankingOf(db, user, anchor)).position, 1, 'and the drag landed');
      await assertValid(db, user);

      await reranker.end();
      await reorderer.end();
    });

    it('two different titles do not contend', async () => {
      // The negative case, which is what keeps the three above honest. A lock that
      // serialised every write for an account would satisfy all of them and would turn
      // ranking into a queue.
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const one = await fx.createMovie('Independent one');
      const two = await fx.createMovie('Independent two');

      // Taken as the owner rather than through `actAs`, because `_lock_media` is revoked
      // from `authenticated` — which `lock-pair.mjs` does for the same reason, and which
      // `function-grants.test.mjs` is what actually pins.
      const first = await db.session('one');
      const second = await db.session('two');

      await first.begin();
      await first.q(`select _lock_media($1, $2)`, [user, one]);

      await second.begin();
      await second.q(`select _lock_media($1, $2)`, [user, two]);
      await second.assertRunning({ forMs: 100 });

      await first.commit();
      await second.commit();
      await first.end();
      await second.end();
    });

    it('two accounts holding the same title do not contend', async () => {
      const { db, fx } = ctx;
      const alice = await fx.createUser();
      const bob = await fx.createUser();
      const film = await fx.createMovie('Shared title');

      const first = await db.session('alice');
      const second = await db.session('bob');

      await first.begin();
      await first.q(`select _lock_media($1, $2)`, [alice, film]);

      await second.begin();
      await second.q(`select _lock_media($1, $2)`, [bob, film]);
      await second.assertRunning({ forMs: 100 });

      await first.commit();
      await second.commit();
      await first.end();
      await second.end();
    });
  });

  /**
   * The lock hierarchy, checked as an order rather than as a pair of assertions.
   *
   * `20260825000200`'s header states it: ledger row, then media lock, then category
   * lock, and nothing acquires the category lock before the media lock. The danger it
   * rules out is the classic one — two transactions ranking two different titles in the
   * same category, each holding what the other wants next.
   *
   * A deadlock here would not be a hang. PostgreSQL's deadlock detector aborts one side
   * with 40P01 after `deadlock_timeout`, so the assertion is that neither call raises
   * it: both complete, one after the other.
   */
  describe('lock ordering across two titles in one category', () => {
    before(() => rc.open());
    after(() => rc.close());

    it('does not deadlock when two rankings in one band overlap', async () => {
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const one = await fx.createMovie('Deadlock one');
      const two = await fx.createMovie('Deadlock two');

      /**
       * **The overlap has to be forced, and the first version of this test did not
       * force it.** Firing the second `rank_start` and committing the first immediately
       * looks like a race and is not one: the second call reliably won the sprint to
       * `band_bounds` only *after* the first had committed, found a band of one rather
       * than an empty one, and opened a comparison session — which never reaches
       * `_rank_finalize` and so never takes the category lock at all. The test passed
       * over a schema where the two locks were never both held.
       *
       * The barrier makes it deterministic. `first` is stopped inside `_rank_finalize`
       * at the `rankings` insert, holding media(one) *and* the category lock, and
       * `second` is then required to be found waiting on the category key.
       *
       * That is the shape a lock-order bug would deadlock in: `second` holds media(two)
       * and wants the category lock; `first` holds the category lock and, if the order
       * were reversed anywhere, would want a media lock. It would not hang the test —
       * PostgreSQL's detector aborts one side with 40P01 after `deadlock_timeout` — so
       * it would surface as a raised error out of one of these two awaits.
       */
      await db.armBarrier('rankings', 'lock-order');
      const ctl = await db.controller();
      await ctl.hold('lock-order');

      const first = await db.session('one');
      const second = await db.session('two');
      await first.actAs(user);
      await second.actAs(user);

      await first.begin();
      await first.pauseAt('lock-order');
      const held = fire(first, `rank_start($1, 'loved')`, [one]);
      await first.awaitBlocked();

      await second.begin();
      const overlapping = fire(second, `rank_start($1, 'loved')`, [two]);
      await second.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.categoryKey(user, 'movies'),
      });

      await ctl.release('lock-order');
      await held;
      await first.commit();
      await overlapping;
      await second.commit();
      await ctl.end();

      await assertValid(db, user);
      const rows = await db.rows(
        `select position from rankings where user_id = $1 and category = 'movies' order by position`,
        [user],
      );
      // Both landed, and the band arithmetic the category lock protects still produced
      // exactly 1..n. The second insertion recomputed the bounds inside the lock, which
      // is why it does not place a second title at the position the first one took.
      assert.deepEqual(
        rows.map((r) => r.position),
        [1, 2],
        'positions are 1..n with no gap and no duplicate (I1)',
      );

      await first.end();
      await second.end();
    });
  });

  /**
   * Replay, from two connections at once.
   *
   * The functional suite covers a replay made after the first call has committed, which
   * is the ordinary lost-reply case. This is the harder one: two transactions carrying
   * the same operation id *in flight together*, which is what a client with a retry
   * timer shorter than its server's tail latency actually produces.
   *
   * The property is that the second one does not proceed on a claim the first has not
   * finished writing an answer for. `insert … on conflict do nothing` waits on the
   * conflicting speculative insertion rather than skipping past it, so the replay reads
   * `result` only after the transaction that claimed the id has committed — or picks up
   * the claim itself if that transaction rolled back.
   */
  describe('an operation id replayed while the first attempt is still open', () => {
    before(() => rc.open());
    after(() => rc.close());

    it('waits for the first attempt and answers with what it decided', async () => {
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const film = await fx.createMovie('Concurrent replay');
      const op = await newOp(db);

      await db.armBarrier('rankings', 'replay');
      const ctl = await db.controller();
      await ctl.hold('replay');

      const first = await db.session('first');
      const replay = await db.session('replay');
      await first.actAs(user);
      await replay.actAs(user);

      await first.begin();
      await first.pauseAt('replay');
      const attempt = fire(first, `rank_start($1, 'loved', $2)`, [film, op]);
      await first.awaitBlocked();

      await replay.begin();
      const retry = fire(replay, `rank_start($1, 'loved', $2)`, [film, op]);
      // Waiting on the first transaction's ledger row, not on an advisory lock: the
      // speculative insertion is what holds it, which is the mechanism the migration's
      // §2 rests on.
      await replay.awaitBlocked({ on: 'transactionid' });

      await ctl.release('replay');
      const original = (await attempt).rows[0].r;
      await first.commit();
      const replayed = (await retry).rows[0].r;
      await replay.commit();

      assert.deepEqual(replayed, original, 'the replay is answered with the first answer');

      const rankings = await db.rows(
        `select 1 from rankings where user_id = $1 and media_item_id = $2`,
        [user, film],
      );
      const events = await db.rows(
        `select 1 from feed_events where actor_id = $1 and media_item_id = $2 and type = 'title_ranked'`,
        [user, film],
      );
      assert.equal(rankings.length, 1, 'one ranking');
      assert.equal(events.length, 1, 'and exactly one title_ranked event');
      await assertValid(db, user);

      await first.end();
      await replay.end();
      await ctl.end();
    });
  });
}
