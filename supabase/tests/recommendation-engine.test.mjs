import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Recommendation Engine V2, A1 (20261116000100): the engine switch and the catalogue
 * source.
 *
 * The switch is the thing to get right first. Every new behaviour hangs off it, it
 * defaults to V1 for everybody, and an operator turning it off has to be enough to put
 * every reader back on V1 without a client release.
 */

let t;
let reader;
let other;
let seq = 710000;

const setConfig = (key, value) =>
  t.sql(
    `insert into app_config (key, value) values ($1, $2::jsonb)
       on conflict (key) do update set value = excluded.value`,
    [key, JSON.stringify(value)],
  );

const engineFor = async (userId) => {
  await t.actAs(userId);
  const { rows } = await t.sql(`select recommendation_engine() as engine`);
  return rows[0].engine;
};

/** A fixture title that can be a tile: poster, release date, language, popularity. */
const title = async ({
  kind = 'movie',
  language,
  year = 2015,
  popularity = 1_000_000,
  poster = true,
  released = true,
}) => {
  const name = `${language ?? 'xx'}-${kind}-${seq}`;
  const id = kind === 'series' ? await t.createSeries(name, seq++) : await t.createMovie(name, seq++);
  await t.sql(
    `update media_items
        set original_language = $2,
            release_date = $3::date,
            poster_path = $4,
            popularity = $5
      where id = $1`,
    [
      id,
      language,
      released ? `${year}-06-01` : `${new Date().getUTCFullYear() + 2}-06-01`,
      poster ? `/fixture-${seq}.jpg` : null,
      popularity,
    ],
  );
  return id;
};

const candidates = async (userId, args) => {
  await t.actAs(userId);
  const { rows } = await t.sql(
    `select * from catalogue_candidates($1, $2::text[], $3::integer[], $4, $5)`,
    [args.kind, args.languages ?? [], args.decades ?? [], args.per ?? 20, args.seed ?? 0],
  );
  return rows;
};

const enableFor = async (userId) => {
  await setConfig('recommendations.v2_engine', 'v2_metadata');
  await setConfig('recommendations.v2_allowlist', [userId]);
};

before(async () => {
  t = await createTestDb();
  reader = await t.createUser({ username: 'engine_reader' });
  other = await t.createUser({ username: 'engine_other' });
});

after(async () => {
  await t?.db.close();
});

beforeEach(async () => {
  await setConfig('recommendations.v2_engine', 'v1');
  await setConfig('recommendations.v2_rollout_percent', 0);
  await setConfig('recommendations.v2_allowlist', []);
  await setConfig('recommendations.v2_allowlist_engine', null);
});

