/**
 * A verified IMDb id outweighs a display title, in the database (20261118000100).
 *
 * Founder QA (2026-11-12, spec §3 P0): IMDb rows whose right film was one tt id away ended
 * in "Couldn't match". The Edge Function's /find rule now accepts the one title of the
 * expected kind dated within a year (`verifiedIdentityAgrees`); this suite holds the
 * database to the SAME set, on the SAME cases (`import-imdb-verified-cases.mjs`):
 *
 *   the provider re-check   `_import_provider_resolve` with `p_imdb_id` (a /find answer)
 *   Tier 1                  `_import_match_batch_imdb`, a catalogue title carrying the id
 *
 * Each case runs both, in the order a real person meets them: the first import goes to the
 * provider and teaches the catalogue the id; the second import of the same file is settled
 * by Tier 1 against that mapping. Before 20261118000100 the second step was the latent
 * failure (H4): a mapping with a different display title settled `unmatched` with no
 * provider call.
 *
 * The Edge Function's TMDB answers are supplied by hand, as in `import-imdb.test.mjs`.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  bucketFor,
  catalogueItem,
  decideFind,
  mappingNorm,
  mappingTitleAgrees,
  pick,
  pickOriginal,
  releaseYearAgreeing,
} from '../functions/letterboxd-import/match.mjs';

import { createTestDb } from './harness.mjs';
import {
  claim,
  film,
  findFor,
  found,
  MAPPING_CASES,
  show,
  VERIFIED_CASES,
  VERIFIED_TV_CASES,
} from './import-imdb-verified-cases.mjs';

let t;
let seq = 71000;
const tt = () => `tt${String(9100000 + seq++).padStart(7, '0')}`;

const one = async (query, params) => (await t.sql(query, params)).rows[0];
const count = async (table, where = 'true', params) =>
  (await one(`select count(*)::int as n from ${table} where ${where}`, params)).n;

/** A catalogue row exactly as `tmdb_upsert_titles` would hold a /find hit. */
const catalogue = async (hit, kind, { imdbId = null } = {}) =>
  (
    await one(
      `insert into media_items (kind, tmdb_id, title, original_title, release_date, imdb_id, provenance)
       values ($1, $2, $3, $4, $5, $6, 'manual') returning id`,
      [
        kind,
        -Math.abs(seq++),
        kind === 'series' ? hit.name : hit.title,
        kind === 'series' ? hit.original_name : hit.original_title,
        kind === 'series' ? hit.first_air_date : hit.release_date,
        imdbId,
      ],
    )
  ).id;

/** One IMDb row as the client sends it, from a case's claim. */
const rowOf = (c, over = {}) => ({
  kind: 'watched',
  correlation: c.imdb_id,
  name: c.name,
  originalTitle: c.original_title,
  year: c.year,
  imdbId: c.imdb_id,
  titleType: c.title_type,
  imdbRating: 8,
  ...over,
});

const tick = () => t.sql(`select _drain_import_jobs(5, 500) as r`);
const runToEnd = async (jobId) => {
  for (let i = 0; i < 40; i += 1) {
    await tick();
    const done = await one(`select completed_at from import_jobs where id = $1`, [jobId]);
    if (done.completed_at) return;
  }
  throw new Error('job did not finish');
};

const stage = async (user, rows) => {
  await t.actAs(user);
  const { id } = await one(`select import_create('imdb') as id`);
  await t.sql(`select import_stage($1, $2::jsonb) as r`, [id, JSON.stringify(rows)]);
  await t.sql(`select import_ready($1) as r`, [id]);
  await t.actAs(null);
  return id;
};

const countsOf = async (job) =>
  (await one(`select counts from import_jobs where id = $1`, [job])).counts;

/** Tier 1 for one staged job, then the one claim the provider would get (or none). */
const matchAndClaim = async (job) => {
  await t.sql(`select _import_match_batch($1, 50)`, [job]);
  const { rows } = await t.sql(`select * from _import_provider_claim(50)`);
  return rows;
};

/** `_import_provider_resolve` as the Edge Function calls it, returning the settled status. */
const resolve = async (rowId, item, imdbId = null, releaseYear = null) =>
  (
    await one(`select _import_provider_resolve($1, $2, false, $3, false, $4) as status`, [
      rowId,
      item,
      imdbId,
      releaseYear,
    ])
  ).status;

const statusOf = async (rowId) =>
  await one(`select status, media_item_id from import_rows where id = $1`, [rowId]);

