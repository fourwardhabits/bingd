import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { call, fire, newOp, raceContext } from './_shared.mjs';

/**
 * The watch-history races — epic §O.4.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE AND NOT OTHERS
 *
 * The epic names seven, and each one is a way for the §D.0 invariant — **a seen title
 * has at least one watch event** — or for the cache to come apart under two writers:
 *
 *   `log_rewatch` ∥ `unlog`              a viewing attached to a row being deleted
 *   `log_rewatch` ∥ a rewatch finalize   two writers on one title's history
 *   `edit_watch_event` ∥ `delete…`       one row edited while it is removed
 *   import apply ∥ `log_rewatch`         a diary arriving beside a live viewing
 *   `log_title` ∥ `set_bucket`           two creators, and **exactly one** event
 *   replays of every new RPC             the ledger, under real concurrency
 *
 * The last of those is the one a single-connection harness cannot ask at all, which is
 * why this file exists rather than more cases in `watch-events.test.mjs`: PGlite has one
 * backend, so `_lock_media` never contends and a replay never races its original.
 *
 * **Every test asserts the invariant afterwards**, from the schema's own checker rather
 * than from a copy written here. A lock that serialises two writers into a consistent
 * order is worth nothing if the order it produces leaves a cache that disagrees with
 * its events.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  const events = async (db, user, item) =>
    db.rows(
      `select id, watched_on, basis from watch_events
        where user_id = $1 and media_item_id = $2
        order by watched_on nulls first, recorded_at`,
      [user, item],
    );

  const cached = async (db, user, item) => {
    const rows = await db.rows(
      `select watched_on from user_media where user_id = $1 and media_item_id = $2`,
      [user, item],
    );
    return rows[0]?.watched_on ?? null;
  };

  /** W1–W5, from `assert_watch_history_valid` rather than from a second definition. */
  const assertValid = (db, user) =>
    db.sql(`select assert_watch_history_valid($1)`, [user]);

  describe('watch history under two writers', () => {
    before(() => rc.open());
    after(() => rc.close());

    it('log_title ∥ set_bucket on a new title leaves EXACTLY one event', async () => {
      /**
       * The invariant's sharpest case. Both calls can create the `user_media` row, and
       * the deferred `_seen_implies_a_watch` trigger fires at commit — so without the
       * media lock the loser's trigger could see no event at the moment it looked and
       * add a second one beside the date `log_title` had just written. That is §O.6.3's
       * double count, produced by a race rather than by a rule.
       */
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const film = await fx.createMovie('Log title versus set bucket');

      await db.armBarrier('user_media', 'lt-vs-sb');
      const ctl = await db.controller();
      await ctl.hold('lt-vs-sb');

      const logger = await db.session('logger');
      const bucketer = await db.session('bucketer');
      await logger.actAs(user);
      await bucketer.actAs(user);

      await logger.begin();
      await logger.pauseAt('lt-vs-sb');
      const logging = fire(
        logger,
        `log_title($1, $2, 'loved'::taste_bucket, current_date, 'today_default'::watch_date_basis)`,
        [await newOp(db), film],
      );
      await logger.awaitBlocked();

      await bucketer.begin();
      const bucketing = bucketer.errorFrom(`select set_bucket($1, $2, 'fine'::taste_bucket)`, [
        await newOp(db),
        film,
      ]);

      // Correlated with `_lock_media`'s key, so a plain row lock cannot satisfy it.
      const waiting = await bucketer.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.mediaKey(user, film),
      });
      assert.equal(waiting.wait_event, 'advisory');

      await ctl.release('lt-vs-sb');
      await logging;
      await logger.commit();
      await bucketing;
      await bucketer.commit();

      const rows = await events(db, user, film);
      assert.equal(rows.length, 1, 'one title becoming seen is one viewing');
      assert.notEqual(rows[0].watched_on, null, 'and it kept the date log_title wrote');
      await assertValid(db, user);

      await logger.end();
      await bucketer.end();
      await ctl.end();
    });

    it('log_rewatch ∥ unlog: the viewing goes with the row, or never lands', async () => {
      /**
       * `unlog` deletes the collection row; the FK cascades every event with it. The
       * failure without the lock is an event inserted against a row that is being
       * deleted in another transaction — either a foreign-key violation the reader sees
       * as a crash, or, worse, a row that survives its parent. Both are W4.
       */
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const film = await fx.createMovie('Rewatch versus unlog');

      const setup = await db.session('setup');
      await setup.actAs(user);
      await call(setup, `set_bucket($1, $2, 'loved'::taste_bucket)`, [await newOp(db), film]);
      await setup.end();

      await db.armBarrier('watch_events', 'rw-vs-unlog');
      const ctl = await db.controller();
      await ctl.hold('rw-vs-unlog');

      const watcher = await db.session('watcher');
      const remover = await db.session('remover');
      await watcher.actAs(user);
      await remover.actAs(user);

      await watcher.begin();
      await watcher.pauseAt('rw-vs-unlog');
      const watching = fire(
        watcher,
        `log_rewatch($1, $2, current_date, 'today_default'::watch_date_basis)`,
        [await newOp(db), film],
      );
      await watcher.awaitBlocked();

      await remover.begin();
      const removing = remover.errorFrom(`select unlog($1, $2)`, [await newOp(db), film]);
      await remover.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.mediaKey(user, film),
      });

      await ctl.release('rw-vs-unlog');
      await watching;
      await watcher.commit();
      await removing;
      await remover.commit();

      // The defined outcome: the rewatch landed first, then the row went and took its
      // whole history with it. What must NOT exist is an event with no collection row.
      assert.deepEqual(await events(db, user, film), [], 'the cascade took the history');
      await assertValid(db, user);

      await watcher.end();
      await remover.end();
      await ctl.end();
    });

    it('two log_rewatch calls on one title serialise, and both viewings survive', async () => {
      // Two devices, one film, one evening. Both are real viewings — §D.2 allows a
      // same-day duplicate deliberately — and the cache must equal the maximum after
      // both, not after whichever committed last.
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const film = await fx.createMovie('Two rewatches at once');

      const setup = await db.session('setup');
      await setup.actAs(user);
      await call(setup, `set_bucket($1, $2, 'loved'::taste_bucket)`, [await newOp(db), film]);
      await setup.end();

      await db.armBarrier('watch_events', 'rw-vs-rw');
      const ctl = await db.controller();
      await ctl.hold('rw-vs-rw');

      const phone = await db.session('phone');
      const tablet = await db.session('tablet');
      await phone.actAs(user);
      await tablet.actAs(user);

      await phone.begin();
      await phone.pauseAt('rw-vs-rw');
      const first = fire(
        phone,
        `log_rewatch($1, $2, current_date - 1, 'reader'::watch_date_basis)`,
        [await newOp(db), film],
      );
      await phone.awaitBlocked();

      await tablet.begin();
      const second = tablet.errorFrom(
        `select log_rewatch($1, $2, current_date, 'today_default'::watch_date_basis)`,
        [await newOp(db), film],
      );
      await tablet.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.mediaKey(user, film),
      });

      await ctl.release('rw-vs-rw');
      await first;
      await phone.commit();
      await second;
      await tablet.commit();

      const rows = await events(db, user, film);
      assert.equal(rows.length, 3, 'the original seen event plus two viewings');

      const max = rows
        .map((r) => r.watched_on)
        .filter(Boolean)
        .sort()
        .at(-1);
      assert.equal(
        String(await cached(db, user, film)),
        String(max),
        'the cache is the maximum over BOTH, not over whichever won',
      );
      await assertValid(db, user);

      await phone.end();
      await tablet.end();
      await ctl.end();
    });

    it('edit_watch_event ∥ delete_watch_event on one row leaves a consistent cache', async () => {
      // The reader changes a date on one device and removes that viewing on another.
      // Either order is a defensible outcome; a cache that no longer equals the maximum
      // is not, and that is what W3 catches.
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const film = await fx.createMovie('Edit versus delete');

      const setup = await db.session('setup');
      await setup.actAs(user);
      await call(setup, `set_bucket($1, $2, 'loved'::taste_bucket)`, [await newOp(db), film]);
      const logged = await call(
        setup,
        `log_rewatch($1, $2, current_date, 'today_default'::watch_date_basis)`,
        [await newOp(db), film],
      );
      await setup.end();
      const target = logged.watch_event_id;

      // On the UPDATE, not the default INSERT: `edit_watch_event` changes a row's date
      // and inserts nothing, so an insert barrier never fires — the edit runs straight
      // through, `awaitBlocked` finds an idle transaction, and the open transaction it
      // leaves behind then breaks the NEXT test's barrier. Both failures, one cause.
      await db.armBarrier('watch_events', 'edit-vs-del', { event: 'update' });
      const ctl = await db.controller();
      await ctl.hold('edit-vs-del');

      const editor = await db.session('editor');
      const deleter = await db.session('deleter');
      await editor.actAs(user);
      await deleter.actAs(user);

      await editor.begin();
      await editor.pauseAt('edit-vs-del');
      const editing = fire(
        editor,
        `edit_watch_event($1, $2, date '2019-03-03', 'reader'::watch_date_basis)`,
        [await newOp(db), target],
      );
      await editor.awaitBlocked();

      await deleter.begin();
      const deleting = deleter.errorFrom(`select delete_watch_event($1, $2)`, [
        await newOp(db),
        target,
      ]);
      await deleter.awaitBlocked({
        on: 'advisory',
        advisoryKey: await db.mediaKey(user, film),
      });

      await ctl.release('edit-vs-del');
      await editing;
      await editor.commit();
      await deleting;
      await deleter.commit();

      const rows = await events(db, user, film);
      assert.equal(rows.length, 1, 'the edited viewing was then removed');
      await assertValid(db, user);

      await editor.end();
      await deleter.end();
      await ctl.end();
    });

    it('a replayed log_rewatch under real concurrency logs ONE viewing', async () => {
      /**
       * The case a single-connection harness cannot construct: the retry arrives while
       * the original is still in flight. `_claim_operation_result` inserts the ledger
       * row first, so the second caller blocks on that unique index rather than on the
       * media lock — and then reads back the stored answer instead of running again.
       *
       * Without it, one tap on a bad connection is two viewings and two feed posts.
       */
      const { db, fx } = ctx;
      const user = await fx.createUser();
      const film = await fx.createMovie('Replayed rewatch');

      const setup = await db.session('setup');
      await setup.actAs(user);
      await call(setup, `set_bucket($1, $2, 'loved'::taste_bucket)`, [await newOp(db), film]);
      await setup.end();

      const op = await newOp(db);

      await db.armBarrier('watch_events', 'replay-rw');
      const ctl = await db.controller();
      await ctl.hold('replay-rw');

      const original = await db.session('original');
      const retry = await db.session('retry');
      await original.actAs(user);
      await retry.actAs(user);

      await original.begin();
      await original.pauseAt('replay-rw');
      const first = fire(
        original,
        `log_rewatch($1, $2, current_date, 'today_default'::watch_date_basis)`,
        [op, film],
      );
      await original.awaitBlocked();

      await retry.begin();
      const second = retry.errorFrom(
        `select log_rewatch($1, $2, current_date, 'today_default'::watch_date_basis)`,
        [op, film],
      );
      await retry.awaitBlocked();

      await ctl.release('replay-rw');
      await first;
      await original.commit();
      await second;
      await retry.commit();

      const rows = await events(db, user, film);
      assert.equal(rows.length, 2, 'the seen event and ONE rewatch');

      const posts = await db.rows(
        `select id from feed_events where actor_id = $1 and media_item_id = $2
           and type = 'title_ranked'`,
        [user, film],
      );
      assert.ok(posts.length <= 1, 'and at most one activity for one viewing');
      await assertValid(db, user);

      await original.end();
      await retry.end();
      await ctl.end();
    });
  });
}
