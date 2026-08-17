import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The provider list cache (20260816000900).
 *
 * The table exists because trending has no media_item_id to hang from, and the
 * property it was chosen for is that a list is *replaced* rather than merged — so
 * that is what most of this file checks. The rest is the lifecycle contract it
 * inherits from media_cache: an expiry derived from app_config rather than a
 * constant, a closed key set, world-readable, and writable only by service_role.
 */

const ids = (n, from = 0) =>
  Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(from + i).padStart(12, '0')}`);

const putList = (t, key, list) =>
  t.sql(`select tmdb_put_list($1, $2::jsonb) as expires_at`, [key, JSON.stringify({ ids: list })]);

const listRow = async (t, key) => {
  const { rows } = await t.sql(`select * from provider_list_cache where list_key = $1`, [key]);
  return rows[0];
};

describe('tmdb_put_list', () => {
  it('writes a list and reports when it expires', async () => {
    const t = await createTestDb();
    try {
      const { rows } = await putList(t, 'trending.movie.day', ids(3));
      assert.ok(rows[0].expires_at, 'an expiry is returned');

      const row = await listRow(t, 'trending.movie.day');
      assert.deepEqual(row.payload.ids, ids(3));
    } finally {
      await t.close();
    }
  });

  /**
   * The whole reason this is a table keyed on the list rather than a facet row per
   * trending title. A shorter second list must not leave the tail of the first one
   * behind, or refresh N+1 serves titles TMDB has stopped featuring.
   */
  it('replaces a list rather than merging into it', async () => {
    const t = await createTestDb();
    try {
      await putList(t, 'trending.movie.day', ids(20));
      await putList(t, 'trending.movie.day', ids(3, 100));

      const row = await listRow(t, 'trending.movie.day');
      assert.equal(row.payload.ids.length, 3);
      assert.deepEqual(row.payload.ids, ids(3, 100));
    } finally {
      await t.close();
    }
  });

  it('keeps the ordering it was handed', async () => {
    const t = await createTestDb();
    try {
      const order = [...ids(5)].reverse();
      await putList(t, 'trending.movie.week', order);

      // jsonb preserves array order (it is objects whose key order is not kept),
      // which is what lets the payload carry a ranking at all.
      assert.deepEqual((await listRow(t, 'trending.movie.week')).payload.ids, order);
    } finally {
      await t.close();
    }
  });

  it('keeps the four lists apart', async () => {
    const t = await createTestDb();
    try {
      await putList(t, 'trending.movie.day', ids(2));
      await putList(t, 'trending.movie.week', ids(3, 10));
      await putList(t, 'trending.series.day', ids(4, 20));
      await putList(t, 'trending.series.week', ids(5, 30));

      const { rows } = await t.sql(
        `select list_key, jsonb_array_length(payload -> 'ids') as n
           from provider_list_cache order by list_key`,
      );
      assert.deepEqual(rows, [
        { list_key: 'trending.movie.day', n: 2 },
        { list_key: 'trending.movie.week', n: 3 },
        { list_key: 'trending.series.day', n: 4 },
        { list_key: 'trending.series.week', n: 5 },
      ]);
    } finally {
      await t.close();
    }
  });

  it('accepts an empty list', async () => {
    const t = await createTestDb();
    try {
      // TMDB answering with nothing is a real answer, and writing it is how the
      // cache stops serving yesterday's list after the provider has emptied it.
      await putList(t, 'trending.movie.day', []);
      assert.deepEqual((await listRow(t, 'trending.movie.day')).payload.ids, []);
    } finally {
      await t.close();
    }
  });

  it('refuses a payload that is not an ids array', async () => {
    const t = await createTestDb();
    try {
      for (const payload of ['{}', '{"ids": "nope"}', '{"items": []}', '[]']) {
        const error = await t.errorFrom(`select tmdb_put_list('trending.movie.day', $1::jsonb)`, [
          payload,
        ]);
        assert.equal(error?.code, '22023', `payload ${payload} should be refused`);
      }
    } finally {
      await t.close();
    }
  });

  it('refuses a key outside the closed set', async () => {
    const t = await createTestDb();
    try {
      // media_cache closes its facet set for this reason and this one inherits it:
      // a typo should be a failed write, not a row nothing ever reads.
      const error = await t.errorFrom(
        `select tmdb_put_list('trending.tv.day', '{"ids":[]}'::jsonb)`,
      );
      assert.equal(error?.code, '23514');
    } finally {
      await t.close();
    }
  });
});

describe('the expiry comes from configuration', () => {
  it('uses tmdb.cache_ttl_hours -> trending', async () => {
    const t = await createTestDb();
    try {
      const { rows } = await t.sql(
        `select (value ->> 'trending')::integer as hours from app_config
          where key = 'tmdb.cache_ttl_hours'`,
      );
      assert.equal(rows[0].hours, 6, 'PRD §19 puts trending in hours');

      const { rows: written } = await putList(t, 'trending.movie.day', ids(1));
      const { rows: check } = await t.sql(
        `select extract(epoch from ($1::timestamptz - fetched_at)) / 3600 as ttl
           from provider_list_cache
          where list_key = 'trending.movie.day'`,
        [written[0].expires_at],
      );
      assert.equal(Number(check[0].ttl), 6);
    } finally {
      await t.close();
    }
  });

  /**
   * The migration merges its key into whatever the object already holds. Both
   * deployed projects have a `tmdb.cache_ttl_hours` row with the original four
   * keys, and losing those would silently re-TTL every facet in media_cache.
   *
   * Asserted as an exact object rather than as "these keys are still present",
   * deliberately: the failure this guards against is a later migration writing the
   * whole value instead of merging into it, and a subset assertion would not see it.
   * The cost is that every migration adding a TTL updates this fixture — which is
   * the point. `reviews` and `person` were added by 20260817000500.
   */
  it('leaves the existing facet TTLs alone', async () => {
    const t = await createTestDb();
    try {
      const { rows } = await t.sql(
        `select value from app_config where key = 'tmdb.cache_ttl_hours'`,
      );
      assert.deepEqual(rows[0].value, {
        availability: 12,
        credits: 720,
        keywords: 720,
        person: 168,
        reviews: 24,
        similar: 168,
        trending: 6,
      });
    } finally {
      await t.close();
    }
  });

  it('honours a changed TTL without a redeploy', async () => {
    const t = await createTestDb();
    try {
      // The point of reading it from app_config at all (AD-8): an operator moves
      // the window, and the adapter is not rebuilt.
      await t.sql(
        `update app_config set value = value || '{"trending": 1}'::jsonb
          where key = 'tmdb.cache_ttl_hours'`,
      );
      const { rows } = await putList(t, 'trending.movie.day', ids(1));
      const { rows: check } = await t.sql(
        `select extract(epoch from ($1::timestamptz - fetched_at)) / 3600 as ttl
           from provider_list_cache
          where list_key = 'trending.movie.day'`,
        [rows[0].expires_at],
      );
      assert.equal(Number(check[0].ttl), 1);
    } finally {
      await t.close();
    }
  });

  it('caps at the retention window even if configured past it', async () => {
    const t = await createTestDb();
    try {
      // 3600 hours is PRD §19's six months. A cache entry cannot be configured to
      // outlive the data it describes.
      await t.sql(
        `update app_config set value = value || '{"trending": 99999}'::jsonb
          where key = 'tmdb.cache_ttl_hours'`,
      );
      const { rows } = await putList(t, 'trending.movie.day', ids(1));
      const { rows: check } = await t.sql(
        `select extract(epoch from ($1::timestamptz - fetched_at)) / 3600 as ttl
           from provider_list_cache
          where list_key = 'trending.movie.day'`,
        [rows[0].expires_at],
      );
      assert.equal(Number(check[0].ttl), 3600);
    } finally {
      await t.close();
    }
  });

  it('falls back rather than failing when the config row is gone', async () => {
    const t = await createTestDb();
    try {
      // 20260813002100's lesson: a missing row makes the subquery return no rows
      // rather than null, so an unguarded coalesce never runs.
      await t.sql(`delete from app_config where key = 'tmdb.cache_ttl_hours'`);
      const { rows } = await putList(t, 'trending.movie.day', ids(1));
      const { rows: check } = await t.sql(
        `select extract(epoch from ($1::timestamptz - fetched_at)) / 3600 as ttl
           from provider_list_cache
          where list_key = 'trending.movie.day'`,
        [rows[0].expires_at],
      );
      assert.equal(Number(check[0].ttl), 6);
    } finally {
      await t.close();
    }
  });
});

describe('who can reach it', () => {
  it('is readable signed out, like the rest of the catalogue', async () => {
    const t = await createTestDb();
    try {
      await putList(t, 'trending.movie.day', ids(2));

      // media_items and media_cache are world-readable on purpose — catalogue
      // metadata is not user data — and a trending list says nothing about anybody.
      const rows = await t.asAnon(async () => {
        const { rows } = await t.sql(`select list_key from provider_list_cache`);
        return rows;
      });
      assert.deepEqual(rows, [{ list_key: 'trending.movie.day' }]);
    } finally {
      await t.close();
    }
  });

  it('is not writable by a client', async () => {
    const t = await createTestDb();
    try {
      const user = await t.createUser({ username: 'trending_reader' });

      const error = await t.asUser(user, () =>
        t.errorFrom(`select tmdb_put_list('trending.movie.day', '{"ids":[]}'::jsonb)`),
      );
      assert.ok(error, 'tmdb_put_list must not be reachable by authenticated');
      assert.equal(error.code, '42501');
    } finally {
      await t.close();
    }
  });

  it('has no insert policy, so the table itself is closed too', async () => {
    const t = await createTestDb();
    try {
      const user = await t.createUser({ username: 'trending_writer' });

      const error = await t.asUser(user, () =>
        t.errorFrom(
          `insert into provider_list_cache (list_key, payload, expires_at)
           values ('trending.movie.day', '{"ids":[]}'::jsonb, now() + interval '1 hour')`,
        ),
      );
      assert.ok(error, 'a direct insert must be refused');
    } finally {
      await t.close();
    }
  });
});
