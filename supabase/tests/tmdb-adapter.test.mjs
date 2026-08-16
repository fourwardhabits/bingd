import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The write path the TMDB adapter runs on (20260815000000).
 *
 * Negative tmdb ids throughout, for the reason harness.mjs gives: the positive
 * range holds the real seed catalogue, and a fixture asking for 550 would fail on
 * a unique index because of what someone else's catalogue happens to contain.
 */

const title = (over = {}) => ({
  kind: 'movie',
  tmdb_id: -9001,
  title: 'Fixture Film',
  original_title: 'Fixture Film',
  release_date: '2001-05-04',
  runtime_minutes: 101,
  overview: 'A film that exists to be upserted.',
  poster_path: '/fixture.jpg',
  backdrop_path: '/fixture-wide.jpg',
  original_language: 'en',
  genres: ['Drama'],
  popularity: 12.5,
  ...over,
});

/**
 * The function's output columns avoid the names id/kind/tmdb_id, because a
 * RETURNS TABLE column is a plpgsql variable and those three would shadow the
 * table columns the ON CONFLICT clause names. Mapped back here so the assertions
 * below read in the schema's own vocabulary.
 */
const upsert = async (t, items) => {
  const { rows } = await t.sql(`select * from tmdb_upsert_titles($1::jsonb)`, [
    JSON.stringify(items),
  ]);
  return rows.map((r) => ({ id: r.media_item_id, kind: r.item_kind, tmdb_id: r.provider_id }));
};

const itemById = async (t, id) => {
  const { rows } = await t.sql(`select * from media_items where id = $1`, [id]);
  return rows[0];
};

describe('tmdb_upsert_titles', () => {
  it('inserts a title and reports the id it landed on', async () => {
    const t = await createTestDb();
    try {
      const rows = await upsert(t, [title()]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].tmdb_id, -9001);

      const row = await itemById(t, rows[0].id);
      assert.equal(row.title, 'Fixture Film');
      assert.equal(row.poster_path, '/fixture.jpg');
      assert.equal(row.runtime_minutes, 101);
      assert.deepEqual(row.genres, ['Drama']);
      assert.equal(row.provenance, 'tmdb');
    } finally {
      await t.close();
    }
  });

  /**
   * The reason these functions exist at all. media_items_tmdb is a partial unique
   * index, and ON CONFLICT can only use it when the statement repeats the index
   * predicate. Drop `where kind in (...)` from the migration and this test is what
   * fails — with a duplicate row rather than an error, which is the worse outcome.
   */
  it('updates in place on a second call rather than duplicating', async () => {
    const t = await createTestDb();
    try {
      const [first] = await upsert(t, [title()]);
      const [second] = await upsert(t, [title({ title: 'Fixture Film (Restored)' })]);

      assert.equal(second.id, first.id, 'the same title should land on the same row');

      const { rows } = await t.sql(
        `select count(*)::int as n from media_items where tmdb_id = -9001 and kind = 'movie'`,
      );
      assert.equal(rows[0].n, 1);

      const row = await itemById(t, first.id);
      assert.equal(row.title, 'Fixture Film (Restored)');
    } finally {
      await t.close();
    }
  });

  it('keeps a field the provider omitted rather than blanking it', async () => {
    const t = await createTestDb();
    try {
      const [first] = await upsert(t, [title()]);

      // What a search response looks like beside a detail response: no runtime,
      // no overview, no genres.
      await upsert(t, [
        title({ runtime_minutes: null, overview: null, genres: [], poster_path: null }),
      ]);

      const row = await itemById(t, first.id);
      assert.equal(row.runtime_minutes, 101, 'runtime should survive a response that omits it');
      assert.equal(row.overview, 'A film that exists to be upserted.');
      assert.equal(row.poster_path, '/fixture.jpg');
      assert.deepEqual(row.genres, ['Drama'], 'an empty array is silence, not "no genres"');
    } finally {
      await t.close();
    }
  });

  it('replaces genres when the provider actually sends different ones', async () => {
    const t = await createTestDb();
    try {
      const [first] = await upsert(t, [title()]);
      await upsert(t, [title({ genres: ['Thriller', 'Mystery'] })]);

      const row = await itemById(t, first.id);
      assert.deepEqual(row.genres, ['Thriller', 'Mystery']);
    } finally {
      await t.close();
    }
  });

  /**
   * The compliance-relevant one. A Wikidata row is CC0 and exempt from the
   * six-month window; the moment it carries TMDB's overview and poster it is not,
   * and media_refresh_due filters on provenance to decide. Leaving it 'wikidata'
   * would quietly exempt real TMDB data from PRD §19.
   */
  it('flips an enriched Wikidata row to tmdb provenance, keeping its qid', async () => {
    const t = await createTestDb();
    try {
      const { rows: seeded } = await t.sql(
        `insert into media_items (kind, tmdb_id, title, provenance, wikidata_qid)
         values ('movie', -9002, 'Seeded Film', 'wikidata', 'Q999999')
         returning id`,
      );

      const [enriched] = await upsert(t, [title({ tmdb_id: -9002, title: 'Seeded Film' })]);
      assert.equal(enriched.id, seeded[0].id, 'enrichment should find the seeded row');

      const row = await itemById(t, seeded[0].id);
      assert.equal(row.provenance, 'tmdb');
      assert.equal(row.wikidata_qid, 'Q999999', 'the qid is still true and still useful');
    } finally {
      await t.close();
    }
  });

  it('skips a malformed item instead of failing the whole batch', async () => {
    const t = await createTestDb();
    try {
      const rows = await upsert(t, [
        title(),
        title({ tmdb_id: -9003, title: null }),
        title({ tmdb_id: null }),
        title({ tmdb_id: -9004, kind: 'season' }),
      ]);

      assert.equal(rows.length, 1, 'only the well-formed title should be written');
      assert.equal(rows[0].tmdb_id, -9001);
    } finally {
      await t.close();
    }
  });

  it('reads an empty release date as no date', async () => {
    const t = await createTestDb();
    try {
      const [row] = await upsert(t, [title({ release_date: '' })]);
      const stored = await itemById(t, row.id);
      assert.equal(stored.release_date, null);
    } finally {
      await t.close();
    }
  });

  it('is reachable by neither anon nor a signed-in client', async () => {
    const t = await createTestDb();
    try {
      const alice = await t.createUser({ username: 'alice' });

      for (const run of [
        (fn) => t.asAnon(fn),
        (fn) => t.asUser(alice, fn),
      ]) {
        const err = await run(() =>
          t.errorFrom(`select tmdb_upsert_titles($1::jsonb)`, [JSON.stringify([title()])]),
        );
        assert.ok(err, 'a client must not be able to write the catalogue directly');
        assert.match(err.message, /permission denied/i);
      }
    } finally {
      await t.close();
    }
  });
});

