import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * `tmdb_claim_facet`, 20260816001000.
 *
 * It exists because `similar` is the first adapter action a *user* can trigger that
 * spends provider quota on a shared resource, and its first implementation guarded
 * that with a read-then-write freshness check — which guarantees nothing. Every
 * concurrent caller sees the same stale facet and every one of them spends.
 *
 * So the property under test is not "does it return true when the facet is missing".
 * It is: **exactly one caller wins, and the loser is told to stop.**
 */

let t;
let film;

const claim = async (id, facet = 'similar') => {
  const { rows } = await t.sql(`select tmdb_claim_facet($1, $2) as won`, [id, facet]);
  return rows[0].won;
};

const facetRow = async (id, facet = 'similar') => {
  const { rows } = await t.sql(
    `select payload, expires_at, expires_at > now() as fresh
       from media_cache where media_item_id = $1 and facet = $2`,
    [id, facet],
  );
  return rows[0] ?? null;
};

before(async () => {
  t = await createTestDb();
  const { rows } = await t.sql(
    `insert into media_items (kind, title) values ('movie', 'Claim Test')
     returning id`,
  );
  film = rows[0].id;
});

after(async () => {
  await t?.close();
});

describe('claiming a facet nobody holds', () => {
  it('is granted', async () => {
    assert.equal(await claim(film), true);
  });

  it('leaves a placeholder that carries no ids', async () => {
    // Every reader of this facet treats a payload without `ids` as an empty list, so
    // a claim reads as "nothing cached yet" rather than as a result. If the claim
    // looked like data, a losing caller would render it.
    const row = await facetRow(film);

    assert.ok(row, 'the claim should have written a row');
    assert.equal(row.payload.ids, undefined);
    assert.ok(row.payload.claimed_at, 'the placeholder should say what it is');
    assert.equal(row.fresh, true);
  });

  it('expires in minutes rather than at the facet TTL', async () => {
    // A claim is a promise to go and fetch, and a promise can be broken: the isolate
    // can be killed, TMDB can hang. A broken promise must cost one refresh cycle, not
    // a facet that stays empty for the weeks a `similar` TTL would give it.
    const { rows } = await t.sql(
      `select expires_at - now() < interval '5 minutes' as short
         from media_cache where media_item_id = $1 and facet = 'similar'`,
      [film],
    );

    assert.equal(rows[0].short, true);
  });
});

describe('claiming one somebody already holds', () => {
  it('is refused', async () => {
    // The whole point. The first caller is fetching; the second must not also fetch.
    assert.equal(await claim(film), false);
  });

  it('is refused repeatedly, without extending the holder’s claim', async () => {
    const before = (await facetRow(film)).expires_at;
    assert.equal(await claim(film), false);
    assert.equal(await claim(film), false);
    const after = (await facetRow(film)).expires_at;

    // A losing caller that pushed the expiry out would let a steady stream of losers
    // keep a dead claim alive forever.
    assert.deepEqual(after, before);
  });
});

describe('claiming one that has expired', () => {
  it('is granted, because an expired claim is a broken promise', async () => {
    await t.sql(
      `update media_cache set expires_at = now() - interval '1 minute'
        where media_item_id = $1 and facet = 'similar'`,
      [film],
    );

    assert.equal(await claim(film), true);
  });

  it('is granted when a real cached answer has expired', async () => {
    await t.sql(
      `update media_cache
          set payload = '{"ids": ["a", "b"]}'::jsonb,
              expires_at = now() - interval '1 hour'
        where media_item_id = $1 and facet = 'similar'`,
      [film],
    );

    assert.equal(await claim(film), true);
    // And the stale answer is replaced by the placeholder rather than served while
    // the refresh runs. That is the cost this design accepts: `similar` is never
    // rendered directly, it is one input to a slate with a popularity fallback.
    assert.equal((await facetRow(film)).payload.ids, undefined);
  });
});

describe('claiming one with a fresh real answer', () => {
  it('is refused, so a good cache is never re-fetched', async () => {
    await t.sql(
      `update media_cache
          set payload = '{"ids": ["a"]}'::jsonb, expires_at = now() + interval '10 days'
        where media_item_id = $1 and facet = 'similar'`,
      [film],
    );

    assert.equal(await claim(film), false);
    // Untouched. A refused claim must not damage the answer it was refused over.
    assert.deepEqual((await facetRow(film)).payload, { ids: ['a'] });
  });
});

describe('who can claim', () => {
  it('is not reachable by a signed-in client', async () => {
    // A client holding this could evict any cached facet in the catalogue by claiming
    // it and never fetching, two minutes at a time, indefinitely.
    const alice = await t.createUser({ username: 'alice_claim' });
    const error = await t.asUser(alice, () =>
      t.errorFrom(`select tmdb_claim_facet($1, 'similar')`, [film]),
    );

    assert.equal(error?.code, '42501');
  });

  it('is not reachable signed out', async () => {
    const error = await t.asAnon(() =>
      t.errorFrom(`select tmdb_claim_facet($1, 'similar')`, [film]),
    );

    assert.equal(error?.code, '42501');
  });
});

describe('what it will not claim', () => {
  it('refuses a facet outside the closed set', async () => {
    const error = await t.errorFrom(`select tmdb_claim_facet($1, 'horoscope')`, [film]);

    assert.equal(error?.code, '23514');
  });
});