const imdbIdOf = async (item) =>
  (await one(`select imdb_id from media_items where id = $1`, [item])).imdb_id;

before(async () => {
  t = await createTestDb();
});
after(async () => {
  await t.close();
});

describe('Edge and SQL accept the same verified set (the founder QA classes)', () => {
  let ana;
  let bo;
  before(async () => {
    ana = await t.createUser({ username: 'imdb_verified_ana' });
    bo = await t.createUser({ username: 'imdb_verified_bo' });
  });
  beforeEach(async () => {
    await t.sql(`delete from import_jobs`);
    await t.sql(`delete from user_media where user_id in ($1, $2)`, [ana, bo]);
  });

  for (const c of [...VERIFIED_CASES, ...MAPPING_CASES]) {
    it(`a movie (${c.writes ? 'writes' : 'withholds'} the shared id): ${c.label}`, async () => {
      // Edge: the /find answer is a match, and says whether the shared id will be written.
      const decision = decideFind(c.row, findFor(c));
      assert.equal(decision.outcome, 'match');
      assert.equal(decision.writesMapping, c.writes, 'Edge prediction');

      const item = await catalogue(c.hit, 'movie');

      // First import: no title carries the id, so the provider is asked.
      const job = await stage(ana, [rowOf(c.row)]);
      const claims = await matchAndClaim(job);
      assert.equal(claims.length, 1, 'Tier 1 hands it to the provider');
      assert.equal(claims[0].imdb_id, c.row.imdb_id);
      const settled = await resolve(claims[0].row_id, item, c.row.imdb_id);
      // SQL: the re-check accepts what the Edge accepted, links the row either way, and
      // writes the shared id exactly when the Edge said it would (20261118000200).
      assert.equal(settled, 'matched');
      assert.equal(bucketFor({ status: settled, placed: true }), 'matched');
      assert.deepEqual(await statusOf(claims[0].row_id), {
        status: 'matched',
        media_item_id: item,
      });
      assert.equal(await imdbIdOf(item), c.writes ? c.row.imdb_id : null, 'SQL write');
      await runToEnd(job);
      const first = await countsOf(job);
      assert.equal(first.watched, 1);
      assert.equal(first.unmatched, 0);

      // Second import of the same file. With the mapping written, Tier 1 settles it with no
      // provider call. Without it, /find is asked again and gives the same answer. Either
      // way: no duplicate, reported as imported before.
      const again = await stage(ana, [rowOf(c.row)]);
      const reclaims = await matchAndClaim(again);
      if (c.writes) {
        assert.equal(reclaims.length, 0, 'no provider call on a reimport');
      } else {
        assert.equal(reclaims.length, 1, 'the provider is asked again');
        assert.equal(await resolve(reclaims[0].row_id, item, c.row.imdb_id), 'matched');
        assert.equal(await imdbIdOf(item), null, 'still nothing shared');
      }
      await runToEnd(again);
      const second = await countsOf(again);
      assert.equal(second.unmatched, 0);
      assert.equal(second.already, 1, 'reported as imported before');
      assert.equal(second.watched, 0);
      assert.equal(
        await count('user_media', 'user_id = $1 and media_item_id = $2', [ana, item]),
        1,
      );
      assert.equal(
        await count('imported_titles', 'user_id = $1 and media_item_id = $2', [ana, item]),
        1,
      );
      // Account isolation: somebody else's collection is untouched.
      assert.equal(await count('user_media', 'user_id = $1', [bo]), 0);
    });
  }

  for (const c of VERIFIED_TV_CASES) {
    it(`a whole show, recognised and not added: ${c.label}`, async () => {
      const decision = decideFind(c.row, findFor(c));
      assert.equal(decision.outcome, 'match');
      assert.equal(decision.writesMapping, c.writes);
      const item = await catalogue(c.hit, 'series');

      const job = await stage(ana, [rowOf(c.row)]);
      const claims = await matchAndClaim(job);
      assert.equal(claims.length, 1);
      const settled = await resolve(claims[0].row_id, item, c.row.imdb_id);
      assert.equal(settled, 'unsupported');
      assert.equal(bucketFor({ status: settled, placed: true }), 'matched_not_added');
      assert.equal(await imdbIdOf(item), c.writes ? c.row.imdb_id : null);
      await runToEnd(job);
      const first = await countsOf(job);
      assert.equal(first.unsupported_tv, 1, 'counted as a matched TV show not added');
      assert.equal(first.unmatched, 0);

      const again = await stage(ana, [rowOf(c.row)]);
      const reclaims = await matchAndClaim(again);
      assert.equal(reclaims.length, c.writes ? 0 : 1);
      if (!c.writes) await resolve(reclaims[0].row_id, item, c.row.imdb_id);
      await runToEnd(again);
      assert.equal((await countsOf(again)).unsupported_tv, 1);
      // Never a series, never a season, in anybody's collection.
      assert.equal(await count('user_media', 'user_id = $1', [ana]), 0);
    });
  }
});

