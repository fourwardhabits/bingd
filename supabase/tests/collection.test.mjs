import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The six collection writes in api.md §1.
 *
 * Three properties here are worth more than the happy paths, because each one is a
 * rule the schema states somewhere and could quietly stop honouring:
 *
 *   - a replay is a successful no-op, not a duplicate and not an error
 *     (offline-sync.md §3),
 *   - set_bucket and unlog refuse a *ranked* title, since for a ranked title both
 *     are ranking mutations and PRD §18 forbids queuing those,
 *   - save_note refuses a write whose base version a later edit superseded rather than
 *     overwriting it, which offline-sync.md §5 promises and nothing enforced before —
 *     and refuses *only* that, since a conflict rule that fires on ordinary offline
 *     sequences trains people to dismiss it.
 */
describe('collection writes', () => {
  let t;
  let user;
  let movie;

  before(async () => {
    t = await createTestDb();
    user = await t.createUser({ username: 'collector' });
    movie = await t.createMovie('Stalker', 1001);
    await t.actAs(user);
  });

  after(async () => t.close());

  const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

  const call = async (sql, params) => {
    const { rows } = await t.sql(`select ${sql} as result`, params);
    return rows[0].result;
  };

  const collectionRow = async (mediaItemId) => {
    const { rows } = await t.sql(
      `select bucket, progress, watched_on, note, updated_at, note_updated_at
         from user_media where user_id = $1 and media_item_id = $2`,
      [user, mediaItemId],
    );
    return rows[0] ?? null;
  };

  // now() is the transaction timestamp, and the conflict comparison is truncated to
  // milliseconds, so two writes issued back to back can share a version. Anywhere a
  // test needs one write to be genuinely *later* than another, it has to wait.
  const pastAMillisecond = async () => t.sql(`select pg_sleep(0.005)`);

  describe('log_watched', () => {
    it('creates the collection row', async () => {
      const film = await t.createMovie('Solaris', 1002);
      const result = await call(`log_watched($1, $2, '2026-08-01', 'on 35mm')`, [
        await uuid(),
        film,
      ]);

      assert.equal(result.status, 'ok');
      const row = await collectionRow(film);
      assert.equal(row.note, 'on 35mm');
      assert.equal(row.watched_on.toISOString().slice(0, 10), '2026-08-01');
      assert.equal(
        new Date(result.note_version).getTime(),
        row.note_updated_at.getTime(),
        'a note written here needs a version too, or the client has none to send back',
      );
    });

    /**
     * The point of the idempotency ledger. The common cause of a replay is a response
     * lost on a flaky connection: the write did land, and the client never heard so.
     * Answering with an error would turn a successful write into a permanent failure
     * in the outbox.
     */
    it('treats a replay as success without writing again', async () => {
      const film = await t.createMovie('Mirror', 1003);
      const operation = await uuid();

      await call(`log_watched($1, $2, '2026-08-02')`, [operation, film]);
      const replay = await call(`log_watched($1, $2, '2026-01-01')`, [operation, film]);

      assert.equal(replay.status, 'already_applied');
      const row = await collectionRow(film);
      assert.equal(
        row.watched_on.toISOString().slice(0, 10),
        '2026-08-02',
        'the replay must not have applied its own arguments',
      );
    });

    it('does not erase a stored watch date when a later call omits one', async () => {
      const film = await t.createMovie('Ivan', 1004);
      await call(`log_watched($1, $2, '2026-07-04')`, [await uuid(), film]);
      await call(`log_watched($1, $2, null, 'a note')`, [await uuid(), film]);

      const row = await collectionRow(film);
      assert.equal(row.watched_on.toISOString().slice(0, 10), '2026-07-04');
      assert.equal(row.note, 'a note');
    });

    it('refuses a future watch date', async () => {
      const film = await t.createMovie('Unreleased', 1005);
      const err = await t.errorFrom(
        `select log_watched($1, $2, (current_date + 2)::date)`,
        [await uuid(), film],
      );
      assert.equal(err?.code, '22023');
    });

    /**
     * The server runs on UTC and the client sends a local date, so everywhere east of
     * UTC the local date is a day ahead of the server's for the first hours of the day.
     * Refusing current_date + 1 rejects a correct "I watched this tonight" for a large
     * part of every day depending on longitude, which is a worse failure than accepting
     * a date one day further out than any real timezone can justify.
     */
    it("accepts tomorrow's date, because a client east of UTC is not lying", async () => {
      const film = await t.createMovie('Tomorrow', 1026);
      const ok = await call(`log_watched($1, $2, (current_date + 1)::date)`, [
        await uuid(),
        film,
      ]);
      assert.equal(ok.status, 'ok');
    });

    it('refuses a title that does not exist', async () => {
      const err = await t.errorFrom(`select log_watched($1, $2)`, [await uuid(), await uuid()]);
      assert.equal(err?.code, 'P0002', 'BG404, per the api.md §8 mapping');
    });

    /**
     * PRD §10 forbids ranking a whole series, and the collection is what feeds
     * ranking. "I watched this series" is also ambiguous about which seasons, where
     * "I want to watch it" is not, which is why the watchlist accepts one.
     */
    it('refuses a series but allows its season', async () => {
      const series = await t.createSeries('Twin Peaks', 1006);
      const season = await t.createSeason(series, 1, 'Season 1');

      const err = await t.errorFrom(`select log_watched($1, $2)`, [await uuid(), series]);
      assert.equal(err?.code, '22023');

      const ok = await call(`log_watched($1, $2)`, [await uuid(), season]);
      assert.equal(ok.status, 'ok');
    });
  });

  describe('set_bucket', () => {
    it('creates the row when the title was never logged', async () => {
      // A bucket is a statement about something the user has seen, so bucketing
      // implies logging. Requiring two calls would leave a window in which the title
      // is watched with no opinion attached, which the UI never asks for.
      const film = await t.createMovie('Nostalghia', 1007);
      await call(`set_bucket($1, $2, 'loved')`, [await uuid(), film]);

      assert.equal((await collectionRow(film)).bucket, 'loved');
    });

    it('changes an existing bucket', async () => {
      const film = await t.createMovie('Sacrifice', 1008);
      await call(`set_bucket($1, $2, 'fine')`, [await uuid(), film]);
      await call(`set_bucket($1, $2, 'not_for_me')`, [await uuid(), film]);

      assert.equal((await collectionRow(film)).bucket, 'not_for_me');
    });

    it('refuses null', async () => {
      const err = await t.errorFrom(`select set_bucket($1, $2, null)`, [await uuid(), movie]);
      assert.equal(err?.code, '22023');
    });
  });

  /**
   * The rule the allowlist cannot express. Both of these are queueable functions, and
   * for a *ranked* title both are ranking mutations: set_bucket becomes a band move
   * and a renumber, unlog deletes a position and closes the gap. Queued, either one
   * applies silently on reconnect and discards work built over dozens of comparisons.
   *
   * The general form, which matters for every RPC added later: a function is queueable
   * only if it is queueable for every state its target row can be in.
   */
  describe('a ranked title', () => {
    let ranked;

    before(async () => {
      ranked = await t.createMovie('Andrei Rublev', 1009);
      await call(`set_bucket($1, $2, 'loved')`, [await uuid(), ranked]);
      await t.sql(`select rank_start($1, 'loved'::taste_bucket)`, [ranked]);

      const { rows } = await t.sql(
        `select count(*)::int as n from rankings where user_id = $1 and media_item_id = $2`,
        [user, ranked],
      );
      assert.equal(rows[0].n, 1, 'the fixture must actually be ranked, or this suite proves nothing');
    });

    it('refuses set_bucket with the wrong-state code', async () => {
      const err = await t.errorFrom(`select set_bucket($1, $2, 'fine')`, [await uuid(), ranked]);
      assert.equal(err?.code, '55000', 'BG409: the client routes to rank_rebucket instead');
    });

    it('refuses unlog with the wrong-state code', async () => {
      const err = await t.errorFrom(`select unlog($1, $2)`, [await uuid(), ranked]);
      assert.equal(err?.code, '55000', 'BG409: unrank first, which is online-only');
    });

    it('still allows a note and a watch date, which are not ranking', async () => {
      const ok = await call(`log_watched($1, $2, '2026-05-05')`, [await uuid(), ranked]);
      assert.equal(ok.status, 'ok');
    });
  });

  describe('unlog', () => {
    it('removes the row', async () => {
      const film = await t.createMovie('Ran', 1010);
      await call(`log_watched($1, $2)`, [await uuid(), film]);
      await call(`unlog($1, $2)`, [await uuid(), film]);

      assert.equal(await collectionRow(film), null);
    });

    it('reports a title that was never in the collection', async () => {
      // offline-sync.md §5: an operation against something already gone fails and
      // leaves the queue, rather than retrying against a row that will never return.
      const film = await t.createMovie('Dersu', 1011);
      const err = await t.errorFrom(`select unlog($1, $2)`, [await uuid(), film]);
      assert.equal(err?.code, 'P0002');
    });

    /**
     * Removal takes the activity with it — founder correction, 2026-08-18,
     * `20260818000100`.
     *
     * The gap this closes: `feed_events` has no foreign key to `user_media`, so the
     * feed went on saying "ranked Inception" about a title the collection no longer
     * held. The collection said gone and every social surface said ranked.
     */
    describe('and the activity that claimed it', () => {
      const eventsFor = async (userId, mediaItemId) => {
        const { rows } = await t.sql(
          `select id, type from feed_events
             where actor_id = $1 and media_item_id = $2 order by created_at`,
          [userId, mediaItemId],
        );
        return rows;
      };

      it('deletes every ranking event for that title, not merely the latest', async () => {
        const film = await t.createMovie('Ikiru', 1030);
        // Ranking, unranking and ranking again: `_rank_finalize` writes a new event
        // each time a ranking completes, so a (user, title) pair holds several and
        // every one of them claims the title is in the collection.
        await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
        await t.sql(`select rank_unrank($1)`, [film]);
        await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
        assert.ok(
          (await eventsFor(user, film)).length >= 2,
          'the fixture needs more than one event for this test to mean anything',
        );

        await t.sql(`select rank_unrank($1)`, [film]);
        await call(`unlog($1, $2)`, [await uuid(), film]);

        assert.deepEqual(await eventsFor(user, film), []);
      });

      it('takes the reactions and comments on those events with them', async () => {
        const film = await t.createMovie('Yojimbo', 1031);
        await t.rankToCompletion(film, 'loved', async (pivot) => pivot);
        const [event] = await eventsFor(user, film);

        const fan = await t.createUser({ username: 'unlog_fan' });
        await t.asUser(fan, async () => {
          await t.sql(`select set_reaction($1, $2, 'love')`, [await uuid(), event.id]);
          await t.sql(`select add_comment($1, $2, 'yes', false)`, [await uuid(), event.id]);
        });

        const counts = async () => {
          const { rows } = await t.sql(
            `select (select count(*)::int from reactions where feed_event_id = $1) as reactions,
                    (select count(*)::int from comments  where feed_event_id = $1) as comments,
                    (select count(*)::int from notifications
                      where subject_type = 'feed_event' and subject_id = $1) as notices`,
            [event.id],
          );
          return rows[0];
        };
        assert.deepEqual(await counts(), { reactions: 1, comments: 1, notices: 2 });

        await t.actAs(user);
        await t.sql(`select rank_unrank($1)`, [film]);
        await call(`unlog($1, $2)`, [await uuid(), film]);

        // Reactions and comments cascade off the foreign key. The notifications do
        // not — `notifications.subject_id` is a bare uuid — so `unlog` removes them
        // itself, or `my_notifications` would render a notice about a null title.
        assert.deepEqual(await counts(), { reactions: 0, comments: 0, notices: 0 });
      });

      it('leaves other people, other titles and other kinds of event alone', async () => {
        const mine = await t.createMovie('Sanjuro', 1032);
        const other = await t.createMovie('Rashomon', 1033);
        await t.rankToCompletion(mine, 'loved', async (pivot) => pivot);
        await t.rankToCompletion(other, 'loved', async (pivot) => pivot);

        const stranger = await t.createUser({ username: 'unlog_stranger' });
        await t.asUser(stranger, async () => {
          await t.rankToCompletion(mine, 'loved', async (pivot) => pivot);
        });

        // A list membership is a different claim from a collection membership, and
        // removing a title from a collection does not make it untrue.
        await t.sql(
          `insert into feed_events (actor_id, type, media_item_id) values ($1, 'list_added', $2)`,
          [user, mine],
        );

        await t.actAs(user);
        await t.sql(`select rank_unrank($1)`, [mine]);
        await call(`unlog($1, $2)`, [await uuid(), mine]);

        assert.deepEqual(
          (await eventsFor(user, mine)).map((row) => row.type),
          ['list_added'],
        );
        assert.equal((await eventsFor(stranger, mine)).length, 1, "not the stranger's");
        assert.equal((await eventsFor(user, other)).length, 1, 'not the other title');
      });

      it('does not put the title back on the watchlist', async () => {
        const film = await t.createMovie('Throne of Blood', 1034);
        await call(`log_watched($1, $2)`, [await uuid(), film]);
        await call(`unlog($1, $2)`, [await uuid(), film]);

        const { rows } = await t.sql(
          `select count(*)::int as n from watchlist where user_id = $1 and media_item_id = $2`,
          [user, film],
        );
        // Removal is not a decision to watch it again. Founder instruction.
        assert.equal(rows[0].n, 0);
      });
    });
  });

  describe('set_watchlist', () => {
    it('adds, is safe to repeat, and removes', async () => {
      const film = await t.createMovie('Kagemusha', 1012);
      const present = async () => {
        const { rows } = await t.sql(
          `select count(*)::int as n from watchlist where user_id = $1 and media_item_id = $2`,
          [user, film],
        );
        return rows[0].n;
      };

      await call(`set_watchlist($1, $2, true)`, [await uuid(), film]);
      await call(`set_watchlist($1, $2, true)`, [await uuid(), film]);
      assert.equal(await present(), 1, 'a second add must not duplicate the row');

      await call(`set_watchlist($1, $2, false)`, [await uuid(), film]);
      assert.equal(await present(), 0);
    });

    it('accepts a series, which log_watched does not', async () => {
      const series = await t.createSeries('Berlin Alexanderplatz', 1013);
      const ok = await call(`set_watchlist($1, $2, true)`, [await uuid(), series]);
      assert.equal(ok.status, 'ok');
    });

    it('reports a title that does not exist even when removing', async () => {
      const err = await t.errorFrom(`select set_watchlist($1, $2, false)`, [
        await uuid(),
        await uuid(),
      ]);
      assert.equal(err?.code, 'P0002', 'silently succeeding would hide a client bug');
    });
  });

  describe('set_season_progress', () => {
    it('records progress on a season', async () => {
      const series = await t.createSeries('The Wire', 1014);
      const season = await t.createSeason(series, 2, 'Season 2');

      await call(`set_season_progress($1, $2, 'watching')`, [await uuid(), season]);
      assert.equal((await collectionRow(season)).progress, 'watching');

      await call(`set_season_progress($1, $2, 'completed')`, [await uuid(), season]);
      assert.equal((await collectionRow(season)).progress, 'completed');
    });

    it('refuses a film', async () => {
      const err = await t.errorFrom(`select set_season_progress($1, $2, 'watching')`, [
        await uuid(),
        movie,
      ]);
      assert.equal(err?.code, '22023');
    });
  });

  describe('save_note', () => {
    it('replaces the note and hands back the new version', async () => {
      const film = await t.createMovie('Barry Lyndon', 1015);
      await call(`log_watched($1, $2)`, [await uuid(), film]);
      const result = await call(`save_note($1, $2, 'the candlelight')`, [await uuid(), film]);

      const row = await collectionRow(film);
      assert.equal(row.note, 'the candlelight');
      assert.equal(
        new Date(result.note_version).getTime(),
        row.note_updated_at.getTime(),
        'a client draining several edits needs the version back to carry the base forward',
      );
    });

    it('refuses a title that is not in the collection', async () => {
      const film = await t.createMovie('Paths of Glory', 1016);
      const err = await t.errorFrom(`select save_note($1, $2, 'x')`, [await uuid(), film]);
      assert.equal(err?.code, 'P0002');
    });

    /**
     * A note is the only free text a user writes, so losing one to a silent overwrite
     * is a real loss rather than an inconvenience — offline-sync.md §5.
     *
     * Divergence here is genuine: a second edit actually lands between the base being
     * read and the stale write arriving. The earlier version of this test faked
     * staleness with `now() - interval '1 hour'`, which proved only that a mismatching
     * timestamp raises. It never exercised the other half — the version *advancing* on
     * an edit — so it passed with the trigger dropped while real divergence was
     * silently overwritten. The assertion on the stored note is what pins that half:
     * with no version trigger, the write below lands and the second edit is gone.
     */
    it('refuses a write based on a version a later edit has superseded', async () => {
      const film = await t.createMovie('The Shining', 1017);
      await call(`log_watched($1, $2)`, [await uuid(), film]);
      await call(`save_note($1, $2, 'from this device')`, [await uuid(), film]);
      const base = (await collectionRow(film)).note_updated_at;

      await pastAMillisecond();
      await call(`save_note($1, $2, 'from the other device')`, [await uuid(), film]);

      const err = await t.errorFrom(`select save_note($1, $2, 'typed offline', $3)`, [
        await uuid(),
        film,
        base,
      ]);

      assert.equal(err?.code, '55000');
      assert.equal(
        (await collectionRow(film)).note,
        'from the other device',
        'the superseding edit must survive, or the conflict rule protects nothing',
      );

      /**
       * The detail carries the server's version and deliberately not the server's
       * text: Postgres logs an exception's DETAIL at default settings, and a note is
       * always-private under PRD §22. The client owns the row, so it reads its own
       * note to show the choice.
       */
      const detail = JSON.parse(err.detail);
      assert.equal(detail.conflict, 'note');
      assert.ok(detail.server_version, 'the client needs a version it can rebase onto');
      assert.equal(
        JSON.stringify(detail).includes('from the other device'),
        false,
        'private note text must not reach the database log',
      );
    });

    /**
     * The defect this column exists for. updated_at moves on every write to the row,
     * so while the base was read from it, the ordinary offline sequence — tap a bucket,
     * then write a note, drained in that order — raised a guaranteed conflict about a
     * note nothing had touched. A dialog that cries wolf on a routine session teaches
     * people to dismiss it, which is exactly when it needs to be believed.
     */
    it('is not disturbed by an unrelated write to the same title', async () => {
      const film = await t.createMovie('Days of Heaven', 1022);
      await call(`log_watched($1, $2)`, [await uuid(), film]);
      await call(`save_note($1, $2, 'the magic hour')`, [await uuid(), film]);
      const base = (await collectionRow(film)).note_updated_at;

      await pastAMillisecond();
      await call(`set_bucket($1, $2, 'loved')`, [await uuid(), film]);

      const before = await collectionRow(film);
      assert.notEqual(
        before.updated_at.getTime(),
        base.getTime(),
        'the bucket write must really have moved the row version, or this proves nothing',
      );

      const ok = await call(`save_note($1, $2, 'edited offline', $3)`, [
        await uuid(),
        film,
        base,
      ]);
      assert.equal(ok.status, 'ok');
      assert.equal((await collectionRow(film)).note, 'edited offline');
    });

    it('accepts the version it last handed out, so a drain can chain edits', async () => {
      const film = await t.createMovie('Full Metal Jacket', 1018);
      await call(`log_watched($1, $2)`, [await uuid(), film]);
      const first = await call(`save_note($1, $2, 'first')`, [await uuid(), film]);

      await pastAMillisecond();
      const second = await call(`save_note($1, $2, 'second', $3)`, [
        await uuid(),
        film,
        first.note_version,
      ]);

      assert.equal(second.status, 'ok');
      assert.equal((await collectionRow(film)).note, 'second');
    });

    /**
     * A base version against a row that has never held a note. There is no text to
     * lose, so asking the user to resolve a conflict would be asking about nothing.
     */
    it('accepts a base version when no note has ever been stored', async () => {
      const film = await t.createMovie('Solaris 1972', 1023);
      await call(`log_watched($1, $2)`, [await uuid(), film]);
      const row = await collectionRow(film);
      assert.equal(row.note_updated_at, null);

      const stale = (await t.sql(`select (now() - interval '1 hour') as t`)).rows[0].t;
      const ok = await call(`save_note($1, $2, 'the first note', $3)`, [
        await uuid(),
        film,
        stale,
      ]);
      assert.equal(ok.status, 'ok');
    });

    /**
     * A note created by log_watched rather than save_note still gets a version. With an
     * update-only trigger it would read as "never written" and a stale queued edit
     * would overwrite it without a word.
     */
    it('versions a note written at creation time', async () => {
      const film = await t.createMovie('Come and See', 1024);
      await call(`log_watched($1, $2, null, 'devastating')`, [await uuid(), film]);
      assert.ok((await collectionRow(film)).note_updated_at);

      const stale = (await t.sql(`select (now() - interval '1 hour') as t`)).rows[0].t;
      const err = await t.errorFrom(`select save_note($1, $2, 'overwrite me', $3)`, [
        await uuid(),
        film,
        stale,
      ]);
      assert.equal(err?.code, '55000');
    });

    /**
     * Postgres keeps microseconds; JavaScript's Date holds milliseconds. Any client
     * that parses the timestamp and serializes it again loses the difference, and
     * compared exactly that mismatch reads as a conflict — so every note edit would
     * demand the user resolve a divergence between a text and itself.
     */
    it('tolerates a base version truncated to milliseconds', async () => {
      const film = await t.createMovie('Eyes Wide Shut', 1019);
      await call(`log_watched($1, $2, null, 'the mask')`, [await uuid(), film]);

      const { rows } = await t.sql(
        `select date_trunc('milliseconds', note_updated_at) as truncated
           from user_media where user_id = $1 and media_item_id = $2`,
        [user, film],
      );

      const ok = await call(`save_note($1, $2, 'fine', $3)`, [
        await uuid(),
        film,
        rows[0].truncated,
      ]);
      assert.equal(ok.status, 'ok');
    });

    it('refuses a note longer than the cap', async () => {
      const film = await t.createMovie('War and Peace', 1025);
      await call(`log_watched($1, $2)`, [await uuid(), film]);
      const err = await t.errorFrom(`select save_note($1, $2, repeat('x', 2001))`, [
        await uuid(),
        film,
      ]);
      assert.equal(err?.code, '22023', 'a field error, not an invariant violation');

      // And on the column too, following reports.note: the function's raise is the
      // legible error, the constraint is what survives user_media gaining a writer.
      const direct = await t.errorFrom(
        `update user_media set note = repeat('x', 2001)
          where user_id = $1 and media_item_id = $2`,
        [user, film],
      );
      assert.equal(direct?.code, '23514');
    });
  });

  /**
   * Idempotency is scoped to the account, not global, which is a deliberate deviation
   * from offline-sync.md §3's `on conflict (operation_id)`. Operation ids are generated
   * on the device, so a modified client could send one already used by someone else; with
   * a global key that returns 'already_applied' and writes nothing, and the victim's
   * client shows success because the response says so. Silent, targeted data loss.
   */
  it('scopes an operation id to its own account', async () => {
    const other = await t.createUser({ username: 'someone_else' });
    const film = await t.createMovie('Chungking Express', 1020);
    const operation = await uuid();

    await call(`log_watched($1, $2)`, [operation, film]);

    await t.actAs(other);
    const result = await call(`log_watched($1, $2)`, [operation, film]);
    await t.actAs(user);

    assert.equal(result.status, 'ok', 'another account reusing the id must not be silenced');
    const { rows } = await t.sql(
      `select count(*)::int as n from user_media where user_id = $1 and media_item_id = $2`,
      [other, film],
    );
    assert.equal(rows[0].n, 1, 'and the write must actually have happened');
  });

  /**
   * The ledger row and the write commit together or not at all. If a claim survived a
   * failed operation, the outbox entry would be poisoned: every retry would answer
   * 'already_applied' for a write that never happened, and the client would report
   * success forever. This holds because the raise rolls back the whole function, but
   * nothing pinned it.
   */
  it('leaves no claim behind when the operation fails, so a retry can still work', async () => {
    const film = await t.createMovie('Retry', 1027);
    const operation = await uuid();

    const err = await t.errorFrom(`select log_watched($1, $2, (current_date + 2)::date)`, [
      operation,
      film,
    ]);
    assert.equal(err?.code, '22023');

    const { rows } = await t.sql(
      `select count(*)::int as n from processed_operations
        where user_id = $1 and operation_id = $2`,
      [user, operation],
    );
    assert.equal(rows[0].n, 0);

    const ok = await call(`log_watched($1, $2, '2026-05-05')`, [operation, film]);
    assert.equal(ok.status, 'ok', 'the corrected retry must apply, not answer already_applied');
    assert.equal((await collectionRow(film)).watched_on.toISOString().slice(0, 10), '2026-05-05');
  });

  it('refuses a null operation id', async () => {
    const err = await t.errorFrom(`select log_watched(null, $1)`, [movie]);
    assert.equal(err?.code, '22023', 'a missing id would make the write unrepeatable');
  });

  /**
   * The suspension guard. Every one of these is a write, so every one must refuse
   * while the account is suspended. moderation.test.mjs asserts structurally that no
   * client-callable write skips assert_can_write; this checks the behaviour through
   * one of them.
   */
  it('refuses every write from a suspended account', async () => {
    const suspended = await t.createUser({ username: 'suspended_one' });
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [suspended]);
    const film = await t.createMovie('Persona', 1021);

    await t.actAs(suspended);
    const errors = await Promise.all([
      t.errorFrom(`select log_watched($1, $2)`, [await uuid(), film]),
      t.errorFrom(`select set_bucket($1, $2, 'loved')`, [await uuid(), film]),
      t.errorFrom(`select set_watchlist($1, $2, true)`, [await uuid(), film]),
      t.errorFrom(`select unlog($1, $2)`, [await uuid(), film]),
    ]);
    await t.actAs(user);

    for (const err of errors) {
      assert.equal(err?.code, '42501');
    }
  });
});
