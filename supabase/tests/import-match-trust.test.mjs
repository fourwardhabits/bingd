import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The trust boundary on the shared film-URI cache — `20260917000900`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS ABOUT
 *
 * `letterboxd_matches` maps a Letterboxd film URI to a `media_items.id`, globally and
 * permanently, and the matcher's T0 tier reads it as exact truth for every later importer.
 * Until `20260917000900` it was written directly by whichever import got there first.
 *
 * The guard both writers had -- the export's year must agree with the catalogue row's
 * release date -- checks `name <-> year`. The thing being recorded is `filmUri -> film`.
 * The URI was carried along beside the evidence and then written as the key, without ever
 * being part of the evidence, and **no tier can make it so**: the provider searches TMDB by
 * the client's own name and year and never dereferences the URI either. Nothing in this
 * system fetches a Letterboxd page.
 *
 * So the tests below are written as the attack and its consequences rather than as unit
 * tests of a function. The first one is the exploit, verbatim; if it ever passes in the old
 * sense -- a trusted row appearing -- somebody has restored a direct write.
 */

let t;
let seq = 91000;

/**
 * A catalogue film, and an assertion that it is the only one by that name.
 *
 * **Every title in this file is invented**, which is not a stylistic choice. The harness
 * seeds the real catalogue, so a fixture called *Dune* or *The Godfather* is a second row
 * with the same squashed title and a year within one of the seeded original — the matcher
 * correctly calls that ambiguous, resolves it to nothing, and every assertion downstream
 * fails for a reason that has nothing to do with what is being tested.
 *
 * The uniqueness check is here rather than in a comment because that mistake reads exactly
 * like a product bug: rows come back `ambiguous`, no claim is recorded, nothing is
 * promoted. Far better for the fixture to say so at the point it is built.
 */
const movie = async (title, year) => {
  const { rows } = await t.sql(
    `insert into media_items (kind, tmdb_id, title, release_date, provenance)
     values ('movie', $1, $2, $3, 'manual') returning id`,
    [-Math.abs(seq++), title, `${year}-06-01`],
  );

  const { rows: twins } = await t.sql(
    `select count(*)::int as n from media_items
      where kind = 'movie' and sort_key_squashed = media_squash($1)`,
    [title],
  );
  assert.equal(
    twins[0].n,
    1,
    `fixture "${title}" collides with the seeded catalogue; invent a title nobody has filmed`,
  );

  return rows[0].id;
};

/**
 * A film inserted without the uniqueness check, for the one case that wants a collision.
 *
 * The remake case is the whole point of the ambiguity rule, so a test about it has to build
 * two rows that squash identically. Separated from `movie` rather than given a flag,
 * because "this fixture is deliberately ambiguous" is worth reading at the call site.
 */
const collidingMovie = async (title, year) => {
  const { rows } = await t.sql(
    `insert into media_items (kind, tmdb_id, title, release_date, provenance)
     values ('movie', $1, $2, $3, 'manual') returning id`,
    [-Math.abs(seq++), title, `${year}-06-01`],
  );
  return rows[0].id;
};

const row = (name, year, uri, over = {}) => ({
  kind: 'watched',
  correlation: `${name.toLowerCase()}|${year}`,
  name,
  year,
  filmUri: uri,
  rating: 4.5,
  bucket: 'loved',
  watchedOn: null,
  ...over,
});

/**
 * Stages and matches one archive for one account, without running apply.
 *
 * The job is closed at the end, which is not tidiness: `import_create` adopts an account's
 * open job for an hour, so without this a second import by the same person inside one test
 * lands on the first job and `import_stage` refuses it with `22023`. Several tests here are
 * *about* the same account importing twice, so closing the job is what lets them say so.
 *
 * Closed by writing `completed_at` rather than by deleting, so the matched rows survive for
 * `statusOf` to read. That fires `20260917000600`'s redaction trigger, which is harmless
 * here and is itself worth having on this path: it proves the claims were recorded during
 * matching rather than read back out of `raw` afterwards.
 */
const matchArchive = async (user, rows) => {
  await t.actAs(user);
  const { rows: created } = await t.sql(`select import_create() as id`);
  const jobId = created[0].id;
  await t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, JSON.stringify(rows)]);
  await t.sql(`select import_ready($1) as r`, [jobId]);
  await t.actAs(null);
  await t.sql(`select _import_match_batch($1, 500) as n`, [jobId]);
  await t.sql(
    `update import_jobs set status = 'done', completed_at = now() where id = $1`, [jobId]);
  return jobId;
};