describe('the engine switch', () => {
  it('is seeded off: v1 for everybody', async () => {
    const { rows } = await t.sql(
      `select key, value from app_config where key like 'recommendations.v2_%' order by key`,
    );
    assert.deepEqual(
      rows.map((row) => [row.key, row.value]),
      [
        ['recommendations.v2_allowlist', []],
        ['recommendations.v2_allowlist_engine', null],
        ['recommendations.v2_engine', 'v1'],
        ['recommendations.v2_rollout_percent', 0],
      ],
    );
    assert.equal(await engineFor(reader), 'v1');
    assert.equal(await engineFor(other), 'v1');
  });

  it('answers v1 with no session', async () => {
    await t.actAs(null);
    const { rows } = await t.sql(`select recommendation_engine() as engine`);
    assert.equal(rows[0].engine, 'v1');
  });

  it('turns on for an allowlisted account only', async () => {
    await enableFor(reader);
    assert.equal(await engineFor(reader), 'v2_metadata');
    assert.equal(await engineFor(other), 'v1');
  });

  it('serves the hybrid engine (A2, 20261116000200) through the same switch', async () => {
    await setConfig('recommendations.v2_engine', 'v2_hybrid');
    await setConfig('recommendations.v2_allowlist', [reader]);
    assert.equal(await engineFor(reader), 'v2_hybrid');
    assert.equal(await engineFor(other), 'v1');
  });

  it('treats an unknown engine as v1, even for an allowlisted account', async () => {
    await setConfig('recommendations.v2_engine', 'v9_experimental');
    await setConfig('recommendations.v2_allowlist', [reader]);
    await setConfig('recommendations.v2_rollout_percent', 100);
    assert.equal(await engineFor(reader), 'v1');
  });

  it('is rolled back by writing v1, whatever the cohort and allowlist say', async () => {
    await enableFor(reader);
    await setConfig('recommendations.v2_rollout_percent', 100);
    assert.equal(await engineFor(other), 'v2_metadata');
    await setConfig('recommendations.v2_engine', 'v1');
    assert.equal(await engineFor(reader), 'v1');
    assert.equal(await engineFor(other), 'v1');
  });

  it('gives the allowlist its own engine when one is set, and the cohort keeps v2_engine', async () => {
    // The override names an engine this schema knows; anything else falls back to v2_engine.
    await enableFor(reader);
    await setConfig('recommendations.v2_rollout_percent', 100);
    await setConfig('recommendations.v2_allowlist_engine', 'v2_metadata');
    assert.equal(await engineFor(reader), 'v2_metadata');
    await setConfig('recommendations.v2_allowlist_engine', 'v9_experimental');
    assert.equal(await engineFor(reader), 'v2_metadata');
    assert.equal(await engineFor(other), 'v2_metadata');
  });

  it('keeps v2_engine as the master switch: v1 there is v1 for the allowlist too', async () => {
    await enableFor(reader);
    await setConfig('recommendations.v2_allowlist_engine', 'v2_metadata');
    await setConfig('recommendations.v2_engine', 'v1');
    assert.equal(await engineFor(reader), 'v1');
  });

  it('ignores a malformed percentage and allowlist rather than failing open', async () => {
    await setConfig('recommendations.v2_engine', 'v2_metadata');
    await setConfig('recommendations.v2_rollout_percent', '100');
    await setConfig('recommendations.v2_allowlist', { [reader]: true });
    assert.equal(await engineFor(reader), 'v1');
  });

  /**
   * The four fallbacks the reconcile brief asks to be proven (rec/v2-reconcile, 2026-11-13).
   * Production has none of the `recommendations.v2_*` keys today; the migration seeds them
   * off, and an operator deleting them must be as safe as never having written them.
   */
  describe('flags and fallback', () => {
    const V2_KEYS = [
      'recommendations.v2_engine',
      'recommendations.v2_allowlist',
      'recommendations.v2_allowlist_engine',
      'recommendations.v2_rollout_percent',
    ];

    it('is v1 for everybody when no V2 key exists at all', async () => {
      await t.actAs(null);
      await t.sql(`delete from app_config where key = any($1::text[])`, [V2_KEYS]);
      try {
        assert.equal(await engineFor(reader), 'v1');
        assert.equal(await engineFor(other), 'v1');
        // And the V2 sources answer nothing: there is no engine to serve them.
        assert.deepEqual(await candidates(reader, { kind: 'movie', languages: ['ja'] }), []);
        await t.actAs(reader);
        assert.deepEqual((await t.sql(`select * from collaborative_candidates('movie', 10)`)).rows, []);
      } finally {
        await t.actAs(null);
      }
    });

    it('is v1 for a malformed v2_engine, whatever else is set', async () => {
      await setConfig('recommendations.v2_allowlist', [reader]);
      await setConfig('recommendations.v2_allowlist_engine', 'v2_hybrid');
      await setConfig('recommendations.v2_rollout_percent', 100);
      for (const bad of [true, 1, ['v2_metadata'], { engine: 'v2_metadata' }, '', 'V2_METADATA', ' v2_metadata', null]) {
        await t.actAs(null);
        await setConfig('recommendations.v2_engine', bad);
        assert.equal(await engineFor(reader), 'v1', `v2_engine = ${JSON.stringify(bad)}`);
        assert.equal(await engineFor(other), 'v1', `v2_engine = ${JSON.stringify(bad)}`);
      }
      await t.actAs(null);
    });

    it('gives an allowlisted account the configured engine, and the allowlist engine over it', async () => {
      await setConfig('recommendations.v2_engine', 'v2_metadata');
      await setConfig('recommendations.v2_allowlist', [reader]);
      assert.equal(await engineFor(reader), 'v2_metadata');
      await t.actAs(null);
      // Hybrid is reachable through the allowlist alone, while the cohort is on metadata.
      await setConfig('recommendations.v2_allowlist_engine', 'v2_hybrid');
      await setConfig('recommendations.v2_rollout_percent', 100);
      assert.equal(await engineFor(reader), 'v2_hybrid');
      assert.equal(await engineFor(other), 'v2_metadata');
      await t.actAs(null);
    });

    it('serves the v2_metadata_social prototype to the allowlist only, never to a percentage', async () => {
      // As the allowlist's engine: the allowlist gets it; the cohort keeps v2_engine.
      await setConfig('recommendations.v2_engine', 'v2_metadata');
      await setConfig('recommendations.v2_allowlist', [reader]);
      await setConfig('recommendations.v2_allowlist_engine', 'v2_metadata_social');
      await setConfig('recommendations.v2_rollout_percent', 100);
      assert.equal(await engineFor(reader), 'v2_metadata_social');
      assert.equal(await engineFor(other), 'v2_metadata');
      await t.actAs(null);
      // As v2_engine it is unknown, so v1 for everybody, allowlist included: the master switch
      // cannot hand the prototype to a rollout percentage.
      await setConfig('recommendations.v2_engine', 'v2_metadata_social');
      await setConfig('recommendations.v2_allowlist_engine', null);
      assert.equal(await engineFor(reader), 'v1');
      assert.equal(await engineFor(other), 'v1');
      await t.actAs(null);
      // And v2_engine = v1 still turns it off for the allowlist too.
      await setConfig('recommendations.v2_engine', 'v1');
      await setConfig('recommendations.v2_allowlist_engine', 'v2_metadata_social');
      assert.equal(await engineFor(reader), 'v1');
      await t.actAs(null);
    });

    it('gives the prototype the catalogue source and no collaborative evidence', async () => {
      await setConfig('recommendations.v2_engine', 'v2_metadata');
      await setConfig('recommendations.v2_allowlist', [reader]);
      await setConfig('recommendations.v2_allowlist_engine', 'v2_metadata_social');
      const ja = await title({ language: 'ja' });
      const rows = await candidates(reader, { kind: 'movie', languages: ['ja'] });
      assert.ok(rows.some((row) => row.id === ja), 'catalogue_candidates serves it like v2_metadata');
      await t.actAs(reader);
      assert.deepEqual((await t.sql(`select * from collaborative_candidates('movie', 10)`)).rows, []);
      await t.actAs(null);
    });

    it('is v1 for an account outside the allowlist at 0%, even with hybrid configured', async () => {
      await setConfig('recommendations.v2_engine', 'v2_hybrid');
      await setConfig('recommendations.v2_allowlist', [reader]);
      for (const percent of [0, -5, null]) {
        await t.actAs(null);
        await setConfig('recommendations.v2_rollout_percent', percent);
        assert.equal(await engineFor(other), 'v1', `rollout ${percent}`);
        assert.equal(await engineFor(reader), 'v2_hybrid');
      }
      await t.actAs(null);
      await t.sql(`delete from app_config where key = 'recommendations.v2_rollout_percent'`);
      assert.equal(await engineFor(other), 'v1', 'no percentage key');
      await t.actAs(null);
    });
  });

  it('only ever adds accounts as the percentage rises', async () => {
    const { rows } = await t.sql(
      `select id, _recommendation_cohort(id) as cohort
         from (select gen_random_uuid() as id from generate_series(1, 400)) ids`,
    );
    for (const row of rows) assert.ok(row.cohort >= 0 && row.cohort < 100);
    const at = (percent) => new Set(rows.filter((row) => row.cohort < percent).map((row) => row.id));
    const ten = at(10);
    const thirty = at(30);
    for (const id of ten) assert.ok(thirty.has(id));
    // Roughly uniform: 400 draws at 30% is 120 ± ~30 at four standard deviations.
    assert.ok(thirty.size > 80 && thirty.size < 160, `30% cohort held ${thirty.size} of 400`);
    // And deterministic.
    const { rows: again } = await t.sql(`select _recommendation_cohort($1) as cohort`, [rows[0].id]);
    assert.equal(again[0].cohort, rows[0].cohort);
  });

  it('is callable by a signed-in client and refused to anon', async () => {
    await enableFor(reader);
    const engine = await t.asUser(reader, async () => {
      const { rows } = await t.sql(`select recommendation_engine() as engine`);
      return rows[0].engine;
    });
    assert.equal(engine, 'v2_metadata');
    const refused = await t.asAnon(() => t.errorFrom(`select recommendation_engine()`));
    assert.match(String(refused?.message), /permission denied/);
    const cohort = await t.asUser(reader, () =>
      t.errorFrom(`select _recommendation_cohort($1)`, [reader]),
    );
    assert.match(String(cohort?.message), /permission denied/);
  });
});