describe('what still contradicts a verified id, on both sides', () => {
  let cy;
  before(async () => {
    cy = await t.createUser({ username: 'imdb_verified_cy' });
  });
  beforeEach(async () => {
    await t.sql(`delete from import_jobs`);
    await t.sql(`delete from user_media where user_id = $1`, [cy]);
  });

  const yearCase = (date) => {
    const row = claim({ name: 'Heat', year: 1995, imdb_id: tt() });
    return { row, hit: film(900100 + seq, 'Heat', date) };
  };

  for (const [label, date] of [
    ['far outside tolerance', '1986-01-01'],
    ['two years out (the bound)', '1997-01-01'],
  ]) {
    it(`a year ${label}: Edge conflict, re-check unmatched, Tier 1 unmatched`, async () => {
      const c = yearCase(date);
      const decision = decideFind(c.row, findFor(c));
      assert.equal(decision.outcome, 'conflict');
      assert.equal(decision.reason, 'year');

      const item = await catalogue(c.hit, 'movie');
      const job = await stage(cy, [rowOf(c.row)]);
      const [claimed] = await matchAndClaim(job);
      await t.sql(`select _import_provider_resolve($1, $2, false, $3)`, [
        claimed.row_id,
        item,
        c.row.imdb_id,
      ]);
      assert.equal((await statusOf(claimed.row_id)).status, 'unmatched');
      assert.equal(await imdbIdOf(item), null, 'a refused answer teaches nothing');
      await runToEnd(job);

      // Tier 1, with the mapping in place anyway: refused on the year.
      const mappedId = tt();
      await catalogue(c.hit, 'movie', { imdbId: mappedId });
      const job2 = await stage(cy, [rowOf({ ...c.row, imdb_id: mappedId })]);
      assert.equal((await matchAndClaim(job2)).length, 0);
      await runToEnd(job2);
      assert.equal((await countsOf(job2)).unmatched, 1);
      assert.equal(await count('user_media', 'user_id = $1', [cy]), 0);
    });
  }

  it('the other kind: Edge conflict, re-check unmatched, Tier 1 unmatched', async () => {
    const row = claim({ name: 'Kind Clash', year: 2008, imdb_id: tt() });
    const hit = show(900200, 'Kind Clash', '2008-01-20');
    assert.deepEqual(decideFind(row, found({ tv_results: [hit] })), {
      outcome: 'conflict',
      reason: 'kind',
    });

    const item = await catalogue(hit, 'series');
    const job = await stage(cy, [rowOf(row)]);
    const [claimed] = await matchAndClaim(job);
    await t.sql(`select _import_provider_resolve($1, $2, false, $3)`, [
      claimed.row_id,
      item,
      row.imdb_id,
    ]);
    assert.equal((await statusOf(claimed.row_id)).status, 'unmatched');
    await runToEnd(job);

    const mappedId = tt();
    await catalogue(hit, 'series', { imdbId: mappedId });
    const job2 = await stage(cy, [rowOf({ ...row, imdb_id: mappedId })]);
    await runToEnd(job2);
    assert.equal((await countsOf(job2)).unmatched, 1);
  });

  it('two titles claiming one id: Edge ambiguous, Tier 1 ambiguous', async () => {
    const id = tt();
    const row = claim({ name: 'Twin', year: 2001, imdb_id: id });
    const a = film(900300, 'Twin', '2001-06-01');
    const b = film(900301, 'Twin (Duplicate Entry)', '2001-06-01');
    assert.equal(decideFind(row, found({ movie_results: [a, b] })).outcome, 'ambiguous');

    await catalogue(a, 'movie', { imdbId: id });
    await catalogue(b, 'movie', { imdbId: id });
    const job = await stage(cy, [rowOf(row)]);
    await runToEnd(job);
    assert.equal((await countsOf(job)).ambiguous, 1);
    assert.equal(await count('user_media', 'user_id = $1', [cy]), 0);
  });
});