const trusted = async (uri) => {
  const { rows } = await t.sql(
    `select media_item_id, tier, claim_count from letterboxd_matches where letterboxd_uri = $1`,
    [uri],
  );
  return rows[0] ?? null;
};

const claims = async (uri) => {
  const { rows } = await t.sql(
    `select media_item_id, user_id, tier from letterboxd_match_claims
      where letterboxd_uri = $1 order by claimed_at, user_id`,
    [uri],
  );
  return rows;
};

const statusOf = async (jobId, correlation) => {
  const { rows } = await t.sql(
    `select status, media_item_id from import_rows where job_id = $1 and correlation = $2`,
    [jobId, correlation],
  );
  return rows[0] ?? null;
};

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.actAs(null);
  await t.sql(`delete from import_jobs`);
  await t.sql(`delete from letterboxd_matches`);
  await t.sql(`delete from letterboxd_match_claims`);
});

// ===========================================================================

describe('one account cannot assert a shared mapping', () => {
  let mallory;
  let godfather;
  let cats;
  const GODFATHER_URI = 'https://boxd.it/2aRealGodfatherSlug';

  before(async () => {
    mallory = await t.createUser({ username: 'trust_mallory' });
    godfather = await movie('Mob Epic Of Seventy Two', 1972);
    cats = await movie('Feline Musical Revue', 2019);
  });

  it('records the attacker’s row as a claim and trusts nothing', async () => {
    // The exploit, verbatim: a real film's URI attached to a different film's name and
    // year. T1 resolves *Cats (2019)* uniquely and the years agree, which is the whole of
    // the evidence the old writer demanded.
    const jobId = await matchArchive(mallory, [row('Feline Musical Revue', 2019, GODFATHER_URI)]);

    // The row itself still matches — this is the attacker's own collection and they are
    // entitled to put Cats in it. Nothing about the attack is refused locally.
    assert.equal((await statusOf(jobId, 'feline musical revue|2019')).status, 'matched');
    assert.equal((await statusOf(jobId, 'feline musical revue|2019')).media_item_id, cats);

    // But nothing is shared. This is the assertion the vulnerability failed.
    assert.equal(await trusted(GODFATHER_URI), null, 'one account must not create a mapping');

    const recorded = await claims(GODFATHER_URI);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].media_item_id, cats);
    assert.equal(recorded[0].user_id, mallory, 'a claim is attributable to whoever made it');
    assert.equal(recorded[0].tier, 'local');
  });

  it('does not let the same account corroborate itself by importing twice', async () => {
    // The first thing an attacker would try, and also the most ordinary thing an honest
    // person does. The claims primary key is what stops it.
    await matchArchive(mallory, [row('Feline Musical Revue', 2019, GODFATHER_URI)]);
    await matchArchive(mallory, [row('Feline Musical Revue', 2019, GODFATHER_URI)]);

    assert.equal((await claims(GODFATHER_URI)).length, 1, 'one account is one claim');
    assert.equal(await trusted(GODFATHER_URI), null);
  });

  it('leaves the URI unresolved while two accounts disagree about it', async () => {
    // The attacker claims Cats; an honest importer claims The Godfather. Two claims on one
    // URI, but not on one *pair* — so neither reaches the bar and the URI stays open.
    // Disagreement answered by abstention, which is the same answer T1 gives an ambiguous
    // title.
    const victim = await t.createUser({ username: 'trust_victim' });
    await matchArchive(mallory, [row('Feline Musical Revue', 2019, GODFATHER_URI)]);
    await matchArchive(victim, [row('Mob Epic Of Seventy Two', 1972, GODFATHER_URI)]);

    assert.equal((await claims(GODFATHER_URI)).length, 2);
    assert.equal(await trusted(GODFATHER_URI), null);
  });

  it('settles on the truth once two honest accounts agree, not on the attacker’s claim', async () => {
    const victim = await t.createUser({ username: 'trust_victim_b' });
    const other = await t.createUser({ username: 'trust_other_b' });

    await matchArchive(mallory, [row('Feline Musical Revue', 2019, GODFATHER_URI)]);
    await matchArchive(victim, [row('Mob Epic Of Seventy Two', 1972, GODFATHER_URI)]);
    await matchArchive(other, [row('Mob Epic Of Seventy Two', 1972, GODFATHER_URI)]);

    const promoted = await trusted(GODFATHER_URI);
    assert.ok(promoted, 'two agreeing accounts is enough');
    assert.equal(promoted.media_item_id, godfather, 'and they agreed on the right film');
    assert.equal(promoted.claim_count, 2);
  });
});