describe('tmdb_upsert_seasons', () => {
  it('writes seasons under their series and is idempotent', async () => {
    const t = await createTestDb();
    try {
      const [series] = await upsert(t, [
        title({ kind: 'series', tmdb_id: -9100, title: 'Fixture Show' }),
      ]);

      const seasons = [
        { season_number: 1, tmdb_id: -91001, title: 'Season 1', release_date: '2010-01-01' },
        { season_number: 2, tmdb_id: -91002, title: null, release_date: '2011-01-01' },
      ];

      const write = async () => {
        const { rows } = await t.sql(`select * from tmdb_upsert_seasons($1, $2::jsonb)`, [
          series.id,
          JSON.stringify(seasons),
        ]);
        return rows;
      };

      const first = await write();
      assert.equal(first.length, 2);

      const second = await write();
      assert.deepEqual(
        second.map((r) => r.media_item_id).sort(),
        first.map((r) => r.media_item_id).sort(),
        'a second run should land on the same rows',
      );

      const { rows } = await t.sql(
        `select season_number, title from media_items
          where parent_id = $1 and kind = 'season' order by season_number`,
        [series.id],
      );
      assert.equal(rows.length, 2);
      assert.equal(rows[1].title, 'Season 2', 'an untitled season is named from its ordinal');
    } finally {
      await t.close();
    }
  });

  it('refuses a parent that is not a series', async () => {
    const t = await createTestDb();
    try {
      const [movie] = await upsert(t, [title()]);
      const err = await t.errorFrom(`select tmdb_upsert_seasons($1, $2::jsonb)`, [
        movie.id,
        JSON.stringify([{ season_number: 1 }]),
      ]);
      assert.ok(err, 'a season under a film should be refused');
      assert.match(err.message, /not a series/i);
    } finally {
      await t.close();
    }
  });
});