describe('tt8503618 Hamilton (2020), the control case, in SQL', () => {
  let fe;
  before(async () => {
    fe = await t.createUser({ username: 'imdb_verified_fe' });
  });

  it('the publicly known shape (one movie, same title and year) is accepted on both sides', async () => {
    await t.sql(`delete from import_jobs`);
    const row = claim({ name: 'Hamilton', year: 2020, imdb_id: 'tt8503618' });
    const hit = film(556574, 'Hamilton', '2020-07-03');
    assert.equal(decideFind(row, found({ movie_results: [hit] })).outcome, 'match');
    const item = await catalogue(hit, 'movie');
    const job = await stage(fe, [rowOf(row)]);
    const [claimed] = await matchAndClaim(job);
    await t.sql(`select _import_provider_resolve($1, $2, false, $3)`, [
      claimed.row_id,
      item,
      row.imdb_id,
    ]);
    assert.equal((await statusOf(claimed.row_id)).status, 'matched');
  });

  it('a movie and a show claiming the id: Edge ambiguous, Tier 1 ambiguous', async () => {
    await t.sql(`delete from import_jobs`);
    const id = tt();
    const row = claim({ name: 'Hamilton', year: 2020, imdb_id: id });
    const asFilm = film(900700, 'Hamilton', '2020-07-03');
    const asShow = show(900701, 'Hamilton', '2020-07-03');
    assert.equal(
      decideFind(row, found({ movie_results: [asFilm], tv_results: [asShow] })).outcome,
      'ambiguous',
    );
    await catalogue(asFilm, 'movie', { imdbId: id });
    await catalogue(asShow, 'series', { imdbId: id });
    const job = await stage(fe, [rowOf(row)]);
    await runToEnd(job);
    assert.equal((await countsOf(job)).ambiguous, 1);
    assert.equal(await count('user_media', 'user_id = $1', [fe]), 0);
  });
});

describe('the title-search path stays strict in SQL, and agrees with the Edge', () => {
  let di;
  before(async () => {
    di = await t.createUser({ username: 'imdb_verified_di' });
  });
  beforeEach(async () => {
    await t.sql(`delete from import_jobs`);
    await t.sql(`delete from user_media where user_id = $1`, [di]);
  });

  it('a title-search answer with a different display title is refused on both sides', async () => {
    const row = claim({
      name: 'Harry Potter and the Sorcerer’s Stone',
      year: 2001,
      imdb_id: tt(),
    });
    const hit = film(900400, "Harry Potter and the Philosopher's Stone", '2001-11-16');
    assert.equal(pick({ name: row.name, year: row.year }, [hit]), null);

    const item = await catalogue(hit, 'movie');
    const job = await stage(di, [rowOf(row)]);
    const [claimed] = await matchAndClaim(job);
    // No p_imdb_id: a title search proves nothing about the id.
    await t.sql(`select _import_provider_resolve($1, $2, false)`, [claimed.row_id, item]);
    assert.equal((await statusOf(claimed.row_id)).status, 'unmatched');
    assert.equal(await imdbIdOf(item), null);
  });

  it('an id that is not the row’s own is not a verification: the title rule applies', async () => {
    const row = claim({ name: 'Own Id Film', year: 2004, imdb_id: tt() });
    const item = await catalogue(film(900500, 'Some Other Film', '2004-05-01'), 'movie');
    const job = await stage(di, [rowOf(row)]);
    const [claimed] = await matchAndClaim(job);
    await t.sql(`select _import_provider_resolve($1, $2, false, $3)`, [
      claimed.row_id,
      item,
      tt(),
    ]);
    assert.equal((await statusOf(claimed.row_id)).status, 'unmatched');
    assert.equal(await imdbIdOf(item), null);
  });

  it('an original-title search answer is accepted on both sides, and never writes the id', async () => {
    const row = claim({
      name: 'The Lives of Others',
      original_title: 'Das Leben der Anderen',
      year: 2006,
      imdb_id: tt(),
    });
    const hit = film(
      900600,
      'Lives of Others, The (Restored)',
      '2006-03-23',
      'Das Leben der Anderen',
    );
    assert.equal(pick({ name: row.name, year: row.year }, [hit]), null);
    assert.equal(pickOriginal(row, [hit])?.id, 900600);

    const item = await catalogue(hit, 'movie');
    const job = await stage(di, [rowOf(row)]);
    const [claimed] = await matchAndClaim(job);
    await t.sql(`select _import_provider_resolve($1, $2, false)`, [claimed.row_id, item]);
    assert.equal((await statusOf(claimed.row_id)).status, 'matched');
    assert.equal(await imdbIdOf(item), null);
    await runToEnd(job);
    assert.equal((await countsOf(job)).watched, 1);
  });
});