describe('a mapping two accounts did agree on', () => {
  let ana;
  let ben;
  let cara;
  let dune;
  const DUNE_URI = 'https://boxd.it/2bDune';

  before(async () => {
    ana = await t.createUser({ username: 'trust_ana' });
    ben = await t.createUser({ username: 'trust_ben' });
    cara = await t.createUser({ username: 'trust_cara' });
    dune = await movie('Desert Saga Of Arrakeen', 2021);
  });

  it('is promoted on the second account and not the first', async () => {
    await matchArchive(ana, [row('Desert Saga Of Arrakeen', 2021, DUNE_URI)]);
    assert.equal(await trusted(DUNE_URI), null, 'one is not enough');

    await matchArchive(ben, [row('Desert Saga Of Arrakeen', 2021, DUNE_URI)]);
    const promoted = await trusted(DUNE_URI);
    assert.ok(promoted);
    assert.equal(promoted.media_item_id, dune);
    assert.equal(promoted.tier, 'local');
  });

  it('is then consumed by a third account through T0, whatever they called the film', async () => {
    // The point of the cache, and the proof that promotion actually feeds T0: Cara's export
    // gives a title the local tier cannot match at all. Only the trusted URI can place it.
    await matchArchive(ana, [row('Desert Saga Of Arrakeen', 2021, DUNE_URI)]);
    await matchArchive(ben, [row('Desert Saga Of Arrakeen', 2021, DUNE_URI)]);

    const jobId = await matchArchive(cara, [row('Desert Saga Alternate Cut', 2021, DUNE_URI)]);
    const placed = await statusOf(jobId, 'desert saga alternate cut|2021');

    assert.equal(placed.status, 'matched');
    assert.equal(placed.media_item_id, dune, 'placed by the URI, not by the title');
  });

  it('is not unseated by a later pair of accounts claiming something else', async () => {
    // Displacing an established mapping would hand the attack back at the cost of one extra
    // account. A genuine correction is an operator's job.
    const rival = await movie('Rival Claim Film', 2003);
    await matchArchive(ana, [row('Desert Saga Of Arrakeen', 2021, DUNE_URI)]);
    await matchArchive(ben, [row('Desert Saga Of Arrakeen', 2021, DUNE_URI)]);

    const e = await t.createUser({ username: 'trust_e' });
    const f = await t.createUser({ username: 'trust_f' });
    const jobE = await matchArchive(e, [row('Rival Claim Film', 2003, DUNE_URI)]);
    await matchArchive(f, [row('Rival Claim Film', 2003, DUNE_URI)]);

    const still = await trusted(DUNE_URI);
    assert.equal(still.media_item_id, dune, 'the established mapping holds');

    /**
     * **And the rival claim is never even recorded**, which is stronger than the rule this
     * test was written to check.
     *
     * T0 runs before T1. Once the URI is trusted, a later row carrying it resolves to the
     * trusted film whatever the row calls itself — so the attacker's own import silently
     * becomes a claim for the *correct* pair, and the film they named never enters the
     * evidence at all. There is no competing claim to accumulate, which means a trusted
     * mapping cannot be contested by volume even in principle.
     *
     * The cost is real and worth naming: an honest person whose export genuinely disagrees
     * with an established mapping gets the established film. That is the same trade every
     * shared cache makes, and it is why promotion demands agreement in the first place.
     */
    assert.equal(
      (await claims(DUNE_URI)).filter((c) => c.media_item_id === rival).length,
      0,
      'a trusted URI cannot be contested: T0 places the row before T1 can name anything else',
    );
    assert.equal((await statusOf(jobE, 'rival claim film|2003')).media_item_id, dune);
  });
});