describe('catalogue_candidates', () => {
  it('returns nothing while the caller is on v1', async () => {
    await title({ language: 'ja' });
    assert.equal((await candidates(reader, { kind: 'movie', languages: ['ja'] })).length, 0);
  });

  it("returns the reader's languages, not English, when V2 is on", async () => {
    await enableFor(reader);
    const ja = await title({ language: 'ja', popularity: 9_000_000 });
    const te = await title({ language: 'te', popularity: 9_000_000 });
    const rows = await candidates(reader, { kind: 'movie', languages: ['ja', 'te'] });
    const ids = new Set(rows.map((row) => row.id));
    assert.ok(ids.has(ja), 'a Japanese film enters the pool');
    assert.ok(ids.has(te), 'a Telugu film enters the pool');
    for (const row of rows) {
      assert.ok(['ja', 'te'].includes(row.original_language));
      assert.match(row.source, /^language:(ja|te)$/);
    }
  });

  it('keeps serving the hybrid engine, which builds on the metadata one', async () => {
    await setConfig('recommendations.v2_engine', 'v2_hybrid');
    await setConfig('recommendations.v2_allowlist', [reader]);
    const ja = await title({ language: 'ja', popularity: 9_500_000 });
    const rows = await candidates(reader, { kind: 'movie', languages: ['ja'] });
    assert.ok(rows.some((row) => row.id === ja));
  });

  it('skips what the reader has logged, unreleased titles and titles with no poster', async () => {
    await enableFor(reader);
    const logged = await title({ language: 'ko', popularity: 8_000_000 });
    const unreleased = await title({ language: 'ko', popularity: 8_000_000, released: false });
    const posterless = await title({ language: 'ko', popularity: 8_000_000, poster: false });
    const fresh = await title({ language: 'ko', popularity: 8_000_000 });
    await t.sql(
      `insert into user_media (user_id, media_item_id, watched_on) values ($1, $2, current_date)`,
      [reader, logged],
    );
    const ids = new Set((await candidates(reader, { kind: 'movie', languages: ['ko'] })).map((r) => r.id));
    assert.ok(ids.has(fresh));
    assert.ok(!ids.has(logged));
    assert.ok(!ids.has(unreleased));
    assert.ok(!ids.has(posterless));
    // Another reader's collection is not this reader's exclusion.
    await enableFor(other);
    const theirs = new Set((await candidates(other, { kind: 'movie', languages: ['ko'] })).map((r) => r.id));
    assert.ok(theirs.has(logged));
  });

  it('skips a show the reader has logged a season of, on the TV wall only', async () => {
    await enableFor(reader);
    const show = await title({ kind: 'series', language: 'es', popularity: 7_000_000 });
    const untouched = await title({ kind: 'series', language: 'es', popularity: 7_000_000 });
    const film = await title({ language: 'es', popularity: 7_000_000 });
    const season = await t.createSeason(show, 1, 'Season 1');
    await t.sql(
      `insert into user_media (user_id, media_item_id, watched_on) values ($1, $2, current_date)`,
      [reader, season],
    );
    const rows = await candidates(reader, { kind: 'series', languages: ['es'] });
    const ids = new Set(rows.map((row) => row.id));
    assert.ok(ids.has(untouched));
    assert.ok(!ids.has(show));
    assert.ok(!ids.has(film), 'a film never reaches the TV wall');
    for (const row of rows) assert.equal(row.kind, 'series');
  });

  it('reads whole decades, classics included', async () => {
    await enableFor(reader);
    const classic = await title({ language: 'en', year: 1954, popularity: 6_000_000 });
    const later = await title({ language: 'en', year: 1964, popularity: 6_000_000 });
    const rows = await candidates(reader, { kind: 'movie', decades: [1950] });
    const ids = new Set(rows.map((row) => row.id));
    assert.ok(ids.has(classic));
    assert.ok(!ids.has(later));
    for (const row of rows) {
      const year = Number(String(row.release_date instanceof Date ? row.release_date.toISOString() : row.release_date).slice(0, 4));
      assert.ok(year >= 1950 && year < 1960, `got ${year}`);
      assert.equal(row.source, 'era:1950');
    }
  });

  it('reads a decade window as one ordered index range, not a sort of the decade', async () => {
    // The plan of the window's own query shape. Seq and bitmap scans are switched off so the
    // small fixture table cannot hide the question: can the index hand back a decade in
    // popularity order? Before 20261116000100 used a decade expression it could not, and
    // every call sorted the whole decade (independent review, 2026-11-11).
    await t.actAs(null);
    await t.sql(`set enable_seqscan = off`);
    await t.sql(`set enable_bitmapscan = off`);
    try {
      const { rows } = await t.sql(
        `explain (format json)
         select mi.id from media_items mi
          where mi.kind = 'movie' and mi.poster_path is not null
            and ((extract(year from mi.release_date)::integer / 10) * 10) = 1970
            and mi.release_date <= current_date
          order by mi.popularity desc nulls last
          limit 60`,
      );
      const plan = JSON.stringify(rows[0]['QUERY PLAN']);
      assert.match(plan, /media_items_catalogue_decade/);
      assert.doesNotMatch(plan, /"Node Type":"Sort"/);
    } finally {
      await t.sql(`reset enable_seqscan`);
      await t.sql(`reset enable_bitmapscan`);
    }
  });

  it('bounds every input it is given', async () => {
    await enableFor(reader);
    for (let index = 0; index < 60; index += 1) await title({ language: 'fr', popularity: 5_000_000 + index });
    const many = await candidates(reader, { kind: 'movie', languages: ['fr'], per: 1000 });
    assert.equal(many.length, 40, 'per-source is capped at forty');
    const one = await candidates(reader, { kind: 'movie', languages: ['fr'], per: 0 });
    assert.equal(one.length, 1, 'and floored at one');

    const languages = ['aa', 'bb', 'cc', 'dd', 'ee', 'fr'];
    const sources = new Set(
      (await candidates(reader, { kind: 'movie', languages })).map((row) => row.source),
    );
    assert.ok(!sources.has('language:fr'), 'a sixth language is not read');

    const junk = await candidates(reader, {
      kind: 'movie',
      languages: ["fr' or 1=1 --", 'FRENCH', ''],
      decades: [1955, 3000, -10],
    });
    assert.equal(junk.length, 0, 'malformed codes and decades are ignored');

    assert.equal((await candidates(reader, { kind: 'season', languages: ['fr'] })).length, 0);
  });

  it('draws deterministically for a seed, and differently across seeds', async () => {
    await enableFor(reader);
    const draw = async (seed) =>
      (await candidates(reader, { kind: 'movie', languages: ['fr'], per: 10, seed }))
        .map((row) => row.id)
        .sort();
    assert.deepEqual(await draw(1), await draw(1));
    const seen = new Set();
    for (const seed of [1, 2, 3, 4, 5]) for (const id of await draw(seed)) seen.add(id);
    assert.ok(seen.size > 10, 'five seeds reach beyond one draw');
  });

  it('is refused to anon', async () => {
    const refused = await t.asAnon(() =>
      t.errorFrom(`select * from catalogue_candidates('movie', '{fr}', '{}', 10, 0)`),
    );
    assert.match(String(refused?.message), /permission denied/);
  });
});