describe('a verified variant never changes a ranking', () => {
  let ed;
  before(async () => {
    ed = await t.createUser({ username: 'imdb_verified_ed' });
  });

  it('a ranked title found through a differently titled mapping is kept, rating as provenance', async () => {
    const [c] = VERIFIED_CASES;
    const id = tt();
    const item = await catalogue(c.hit, 'movie', { imdbId: id });
    await t.actAs(ed);
    await t.rankToCompletion(item, 'fine', () => item);
    await t.actAs(null);
    const before = await t.ranking(ed);

    const job = await stage(ed, [rowOf({ ...c.row, imdb_id: id }, { imdbRating: 10 })]);
    await runToEnd(job);
    const counts = await countsOf(job);
    assert.equal(counts.kept, 1);
    assert.equal(counts.unmatched, 0);
    assert.deepEqual(await t.ranking(ed), before);
    const prov = await one(
      `select imdb_rating, providers from imported_titles where user_id = $1 and media_item_id = $2`,
      [ed, item],
    );
    assert.equal(prov.imdb_rating, 10);
    assert.deepEqual(prov.providers, ['imdb']);
  });
});

describe('every claimed row lands in exactly one bucket (20261118000200)', () => {
  let gi;
  before(async () => {
    gi = await t.createUser({ username: 'imdb_verified_gi' });
  });
  beforeEach(async () => {
    await t.sql(`delete from import_jobs`);
    await t.sql(`delete from user_media where user_id = $1`, [gi]);
  });

  /** Writes a /find hit through the real upsert, exactly as the Edge Function does. */
  const upsertHit = async (hit) =>
    (
      await one(`select media_item_id from tmdb_upsert_titles($1::jsonb)`, [
        JSON.stringify([catalogueItem(hit)]),
      ])
    ).media_item_id;

  it('an undated /find hit the re-check refuses on a catalogue date is unmatched, not matched', async () => {
    const tmdbId = 900800;
    // A detail call already dated the title; /find now answers with no date at all.
    await upsertHit(film(tmdbId, 'Undated Answer', '2001-05-01'));
    const row = claim({ name: 'Undated Answer', year: 2005, imdb_id: tt() });
    const hit = { ...film(tmdbId, 'Undated Answer', ''), release_date: '' };

    // The Edge accepts it (no date: nothing to disagree about)...
    const decision = decideFind(row, found({ movie_results: [hit] }));
    assert.equal(decision.outcome, 'match');

    // ...the upsert keeps the stored date (coalesce), and the re-check refuses it.
    const item = await upsertHit(hit);
    assert.equal(
      (await one(`select release_date::text as d from media_items where id = $1`, [item])).d,
      '2001-05-01',
    );
    const job = await stage(gi, [rowOf(row)]);
    const [claimed] = await matchAndClaim(job);
    const settled = await resolve(claimed.row_id, item, row.imdb_id);
    assert.equal(settled, 'unmatched');
    // The batch answer counts the database's answer: one bucket, and it is not matched.
    assert.equal(bucketFor({ status: settled, placed: true }), 'unmatched');
    await runToEnd(job);
    const counts = await countsOf(job);
    assert.equal(counts.unmatched, 1);
    assert.equal(counts.watched, 0);
    assert.equal(await imdbIdOf(item), null);
  });

  it('a mixed batch: one bucket per row, and the buckets add up to the rows claimed', async () => {
    const placed = await catalogue(film(900810, 'Bucket Placed', '2010-01-01'), 'movie');
    const show1 = await catalogue(show(900811, 'Bucket Show', '2010-01-01'), 'series');
    const rows = [
      claim({ name: 'Bucket Placed', year: 2010, imdb_id: tt() }),
      claim({ name: 'Bucket Show', year: 2010, imdb_id: tt(), title_type: 'TV Series' }),
      claim({ name: 'Bucket Episode', year: 2010, imdb_id: tt() }),
      claim({ name: 'Bucket Nothing', year: 2010, imdb_id: tt() }),
      claim({ name: 'Bucket Retry', year: 2010, imdb_id: tt() }),
    ];
    const job = await stage(
      gi,
      rows.map((r) => rowOf(r)),
    );
    await t.sql(`select _import_match_batch($1, 50)`, [job]);
    const { rows: claims } = await t.sql(`select * from _import_provider_claim(50)`);
    assert.equal(claims.length, rows.length);
    const byName = Object.fromEntries(claims.map((c) => [c.name, c.row_id]));

    const buckets = [
      bucketFor({
        status: await resolve(byName['Bucket Placed'], placed, rows[0].imdb_id),
        placed: true,
      }),
      bucketFor({
        status: await resolve(byName['Bucket Show'], show1, rows[1].imdb_id),
        placed: true,
      }),
      bucketFor({
        status: (
          await one(`select _import_provider_resolve($1, null, false, null, true) as s`, [
            byName['Bucket Episode'],
          ])
        ).s,
      }),
      bucketFor({
        status: (
          await one(`select _import_provider_resolve($1, null, true) as s`, [
            byName['Bucket Nothing'],
          ])
        ).s,
      }),
      bucketFor({
        status: (
          await one(`select _import_provider_resolve($1, null, false) as s`, [
            byName['Bucket Retry'],
          ])
        ).s,
      }),
    ];
    assert.deepEqual(buckets, [
      'matched',
      'matched_not_added',
      'unsupported',
      'unmatched',
      'retry',
    ]);
    // A second answer for a row already settled writes nothing and says so.
    assert.equal(await resolve(byName['Bucket Placed'], placed, rows[0].imdb_id), 'stale');
  });
});