describe('what never becomes a claim at all', () => {
  let gil;
  let hana;

  before(async () => {
    gil = await t.createUser({ username: 'trust_gil' });
    hana = await t.createUser({ username: 'trust_hana' });
  });

  it('an ambiguous title, however many accounts import it', async () => {
    // Two catalogue rows that squash identically with years within one: a remake. The row
    // is `ambiguous` and resolves to nothing, so there is no pair to claim — the weak
    // evidence never enters the system rather than being filtered out later.
    await collidingMovie('Twin Title Remake Pair', 1990);
    await collidingMovie('Twin Title Remake Pair', 1991);
    const URI = 'https://boxd.it/2cTwin';

    const jobA = await matchArchive(gil, [row('Twin Title Remake Pair', 1990, URI)]);
    await matchArchive(hana, [row('Twin Title Remake Pair', 1990, URI)]);

    assert.equal((await statusOf(jobA, 'twin title remake pair|1990')).status, 'ambiguous');
    assert.equal((await claims(URI)).length, 0);
    assert.equal(await trusted(URI), null);
  });

  it('a match against a catalogue row with no release date', async () => {
    // T1b places the film for the person who named it and is not allowed to speak for
    // anybody else: the catalogue is a cache of whatever was searched for, so an undated
    // stub for one *Nosferatu* would otherwise capture the URI of another.
    const { rows } = await t.sql(
      `insert into media_items (kind, tmdb_id, title, provenance)
       values ('movie', $1, 'Undated Film', 'manual') returning id`,
      [-Math.abs(seq++)],
    );
    const URI = 'https://boxd.it/2dUndated';

    const jobA = await matchArchive(gil, [row('Undated Film', 1999, URI)]);
    await matchArchive(hana, [row('Undated Film', 1999, URI)]);

    assert.equal((await statusOf(jobA, 'undated film|1999')).media_item_id, rows[0].id);
    assert.equal((await claims(URI)).length, 0, 'an undated match is not evidence about a URI');
    assert.equal(await trusted(URI), null);
  });

  it('a row whose export carried no year', async () => {
    const film = await movie('Yearless', 2005);
    const URI = 'https://boxd.it/2eYearless';

    await matchArchive(gil, [row('Yearless', 2005, URI, { year: null, correlation: 'yearless|' })]);
    await matchArchive(hana, [row('Yearless', 2005, URI, { year: null, correlation: 'yearless|' })]);

    assert.equal((await claims(URI)).length, 0);
    assert.equal(await trusted(URI), null);
    assert.ok(film);
  });

  it('a diary-entry URI, which identifies a viewing rather than a film', async () => {
    // A diary URI is per-viewing: it can never denote a film, so it must never become a key
    // in a film cache. The guarantee is structural — both writers read `raw->>'filmUri'`
    // and `import_stage` builds that from the client's `filmUri` field alone, never from a
    // `watches` element — and this is what holds it in place.
    const film = await movie('Rewatched', 2010);
    const FILM_URI = 'https://boxd.it/2fFilm';
    const DIARY_A = 'https://boxd.it/2fDiaryOne';
    const DIARY_B = 'https://boxd.it/2fDiaryTwo';

    const watches = [
      { diaryUri: DIARY_A, watchedOn: '2024-01-02', isRewatch: false },
      { diaryUri: DIARY_B, watchedOn: '2024-06-02', isRewatch: true },
    ];

    await matchArchive(gil, [row('Rewatched', 2010, FILM_URI, { watches })]);
    await matchArchive(hana, [row('Rewatched', 2010, FILM_URI, { watches })]);

    // The film URI behaves normally: two accounts, promoted.
    assert.equal((await trusted(FILM_URI)).media_item_id, film);

    // Neither diary URI appears anywhere in either table.
    for (const diary of [DIARY_A, DIARY_B]) {
      assert.equal(await trusted(diary), null, `${diary} must not be a cache key`);
      assert.equal((await claims(diary)).length, 0, `${diary} must not be claimed`);
    }
  });
});

