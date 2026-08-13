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
 *   - save_note refuses a stale write and hands back both texts rather than
 *     overwriting, which offline-sync.md §5 promises and nothing enforced before.
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
      `select bucket, progress, watched_on, note, updated_at
         from user_media where user_id = $1 and media_item_id = $2`,
      [user, mediaItemId],
    );
    return rows[0] ?? null;
  };

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
        `select log_watched($1, $2, (current_date + 1)::date)`,
        [await uuid(), film],
      );
      assert.equal(err?.code, '22023');
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
    it('replaces the note', async () => {
      const film = await t.createMovie('Barry Lyndon', 1015);
      await call(`log_watched($1, $2)`, [await uuid(), film]);
      await call(`save_note($1, $2, 'the candlelight')`, [await uuid(), film]);

      assert.equal((await collectionRow(film)).note, 'the candlelight');
    });

    it('refuses a title that is not in the collection', async () => {
      const film = await t.createMovie('Paths of Glory', 1016);
      const err = await t.errorFrom(`select save_note($1, $2, 'x')`, [await uuid(), film]);
      assert.equal(err?.code, 'P0002');
    });

    /**
     * A note is the only free text a user writes, so losing one to a silent overwrite
     * is a real loss rather than an inconvenience. This is the mechanism behind
     * offline-sync.md §5's promise, and the promise had nothing behind it until
     * updated_at got a trigger and the call got a base version.
     */
    it('refuses a stale write and returns both texts', async () => {
      const film = await t.createMovie('The Shining', 1017);
      await call(`log_watched($1, $2)`, [await uuid(), film]);
      await call(`save_note($1, $2, 'typed on the device')`, [await uuid(), film]);

      const stale = (await t.sql(`select (now() - interval '1 hour') as t`)).rows[0].t;
      const err = await t.errorFrom(`select save_note($1, $2, 'typed offline', $3)`, [
        await uuid(),
        film,
        stale,
      ]);

      assert.equal(err?.code, '55000');
      const detail = JSON.parse(err.detail);
      assert.equal(detail.mine, 'typed offline');
      assert.equal(detail.theirs, 'typed on the device', 'the client cannot offer a choice without both');
    });

    it('accepts a matching base version', async () => {
      const film = await t.createMovie('Full Metal Jacket', 1018);
      await call(`log_watched($1, $2)`, [await uuid(), film]);
      const { updated_at } = await collectionRow(film);

      const ok = await call(`save_note($1, $2, 'later', $3)`, [await uuid(), film, updated_at]);
      assert.equal(ok.status, 'ok');
    });

    /**
     * Postgres keeps microseconds; JavaScript's Date holds milliseconds. Any client
     * that parses the timestamp and serializes it again loses the difference, and
     * compared exactly that mismatch reads as a conflict — so every note edit would
     * demand the user resolve a divergence between a text and itself.
     */
    it('tolerates a base version truncated to milliseconds', async () => {
      const film = await t.createMovie('Eyes Wide Shut', 1019);
      await call(`log_watched($1, $2)`, [await uuid(), film]);

      const { rows } = await t.sql(
        `select date_trunc('milliseconds', updated_at) as truncated
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
