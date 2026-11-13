import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { raceContext } from './_shared.mjs';

/**
 * The taste-neighbour cache under concurrent reads (20261116000200, Engine V2 A2).
 *
 * **N1. Two stale reads refresh once.** `collaborative_candidates` refreshes a stale
 * reader's neighbours inside the read. Two tabs, or a retry, arriving together must not
 * both run the bounded-but-not-free retrieval: the second waits on the per-reader lock and
 * then finds the first one's rows fresh. Observed, not argued — the second session is
 * required to block on that reader's key, and `refreshed_at` is required not to move when
 * it is let through. Remove the re-check under the lock and the second call refreshes again,
 * which moves `refreshed_at`; remove the lock and `awaitBlocked` throws.
 *
 * **N2. Different readers do not contend.** A lock that serialised every reader would
 * satisfy N1 and turn a busy minute into a queue.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  const setConfig = (key, value) =>
    ctx.db.rows(
      `insert into app_config (key, value) values ($1, $2::jsonb)
         on conflict (key) do update set value = excluded.value`,
      [key, JSON.stringify(value)],
    );

  const rank = async (user, ids) => {
    let position = 0;
    for (const id of ids) {
      position += 1;
      await ctx.db.rows(
        `insert into rankings (user_id, media_item_id, category, bucket, position)
         values ($1, $2, 'movies', $3::taste_bucket, $4)`,
        [user, id, position <= 4 ? 'loved' : position <= 8 ? 'fine' : 'not_for_me', position],
      );
    }
  };

  /** A reader, and three public accounts who ranked the same ten films the same way. */
  const readerWithNeighbours = async () => {
    const { fx } = ctx;
    const films = [];
    for (let i = 0; i < 10; i += 1) films.push(await fx.createMovie(`tn-race-${i}`));
    const reader = await fx.createUser();
    await rank(reader, films);
    for (let i = 0; i < 3; i += 1) await rank(await fx.createUser(), films);
    return reader;
  };

  const readerKey = async (reader) =>
    (
      await ctx.db.rows(
        `select hashtextextended('taste_neighbours:' || $1::text, 0)::text as k`,
        [reader],
      )
    )[0].k;

  const refreshedAt = async (reader) =>
    (
      await ctx.db.rows(
        `select refreshed_at::text as at from taste_neighbour_refresh where reader_id = $1`,
        [reader],
      )
    )[0]?.at ?? null;

  describe('taste_neighbours refresh', () => {
    before(async () => {
      await rc.open();
      await setConfig('recommendations.v2_engine', 'v2_hybrid');
      await setConfig('recommendations.v2_rollout_percent', 100);
    });
    after(() => rc.close());

    it('N1: two stale reads by one reader refresh once', async () => {
      const { db } = ctx;
      const reader = await readerWithNeighbours();
      const t1 = await db.session('first');
      const t2 = await db.session('second');
      await t1.actAs(reader);
      await t2.actAs(reader);

      await t1.begin();
      await t1.q(`select * from collaborative_candidates('movie', 40)`);

      await t2.begin();
      const second = t2.start(`select * from collaborative_candidates('movie', 40)`);
      await t2.awaitBlocked({ on: 'advisory', advisoryKey: await readerKey(reader) });

      await t1.commit();
      const first = await refreshedAt(reader);
      assert.ok(first, 'the first read refreshed');
      await second;
      await t2.commit();

      assert.equal(await refreshedAt(reader), first, 'the second read refreshed again');
      const [{ n }] = await db.rows(
        `select count(*)::int as n from taste_neighbours where reader_id = $1`,
        [reader],
      );
      assert.equal(n, 3);

      await t1.end();
      await t2.end();
    });

    it('N2: two readers refresh side by side', async () => {
      const { db } = ctx;
      const a = await readerWithNeighbours();
      const b = await readerWithNeighbours();
      const t1 = await db.session('reader-a');
      const t2 = await db.session('reader-b');
      await t1.actAs(a);
      await t2.actAs(b);

      await t1.begin();
      await t1.q(`select * from collaborative_candidates('movie', 40)`);

      await t2.begin();
      // Completes while `a`'s refresh still holds its lock.
      await t2.q(`select * from collaborative_candidates('movie', 40)`);
      await t2.commit();
      assert.ok(await refreshedAt(b));

      await t1.commit();
      await t1.end();
      await t2.end();
    });
  });
}
