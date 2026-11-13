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

import { decideFind, pick, pickOriginal } from '../functions/letterboxd-import/match.mjs';

import { createTestDb } from './harness.mjs';
import {
  claim,
  film,
  findFor,
  found,
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

  for (const c of VERIFIED_CASES) {
    it(`a movie: ${c.label}`, async () => {
      // Edge: the /find answer is a match.
      const decision = decideFind(c.row, findFor(c));
      assert.equal(decision.outcome, 'match');

      const item = await catalogue(c.hit, 'movie');

      // First import: no title carries the id, so the provider is asked.
      const job = await stage(ana, [rowOf(c.row)]);
      const claims = await matchAndClaim(job);
      assert.equal(claims.length, 1, 'Tier 1 hands it to the provider');
      assert.equal(claims[0].imdb_id, c.row.imdb_id);
      await t.sql(`select _import_provider_resolve($1, $2, false, $3)`, [
        claims[0].row_id,
        item,
        c.row.imdb_id,
      ]);
      // SQL: the re-check accepts what the Edge accepted, and the id is learned.
      assert.deepEqual(await statusOf(claims[0].row_id), {
        status: 'matched',
        media_item_id: item,
      });
      assert.equal(await imdbIdOf(item), c.row.imdb_id);
      await runToEnd(job);
      const first = await countsOf(job);
      assert.equal(first.watched, 1);
      assert.equal(first.unmatched, 0);

      // Second import of the same file: Tier 1 settles it on the learned mapping, whose
      // display title differs from IMDb's. No provider call, no duplicate.
      const again = await stage(ana, [rowOf(c.row)]);
      assert.equal((await matchAndClaim(again)).length, 0, 'no provider call on a reimport');
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
      // Account isolation: somebody else's collection is untouched by the shared mapping.
      assert.equal(await count('user_media', 'user_id = $1', [bo]), 0);
    });
  }

  for (const c of VERIFIED_TV_CASES) {
    it(`a whole show, recognised and not added: ${c.label}`, async () => {
      assert.equal(decideFind(c.row, findFor(c)).outcome, 'match');
      const item = await catalogue(c.hit, 'series');

      const job = await stage(ana, [rowOf(c.row)]);
      const claims = await matchAndClaim(job);
      assert.equal(claims.length, 1);
      await t.sql(`select _import_provider_resolve($1, $2, false, $3)`, [
        claims[0].row_id,
        item,
        c.row.imdb_id,
      ]);
      assert.equal((await statusOf(claims[0].row_id)).status, 'unsupported');
      await runToEnd(job);
      const first = await countsOf(job);
      assert.equal(first.unsupported_tv, 1, 'counted as a matched TV show not added');
      assert.equal(first.unmatched, 0);

      const again = await stage(ana, [rowOf(c.row)]);
      assert.equal((await matchAndClaim(again)).length, 0);
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
      assert.deepEqual(decideFind(c.row, findFor(c)), { outcome: 'conflict', reason: 'year' });

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

describe('grants on what 20261118000100 defines', () => {
  it('the new helper is reachable by no client role', async () => {
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
      `select has_function_privilege('authenticated', '_import_provider_resolve(uuid, uuid, boolean, text, boolean)', 'execute') as a,
              has_function_privilege('anon', '_import_provider_resolve(uuid, uuid, boolean, text, boolean)', 'execute') as b,
              has_function_privilege('service_role', '_import_provider_resolve(uuid, uuid, boolean, text, boolean)', 'execute') as c`,
    );
    assert.deepEqual(rows[0], { a: false, b: false, c: true });
  });
});