describe('tmdb_put_facet', () => {
  it('derives the expiry from app_config rather than from a constant', async () => {
    const t = await createTestDb();
    try {
      const [movie] = await upsert(t, [title()]);

      await t.sql(`select tmdb_put_facet($1, 'credits', $2::jsonb)`, [
        movie.id,
        JSON.stringify({ cast: [{ id: 1, name: 'Someone' }] }),
      ]);

      const { rows } = await t.sql(
        `select facet,
                round(extract(epoch from (expires_at - now())) / 3600)::int as hours
           from media_cache where media_item_id = $1`,
        [movie.id],
      );
      // The seeded credits TTL is 720 hours.
      assert.equal(rows[0].hours, 720);
    } finally {
      await t.close();
    }
  });

  it('reads the providers TTL from its old config name', async () => {
    const t = await createTestDb();
    try {
      const [movie] = await upsert(t, [title()]);
      await t.sql(`select tmdb_put_facet($1, 'providers', '{}'::jsonb)`, [movie.id]);

      const { rows } = await t.sql(
        `select round(extract(epoch from (expires_at - now())) / 3600)::int as hours
           from media_cache where media_item_id = $1 and facet = 'providers'`,
        [movie.id],
      );
      // 'availability' in the seeded config, 12 hours.
      assert.equal(rows[0].hours, 12);
    } finally {
      await t.close();
    }
  });

  it('caps the expiry at the retention window even when config asks for longer', async () => {
    const t = await createTestDb();
    try {
      const [movie] = await upsert(t, [title()]);
      await t.sql(
        `update app_config set value = '{"credits": 99999}'::jsonb
          where key = 'tmdb.cache_ttl_hours'`,
      );

      await t.sql(`select tmdb_put_facet($1, 'credits', '{}'::jsonb)`, [movie.id]);

      const { rows } = await t.sql(
        `select round(extract(epoch from (expires_at - now())) / 3600)::int as hours
           from media_cache where media_item_id = $1`,
        [movie.id],
      );
      assert.equal(rows[0].hours, 3600, 'a facet must not outlive the six-month window');
    } finally {
      await t.close();
    }
  });

  it('still writes a usable expiry when the config row is missing entirely', async () => {
    const t = await createTestDb();
    try {
      const [movie] = await upsert(t, [title()]);
      await t.sql(`delete from app_config where key = 'tmdb.cache_ttl_hours'`);

      await t.sql(`select tmdb_put_facet($1, 'credits', '{}'::jsonb)`, [movie.id]);

      const { rows } = await t.sql(
        `select round(extract(epoch from (expires_at - now())) / 3600)::int as hours
           from media_cache where media_item_id = $1`,
        [movie.id],
      );
      assert.equal(rows[0].hours, 24, 'the written fallback has to actually run');
    } finally {
      await t.close();
    }
  });

  it('replaces a facet rather than accumulating copies', async () => {
    const t = await createTestDb();
    try {
      const [movie] = await upsert(t, [title()]);
      await t.sql(`select tmdb_put_facet($1, 'credits', '{"cast": []}'::jsonb)`, [movie.id]);
      await t.sql(`select tmdb_put_facet($1, 'credits', '{"cast": [1]}'::jsonb)`, [movie.id]);

      const { rows } = await t.sql(
        `select count(*)::int as n, max(payload::text) as payload
           from media_cache where media_item_id = $1 and facet = 'credits'`,
        [movie.id],
      );
      assert.equal(rows[0].n, 1);
      assert.match(rows[0].payload, /\[1\]/);
    } finally {
      await t.close();
    }
  });
});