describe('the shared-mapping title rule is the same function on both sides', () => {
  const samples = [
    'Fathers & Daughters',
    'Fathers and Daughters',
    'The Long Goodbye Film',
    'A Quiet Place',
    'An Education',
    'A',
    'The',
    'Theory of Everything',
    '  the   Ring',
    'THE RING',
    'Amélie',
    'Harry Potter and the Sorcerer’s Stone',
    'Spider-Man: Into the Spider-Verse',
    'Леон',
    '千と千尋の神隠し',
    'Rock & Roll & Rhythm',
    '',
  ];

  it('_import_imdb_title_norm equals mappingNorm on every sample', async () => {
    for (const value of samples) {
      const { n } = await one(`select _import_imdb_title_norm($1) as n`, [value]);
      assert.equal(n, mappingNorm(value), JSON.stringify(value));
    }
  });

  it('_import_imdb_mapping_title_agrees equals mappingTitleAgrees on every pair', async () => {
    const pairs = [
      ['Fathers & Daughters', 'Fathers and Daughters'],
      ['Long Goodbye Film', 'The Long Goodbye Film'],
      ['Harry Potter and the Sorcerer’s Stone', "Harry Potter and the Philosopher's Stone"],
      ['Insurgent', 'The Divergent Series: Insurgent'],
      ['Spider-Man: Into the Spider-Verse', 'Spiderman Into the Spiderverse'],
      ['Alien', 'Aliens'],
    ];
    for (const [name, title] of pairs) {
      const item = await catalogue(film(901000 + seq, title, '2000-01-01'), 'movie');
      const { ok } = await one(`select _import_imdb_mapping_title_agrees($1, $2, null) as ok`, [
        item,
        name,
      ]);
      assert.equal(ok, mappingTitleAgrees({ name }, { title }), `${name} / ${title}`);
    }
  });
});