describe('the promotion itself', () => {
  let ivy;
  let jon;
  let film;
  let other;
  const URI = 'https://boxd.it/2gPromote';

  before(async () => {
    ivy = await t.createUser({ username: 'trust_ivy' });
    jon = await t.createUser({ username: 'trust_jon' });
    film = await movie('Promoted', 2000);
    other = await movie('Different', 2001);
  });

  it('is idempotent, so a repeated call cannot inflate anything', async () => {
    // Stands in for the concurrent case deliberately. Two workers racing on the same pair
    // both insert their claim and both attempt the promotion; what makes that safe is that
    // repeating the whole operation changes nothing, which is testable without a second
    // connection.
    for (let i = 0; i < 4; i += 1) {
      await t.sql(`select _import_promote_match($1, $2, $3, 'local')`, [URI, film, ivy]);
      await t.sql(`select _import_promote_match($1, $2, $3, 'local')`, [URI, film, jon]);
    }

    assert.equal((await claims(URI)).length, 2, 'two accounts, two claims, however many calls');
    const { rows } = await t.sql(
      `select count(*)::int as n from letterboxd_matches where letterboxd_uri = $1`, [URI]);
    assert.equal(rows[0].n, 1, 'and exactly one trusted row');
    assert.equal((await trusted(URI)).media_item_id, film);
  });

  it('resolves a conflicting pair deterministically, by refusing both', async () => {
    // Two accounts claim one URI for different films. Neither pair reaches the bar, so the
    // outcome does not depend on which arrived first — which is what "deterministic" has to
    // mean here.
    await t.sql(`select _import_promote_match($1, $2, $3, 'local')`, [URI, film, ivy]);
    await t.sql(`select _import_promote_match($1, $2, $3, 'local')`, [URI, other, jon]);

    assert.equal(await trusted(URI), null);
    assert.equal((await claims(URI)).length, 2);
  });

  it('cannot be configured down to one, which is the bug itself', async () => {
    // The floor is in the function rather than in the row, so an operator cannot reopen the
    // hole by editing a config value.
    await t.sql(
      `insert into app_config (key, value) values ('import.match_trust_claims', '1'::jsonb)
       on conflict (key) do update set value = excluded.value`);

    await t.sql(`select _import_promote_match($1, $2, $3, 'local')`, [URI, film, ivy]);
    assert.equal(await trusted(URI), null, 'a threshold of one must not be expressible');

    await t.sql(
      `insert into app_config (key, value) values ('import.match_trust_claims', '2'::jsonb)
       on conflict (key) do update set value = excluded.value`);
  });

  it('survives a malformed threshold rather than stopping every import', async () => {
    await t.sql(
      `insert into app_config (key, value) values ('import.match_trust_claims', '"lots"'::jsonb)
       on conflict (key) do update set value = excluded.value`);

    await t.sql(`select _import_promote_match($1, $2, $3, 'local')`, [URI, film, ivy]);
    await t.sql(`select _import_promote_match($1, $2, $3, 'local')`, [URI, film, jon]);
    assert.equal((await trusted(URI)).media_item_id, film, 'falls back to the default of two');

    await t.sql(
      `insert into app_config (key, value) values ('import.match_trust_claims', '2'::jsonb)
       on conflict (key) do update set value = excluded.value`);
  });

  it('is the only way a trusted row appears', async () => {
    // No client RPC may bind an external identity to a media item. Asserted as a privilege
    // fact rather than by trying every function: the table has RLS with no policy, so a
    // client cannot write it directly, and the one definer function that can is internal.
    const { rows: policies } = await t.sql(
      `select count(*)::int as n from pg_policies
        where schemaname = 'public' and tablename in ('letterboxd_matches', 'letterboxd_match_claims')`);
    assert.equal(policies[0].n, 0, 'no policy means no client read or write');

    const { rows: grants } = await t.sql(
      `select coalesce(array_agg(grantee order by grantee), '{}') as roles
         from information_schema.routine_privileges
        where specific_schema = 'public'
          and privilege_type = 'EXECUTE'
          and routine_name = '_import_promote_match'`);
    assert.ok(!grants[0].roles.includes('authenticated'));
    assert.ok(!grants[0].roles.includes('anon'));
  });
});

describe('a re-import after a mapping became trusted', () => {
  it('stays idempotent and adds nothing', async () => {
    const kim = await t.createUser({ username: 'trust_kim' });
    const lee = await t.createUser({ username: 'trust_lee' });
    const film = await movie('Repeatable', 2012);
    const URI = 'https://boxd.it/2hRepeat';

    await matchArchive(kim, [row('Repeatable', 2012, URI)]);
    await matchArchive(lee, [row('Repeatable', 2012, URI)]);
    const promoted = await trusted(URI);

    // Both import the same archive again. The second time round T0 answers, so the rows are
    // matched by the cache rather than by the title — and nothing new is recorded.
    await matchArchive(kim, [row('Repeatable', 2012, URI)]);
    await matchArchive(lee, [row('Repeatable', 2012, URI)]);

    assert.equal((await claims(URI)).length, 2);
    const after = await trusted(URI);
    assert.equal(after.media_item_id, promoted.media_item_id);
    assert.equal(after.claim_count, promoted.claim_count);
    assert.equal(after.media_item_id, film);
  });
});