describe('tmdb_note_request', () => {
  it('counts within the hour and raises past the ceiling', async () => {
    const t = await createTestDb();
    try {
      const alice = await t.createUser({ username: 'alice' });
      await t.sql(
        `update app_config set value = '3'::jsonb where key = 'tmdb.max_requests_per_hour'`,
      );

      for (let i = 1; i <= 3; i += 1) {
        const { rows } = await t.sql(`select tmdb_note_request($1) as n`, [alice]);
        assert.equal(rows[0].n, i);
      }

      const err = await t.errorFrom(`select tmdb_note_request($1)`, [alice]);
      assert.ok(err, 'the fourth request should be refused');
      assert.equal(err.code, '53400', 'api.md §8 maps 53400 to BG429');
    } finally {
      await t.close();
    }
  });

  it('counts each user separately', async () => {
    const t = await createTestDb();
    try {
      const alice = await t.createUser({ username: 'alice' });
      const bob = await t.createUser({ username: 'bob' });

      await t.sql(`select tmdb_note_request($1)`, [alice]);
      await t.sql(`select tmdb_note_request($1)`, [alice]);
      const { rows } = await t.sql(`select tmdb_note_request($1) as n`, [bob]);

      assert.equal(rows[0].n, 1, "one user's traffic must not spend another's allowance");
    } finally {
      await t.close();
    }
  });

  it('still applies a ceiling when the config row is absent', async () => {
    const t = await createTestDb();
    try {
      const alice = await t.createUser({ username: 'alice' });
      await t.sql(`delete from app_config where key = 'tmdb.max_requests_per_hour'`);

      // The written fallback is 120. Reaching it row by row would be slow, so this
      // asserts the variable is not null, which is the failure 20260813002100
      // describes: a limit that silently stops existing.
      await t.sql(
        `insert into tmdb_request_log (user_id, window_start, requests)
         values ($1, date_trunc('hour', now()), 120)`,
        [alice],
      );

      const err = await t.errorFrom(`select tmdb_note_request($1)`, [alice]);
      assert.ok(err, 'the fallback ceiling has to actually apply');
      assert.equal(err.code, '53400');
    } finally {
      await t.close();
    }
  });

  it('keeps the log to the recent past', async () => {
    const t = await createTestDb();
    try {
      const alice = await t.createUser({ username: 'alice' });
      await t.sql(
        `insert into tmdb_request_log (user_id, window_start, requests)
         values ($1, date_trunc('hour', now()) - interval '9 hours', 40)`,
        [alice],
      );

      await t.sql(`select tmdb_note_request($1)`, [alice]);

      const { rows } = await t.sql(
        `select count(*)::int as n from tmdb_request_log where user_id = $1`,
        [alice],
      );
      assert.equal(rows[0].n, 1, 'stale windows should be dropped as they are passed');
    } finally {
      await t.close();
    }
  });

  it('is not readable by the user it describes', async () => {
    const t = await createTestDb();
    try {
      const alice = await t.createUser({ username: 'alice' });
      await t.sql(`select tmdb_note_request($1)`, [alice]);

      const visible = await t.asUser(alice, async () => {
        const { rows } = await t.sql(`select * from tmdb_request_log`);
        return rows;
      });
      assert.equal(visible.length, 0, 'RLS with no policy should deny everything');
    } finally {
      await t.close();
    }
  });
});

describe('tmdb_enrich_due', () => {
  it('lists rows with a tmdb id and no poster, and drops them once enriched', async () => {
    const t = await createTestDb();
    try {
      const { rows: seeded } = await t.sql(
        `insert into media_items (kind, tmdb_id, title, provenance)
         values ('movie', -9200, 'Unenriched', 'wikidata')
         returning id`,
      );

      const due = async () => {
        const { rows } = await t.sql(
          `select count(*)::int as n from tmdb_enrich_due where id = $1`,
          [seeded[0].id],
        );
        return rows[0].n;
      };

      assert.equal(await due(), 1);

      await upsert(t, [title({ tmdb_id: -9200, title: 'Unenriched' })]);
      assert.equal(await due(), 0, 'an enriched row should stop being offered');
    } finally {
      await t.close();
    }
  });

  it('leaves seasons to their parent detail call', async () => {
    const t = await createTestDb();
    try {
      const [series] = await upsert(t, [
        title({ kind: 'series', tmdb_id: -9300, title: 'Parent Show', poster_path: null }),
      ]);
      await t.sql(`select tmdb_upsert_seasons($1, $2::jsonb)`, [
        series.id,
        JSON.stringify([{ season_number: 1, tmdb_id: -93001 }]),
      ]);

      const { rows } = await t.sql(
        `select count(*)::int as n from tmdb_enrich_due where kind = 'season'`,
      );
      assert.equal(rows[0].n, 0);
    } finally {
      await t.close();
    }
  });
});
