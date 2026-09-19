import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Watch next (20260929000200).
 *
 * Three promises, and this file tries to break each one:
 *
 *   1. **At most three, whoever writes.** The writer refuses a fourth, and the table itself
 *      refuses one that bypasses the writer.
 *   2. **A subset of the Watchlist, by construction.** Every path that removes a Watchlist
 *      row removes its pin — asserted per path, because "the foreign key cascades" is a
 *      claim about the schema and each path is a claim about a real writer.
 *   3. **Private, and silent.** Nobody but the owner reads a pin, and no pin writes a feed
 *      event or a notification.
 *
 * Reads that assert privacy go through `t.asUser` so RLS applies; everything else runs as
 * the owner with `actAs`, which is how the writers are called by a client.
 */

let t;
let seq = 98000;
let me;

const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

const call = async (sql, params = []) => (await t.sql(`select ${sql} as r`, params)).rows[0].r;

const movie = () => t.createMovie(`wn_${seq}`, seq++);

const save = async (id) => call(`set_watchlist($1, $2, true)`, [await uuid(), id]);
const unsave = async (id) => call(`set_watchlist($1, $2, false)`, [await uuid(), id]);

const pin = async (id, replacing = null) =>
  replacing
    ? call(`set_watch_next($1, $2, true, $3)`, [await uuid(), id, replacing])
    : call(`set_watch_next($1, $2, true)`, [await uuid(), id]);

const unpin = async (id) => call(`set_watch_next($1, $2, false)`, [await uuid(), id]);

const pinsOf = async (who) =>
  (
    await t.sql(`select media_item_id, slot from watch_next where user_id = $1 order by slot`, [
      who,
    ])
  ).rows;

/** Three saved films, pinned in order. */
const pinThree = async () => {
  const ids = [await movie(), await movie(), await movie()];
  for (const id of ids) {
    await save(id);
    assert.equal((await pin(id)).status, 'ok');
  }
  return ids;
};

before(async () => {
  t = await createTestDb();
  await t.sql(
    `update app_config set value = '100000'::jsonb where key = 'watch_next.max_per_day'`,
  );
});

after(async () => {
  await t?.close();
});

beforeEach(async () => {
  me = await t.createUser({ username: `wn${seq++}` });
  await t.actAs(me);
});

describe('pinning', () => {
  it('pins a Watchlist title into the lowest free slot and reports the pins in order', async () => {
    const [a, b] = [await movie(), await movie()];
    await save(a);
    await save(b);

    assert.deepEqual(await pin(a), { status: 'ok', replaced: false, pinned: [a] });
    assert.deepEqual((await pin(b)).pinned, [a, b]);
    assert.deepEqual(
      (await pinsOf(me)).map((r) => r.slot),
      [1, 2],
    );
  });

  it('pins a series and a season as readily as a film', async () => {
    const show = await t.createSeries(`wn_show_${seq}`, seq++);
    const season = await t.createSeason(show, 1, 'Season 1');
    await save(show);
    await save(season);

    assert.equal((await pin(show)).status, 'ok');
    assert.equal((await pin(season)).status, 'ok');
  });

  it('refuses a title that is not on the Watchlist', async () => {
    const r = await pin(await movie());
    assert.deepEqual(r, { status: 'refused', reason: 'not_on_watchlist' });
    assert.equal((await pinsOf(me)).length, 0);
  });

  it('is idempotent: pinning a pinned title and unpinning an unpinned one change nothing', async () => {
    const a = await movie();
    await save(a);
    await pin(a);

    assert.deepEqual((await pin(a)).pinned, [a]);
    assert.equal((await pinsOf(me)).length, 1);

    assert.deepEqual((await unpin(a)).pinned, []);
    assert.deepEqual(await unpin(a), { status: 'ok', pinned: [] });
  });

  it('answers a replayed operation id as already applied', async () => {
    const a = await movie();
    await save(a);
    const op = await uuid();

    assert.equal((await call(`set_watch_next($1, $2, true)`, [op, a])).status, 'ok');
    assert.equal(
      (await call(`set_watch_next($1, $2, true)`, [op, a])).status,
      'already_applied',
    );
  });

  it('refuses a missing title or presence with 22023', async () => {
    const error = await t.errorFrom(`select set_watch_next(gen_random_uuid(), null, true)`);
    assert.equal(error?.code, '22023');
  });
});

describe('the cap', () => {
  it('refuses a fourth pin with no replacement, and says what is pinned', async () => {
    const three = await pinThree();
    const fourth = await movie();
    await save(fourth);

    assert.deepEqual(await pin(fourth), { status: 'refused', reason: 'full', pinned: three });
    assert.equal((await pinsOf(me)).length, 3);
  });

  it('replaces one pin with another in a single call, keeping its slot', async () => {
    const [a, b, c] = await pinThree();
    const d = await movie();
    await save(d);

    const r = await pin(d, b);
    assert.deepEqual(r, { status: 'ok', replaced: true, pinned: [a, d, c] });
    assert.deepEqual(
      (await pinsOf(me)).map((row) => [row.media_item_id, row.slot]),
      [
        [a, 1],
        [d, 2],
        [c, 3],
      ],
    );
  });

  it('leaves every pin alone when the replacement is refused', async () => {
    const [a, b, c] = await pinThree();
    const notSaved = await movie();

    assert.equal((await pin(notSaved, b)).reason, 'not_on_watchlist');
    assert.deepEqual(
      (await pinsOf(me)).map((r) => r.media_item_id),
      [a, b, c],
    );
  });

  it('fills a gap with the next pin', async () => {
    const [a, b, c] = await pinThree();
    await unpin(b);
    const d = await movie();
    await save(d);

    assert.deepEqual((await pin(d)).pinned, [a, d, c]);
  });

  it('refuses a fourth row or a fourth slot from a writer that skips the function', async () => {
    const three = await pinThree();
    const fourth = await movie();
    await save(fourth);

    for (const slot of [1, 4, 0]) {
      const error = await t.errorFrom(
        `insert into watch_next (user_id, media_item_id, slot) values ($1, $2, $3)`,
        [me, fourth, slot],
      );
      assert.ok(['23505', '23514'].includes(error?.code), `slot ${slot} must be refused`);
    }
    assert.equal(three.length, 3);
  });

  it('refuses a pin for a title that is not on the Watchlist, structurally', async () => {
    const error = await t.errorFrom(
      `insert into watch_next (user_id, media_item_id, slot) values ($1, $2, 1)`,
      [me, await movie()],
    );
    assert.equal(error?.code, '23503');
  });
});