describe('a moved primary date: Hamilton, tt8503618 (20261118000200)', () => {
  let ho;
  before(async () => {
    ho = await t.createUser({ username: 'imdb_verified_ho' });
  });
  beforeEach(async () => {
    await t.sql(`delete from import_jobs`);
    await t.sql(`delete from user_media where user_id = $1`, [ho]);
  });

  // Synthetic /release_dates for TMDB 556574: the 2020 streaming premiere and a 2025
  // theatrical release, which is now the primary date. Shape as TMDB documents it.
  const releaseDates = {
    id: 556574,
    results: [
      {
        iso_3166_1: 'US',
        release_dates: [
          { certification: 'PG-13', release_date: '2020-07-03T00:00:00.000Z', type: 4 },
          { certification: 'PG-13', release_date: '2025-09-05T00:00:00.000Z', type: 3 },
        ],
      },
      {
        iso_3166_1: 'GB',
        release_dates: [{ release_date: '2025-09-12T00:00:00.000Z', type: 3 }],
      },
    ],
  };
  const hit = film(556574, 'Hamilton', '2025-09-05');

  it('Edge: a year conflict, rescued by another release date within a year', () => {
    const row = claim({ name: 'Hamilton', year: 2020, imdb_id: 'tt8503618' });
    const decision = decideFind(row, found({ movie_results: [hit] }));
    assert.equal(decision.outcome, 'conflict');
    assert.equal(decision.reason, 'year');
    assert.equal(decision.result.id, 556574);
    assert.equal(releaseYearAgreeing(row, releaseDates), 2020);
  });

  it('SQL: accepted with the release-year evidence, the row linked, the shared id withheld', async () => {
    // A fresh synthetic id: the control case above already taught the catalogue tt8503618.
    const row = claim({ name: 'Hamilton', year: 2020, imdb_id: tt() });
    const item = await catalogue({ ...hit, id: 900901 }, 'movie');
    const job = await stage(ho, [rowOf(row)]);
    const [claimed] = await matchAndClaim(job);
    assert.equal(await resolve(claimed.row_id, item, row.imdb_id, 2020), 'matched');
    // The title agrees exactly, but the catalogue's own date (2025) does not, so Tier 1
    // could not accept this mapping by itself: nothing shared is written.
    assert.equal(await imdbIdOf(item), null);
    await runToEnd(job);
    assert.equal((await countsOf(job)).watched, 1);
  });

  it('SQL: without the evidence, or with evidence out of tolerance, it stays a conflict', async () => {
    const row = claim({ name: 'Hamilton', year: 2020, imdb_id: tt() });
    const item = await catalogue(film(900900, 'Hamilton', '2025-09-05'), 'movie');
    for (const evidence of [null, 2017, 2023]) {
      await t.sql(`delete from import_jobs`);
      const job = await stage(ho, [rowOf(row)]);
      const [claimed] = await matchAndClaim(job);
      assert.equal(await resolve(claimed.row_id, item, row.imdb_id, evidence), 'unmatched');
    }
  });

  it('Edge: no release date within a year keeps the conflict', () => {
    const row = claim({ name: 'Hamilton', year: 2020, imdb_id: 'tt8503618' });
    const late = {
      results: [
        { iso_3166_1: 'US', release_dates: [{ release_date: '2025-09-05T00:00:00.000Z' }] },
      ],
    };
    assert.equal(releaseYearAgreeing(row, late), null);
  });
});

describe('grants on what 20261118000100 and 20261118000200 define', () => {
  it('the new helpers are reachable by no client role', async () => {
    for (const fn of [
      '_import_imdb_verified_agrees(uuid, media_kind, integer)',
      '_import_imdb_title_norm(text)',
      '_import_imdb_mapping_title_agrees(uuid, text, text)',
    ]) {
      for (const role of ['anon', 'authenticated']) {
        const { rows } = await t.sql(`select has_function_privilege($1, $2, 'execute') as ok`, [
          role,
          fn,
        ]);
        assert.equal(rows[0].ok, false, `${role} ${fn}`);
      }
    }
  });

  it('the old five-argument resolve is gone, so no overload can be ambiguous', async () => {
    const { rows } = await t.sql(
      `select count(*)::int as n from pg_proc where proname = '_import_provider_resolve'`,
    );
    assert.equal(rows[0].n, 1);
  });

  it('the verified helper alone is reachable by no client role', async () => {
    for (const role of ['anon', 'authenticated']) {
      const { rows } = await t.sql(
        `select has_function_privilege($1, '_import_imdb_verified_agrees(uuid, media_kind, integer)', 'execute') as ok`,
        [role],
      );
      assert.equal(rows[0].ok, false, role);
    }
  });

  it('_import_provider_resolve stays service-role only', async () => {
    const { rows } = await t.sql(
      `select has_function_privilege('authenticated', '_import_provider_resolve(uuid, uuid, boolean, text, boolean, integer)', 'execute') as a,
              has_function_privilege('anon', '_import_provider_resolve(uuid, uuid, boolean, text, boolean, integer)', 'execute') as b,
              has_function_privilege('service_role', '_import_provider_resolve(uuid, uuid, boolean, text, boolean, integer)', 'execute') as c`,
    );
    assert.deepEqual(rows[0], { a: false, b: false, c: true });
  });
});