describe('a pin leaves with its Watchlist row, by every path', () => {
  const pinned = async () => {
    const id = await movie();
    await save(id);
    await pin(id);
    return id;
  };

  it('unsaving', async () => {
    const id = await pinned();
    await unsave(id);
    assert.equal((await pinsOf(me)).length, 0);
  });

  it('logging it watched (_leave_watchlist, user_media insert)', async () => {
    const id = await pinned();
    await call(`log_watched($1, $2, '2026-09-01', null)`, [await uuid(), id]);
    assert.equal((await pinsOf(me)).length, 0);
  });

  it('giving it a bucket (_leave_watchlist, user_media update)', async () => {
    const id = await pinned();
    // A note first, so the row exists and the bucket arrives as an update transition.
    await call(`log_watched($1, $2, null, 'meaning to')`, [await uuid(), id]);
    assert.equal((await pinsOf(me)).length, 1, 'a note alone is not a watch');
    await call(`set_bucket($1, $2, 'loved')`, [await uuid(), id]);
    assert.equal((await pinsOf(me)).length, 0);
  });

  it('ranking it (_leave_watchlist, rankings insert)', async () => {
    const id = await pinned();
    await t.rankToCompletion(id, 'loved', () => {
      throw new Error('an empty band asks nothing');
    });
    assert.equal((await pinsOf(me)).length, 0);
  });

  it('finishing a series (_leave_series_watchlist), and not before', async () => {
    const show = await t.createSeries(`wn_series_${seq}`, seq++);
    const s1 = await t.createSeason(show, 1, 'Season 1');
    const s2 = await t.createSeason(show, 2, 'Season 2');
    for (const s of [s1, s2]) {
      await t.sql(`update media_items set release_date = '2020-01-01' where id = $1`, [s]);
    }
    await save(show);
    await pin(show);

    await call(`set_bucket($1, $2, 'loved')`, [await uuid(), s1]);
    assert.equal((await pinsOf(me)).length, 1, 'one season watched: the series is still next');

    await call(`set_bucket($1, $2, 'loved')`, [await uuid(), s2]);
    assert.equal((await pinsOf(me)).length, 0, 'every released season done: it leaves');
  });

  it('deleting the account', async () => {
    await pinned();
    await t.sql(`delete from profiles where id = $1`, [me]);
    assert.equal((await pinsOf(me)).length, 0);
  });

  it('deleting the title from the catalogue', async () => {
    const id = await pinned();
    await t.sql(`delete from media_items where id = $1`, [id]);
    assert.equal((await pinsOf(me)).length, 0);
  });

  it('survives a re-save of a title that is already saved', async () => {
    const id = await pinned();
    await save(id);
    assert.equal((await pinsOf(me)).length, 1);
  });
});

describe('private and silent', () => {
  it('lets the owner read their pins and nobody else, on a public profile', async () => {
    const id = await movie();
    await save(id);
    await pin(id);

    const follower = await t.createUser({ username: `wf${seq++}` });
    await t.sql(
      `insert into follows (follower_id, followee_id, state, approved_at)
       values ($1, $2, 'approved', now())`,
      [follower, me],
    );

    const own = await t.asUser(me, async () => (await t.sql(`select * from watch_next`)).rows);
    assert.equal(own.length, 1);

    const theirs = await t.asUser(
      follower,
      async () => (await t.sql(`select * from watch_next where user_id = $1`, [me])).rows,
    );
    assert.equal(theirs.length, 0, 'the Watchlist is public; Watch next is not');

    const seesWatchlist = await t.asUser(
      follower,
      async () => (await t.sql(`select 1 from watchlist where user_id = $1`, [me])).rows,
    );
    assert.equal(seesWatchlist.length, 1, 'fixture: the Watchlist itself is visible');

    const anon = await t.asAnon(() => t.errorFrom(`select * from watch_next`));
    assert.equal(anon?.code, '42501');

    await t.actAs(me);
  });

  it('writes no feed event and no notification, on any path', async () => {
    const [a, b] = [await movie(), await movie()];
    await save(a);
    await save(b);

    const count = async () => {
      const { rows } = await t.sql(
        `select (select count(*) from feed_events where actor_id = $1) as events,
                (select count(*) from notifications where actor_id = $1) as notices`,
        [me],
      );
      return rows[0];
    };
    const before = await count();

    await pin(a);
    await pin(b);
    await unpin(a);
    await pin(a, b);

    assert.deepEqual(await count(), before);
  });

  it('cannot be written by a client role directly', async () => {
    const id = await movie();
    await save(id);
    const error = await t.asUser(me, () =>
      t.errorFrom(`insert into watch_next (user_id, media_item_id, slot) values ($1, $2, 1)`, [
        me,
        id,
      ]),
    );
    assert.equal(error?.code, '42501');
    await t.actAs(me);
  });
});
