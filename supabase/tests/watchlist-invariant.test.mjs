import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { createTestDb, createTestDbBefore } from './harness.mjs';

const MIGRATION = '20260815040000_watchlist_invariant.sql';

/**
 * The watchlist invariant (20260815040000).
 *
 * "Watchlist = I intend to watch this", so watching or ranking ends the intention.
 *
 * The happy paths here are the least interesting part. What is worth testing is the
 * four ways the rule could be wrong in a way nobody would notice:
 *
 *   - reaching past the exact object and taking a *series* entry off when a season is
 *     watched while another released season is still unmet, which would delete
 *     something still true. (Since 20260906000100 the series has its own terminating
 *     rule: once every currently released normal season is met, a peer trigger removes
 *     the parent. That rule is tested in series-watchlist.test.mjs; what this file
 *     pins is that _leave_watchlist itself never touches the parent.)
 *   - firing on writes that are not watch signals — a note, a `watching` progress —
 *     which would delete an entry at the moment it is most correct,
 *   - putting the row back on unlog, which the founder explicitly ruled out,
 *   - touching another account's rows, which the trigger's `security definer` makes
 *     possible to get wrong.
 */
describe('watchlist invariant', () => {
  let t;
  let user;

  before(async () => {
    t = await createTestDb();
    user = await t.createUser({ username: 'watcher' });
    await t.actAs(user);
  });

  after(async () => t.close());

  const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

  const call = async (sql, params) => {
    const { rows } = await t.sql(`select ${sql} as result`, params);
    return rows[0].result;
  };

  const watchlisted = async (mediaItemId, forUser = user) => {
    const { rows } = await t.sql(
      `select 1 from watchlist where user_id = $1 and media_item_id = $2`,
      [forUser, mediaItemId],
    );
    return rows.length === 1;
  };

  const addToWatchlist = async (mediaItemId) =>
    call(`set_watchlist($1, $2, true)`, [await uuid(), mediaItemId]);

  describe('removes the exact object', () => {
    it('set_bucket takes a movie off the watchlist', async () => {
      const film = await t.createMovie('Stalker', 2001);
      await addToWatchlist(film);
      assert.equal(await watchlisted(film), true);

      await call(`set_bucket($1, $2, 'loved')`, [await uuid(), film]);

      assert.equal(await watchlisted(film), false);
    });

    it('log_watched takes a movie off the watchlist', async () => {
      const film = await t.createMovie('Solaris', 2002);
      await addToWatchlist(film);

      await call(`log_watched($1, $2, '2026-08-01', null)`, [await uuid(), film]);

      assert.equal(await watchlisted(film), false);
    });

    it('ranking takes a movie off the watchlist', async () => {
      const film = await t.createMovie('Andrei Rublev', 2003);
      await addToWatchlist(film);

      // The first title in a band places with no comparisons, which is the path a
      // user reaching for a watchlisted film most often takes.
      const ranked = await t.createUser({ username: 'ranker' });
      await t.actAs(ranked);
      await call(`set_watchlist($1, $2, true)`, [await uuid(), film]);
      await t.rankToCompletion(film, 'loved', () => film);

      assert.equal(await watchlisted(film, ranked), false);
      await t.actAs(user);
    });

    it('a completed season leaves; the series survives until its last released season is met', async () => {
      // The refined contract of 20260906000100. The season and the series are still
      // separate objects: watching Season 2 removes Season 2's own entry and nothing
      // else, because Season 1 is released and unmet — "I want to watch this show" is
      // still true. Meeting the final released season is what ends it.
      const series = await t.createSeries('Parks and Recreation', 2004);
      const s1 = await t.createSeason(series, 1, 'Season 1');
      const season = await t.createSeason(series, 2, 'Season 2');
      await t.sql(`update media_items set release_date = '2020-01-01' where id in ($1, $2)`, [
        s1,
        season,
      ]);

      await addToWatchlist(series);
      await addToWatchlist(season);

      await call(`set_bucket($1, $2, 'loved')`, [await uuid(), season]);

      assert.equal(await watchlisted(season), false, 'the season should leave');
      assert.equal(
        await watchlisted(series),
        true,
        'wanting to watch the show survives while a released season remains unmet',
      );

      await call(`set_bucket($1, $2, 'loved')`, [await uuid(), s1]);

      assert.equal(
        await watchlisted(series),
        false,
        'the last released season was met, so the show is finished',
      );
    });

    it('set_season_progress removes at completed', async () => {
      const series = await t.createSeries('Severance', 2005);
      const season = await t.createSeason(series, 1, 'Season 1');
      await addToWatchlist(season);

      await call(`set_season_progress($1, $2, 'completed')`, [await uuid(), season]);

      assert.equal(await watchlisted(season), false);
    });
  });

  describe('does not fire on writes that are not watch signals', () => {
    it('marking a season as watching keeps it on the watchlist', async () => {
      const series = await t.createSeries('The Bear', 2006);
      const season = await t.createSeason(series, 1, 'Season 1');
      await addToWatchlist(season);

      await call(`set_season_progress($1, $2, 'watching')`, [await uuid(), season]);

      assert.equal(
        await watchlisted(season),
        true,
        'a season you are part-way through is exactly what a watchlist entry is for',
      );
    });

    /**
     * The two scenarios independent review reproduced against the first version of
     * this migration, which tested the resulting row rather than the transition.
     *
     * Both share a shape: the user has already watched something, has *deliberately*
     * put it back on the watchlist to see again, and then edits something unrelated.
     * The older watch signal must not overrule the newer intention.
     */
    it('a bucketed season put back on the watchlist survives progress=watching', async () => {
      const series = await t.createSeries('Rewatch Show', 2013);
      const season = await t.createSeason(series, 1, 'Season 1');

      await call(`set_bucket($1, $2, 'loved')`, [await uuid(), season]);
      assert.equal(await watchlisted(season), false, 'bucketing removes it');

      await addToWatchlist(season);
      await call(`set_season_progress($1, $2, 'watching')`, [await uuid(), season]);

      assert.equal(
        await watchlisted(season),
        true,
        'the update touches progress, but bucket did not change, so nothing was newly watched',
      );
    });

    it('a watched film put back on the watchlist survives a note-only log_watched', async () => {
      const film = await t.createMovie('Rewatch Film', 2014);

      await call(`log_watched($1, $2, '2026-08-01', null)`, [await uuid(), film]);
      assert.equal(await watchlisted(film), false, 'a watch date removes it');

      await addToWatchlist(film);
      // log_watched names watched_on in its upsert SET list even when the value is
      // unchanged, which is what made the whole-row predicate fire here.
      await call(`log_watched($1, $2, null, 'want to see it again')`, [await uuid(), film]);

      assert.equal(
        await watchlisted(film),
        true,
        'the stored watch date is identical, so no transition occurred',
      );
    });

    it('re-selecting the bucket a title already has changes nothing', async () => {
      const film = await t.createMovie('Same Bucket', 2015);

      await call(`set_bucket($1, $2, 'loved')`, [await uuid(), film]);
      await addToWatchlist(film);
      await call(`set_bucket($1, $2, 'loved')`, [await uuid(), film]);

      assert.equal(await watchlisted(film), true);
    });

    it('a note alone keeps the title on the watchlist', async () => {
      const film = await t.createMovie('Mirror', 2007);
      await addToWatchlist(film);

      // A note with no watch date. The user_media row is created, but nothing on it
      // says the film has been seen.
      await call(`log_watched($1, $2, null, 'a friend recommended this')`, [
        await uuid(),
        film,
      ]);

      assert.equal(await watchlisted(film), true);
    });

    it('save_note on an unwatched title keeps it on the watchlist', async () => {
      const film = await t.createMovie('Nostalghia', 2008);
      await addToWatchlist(film);
      await call(`log_watched($1, $2, null, 'first')`, [await uuid(), film]);

      const { rows } = await t.sql(
        `select note_updated_at from user_media where user_id = $1 and media_item_id = $2`,
        [user, film],
      );
      await call(`save_note($1, $2, 'second', $3)`, [
        await uuid(),
        film,
        rows[0].note_updated_at,
      ]);

      assert.equal(await watchlisted(film), true);
    });
  });

  describe('is one-directional', () => {
    it('unlog does not put the title back on the watchlist', async () => {
      const film = await t.createMovie('The Sacrifice', 2009);
      await addToWatchlist(film);
      await call(`set_bucket($1, $2, 'fine')`, [await uuid(), film]);
      assert.equal(await watchlisted(film), false);

      await call(`unlog($1, $2)`, [await uuid(), film]);

      assert.equal(
        await watchlisted(film),
        false,
        'founder decision: the user re-adds it by hand',
      );
    });
  });

  describe('scope', () => {
    it('leaves another account holding the same title', async () => {
      const other = await t.createUser({ username: 'someone_else' });
      const film = await t.createMovie('Ivan’s Childhood', 2010);

      await addToWatchlist(film);
      await t.actAs(other);
      await call(`set_watchlist($1, $2, true)`, [await uuid(), film]);

      // The other account watches it; ours has not.
      await call(`set_bucket($1, $2, 'loved')`, [await uuid(), film]);
      await t.actAs(user);

      assert.equal(await watchlisted(film, other), false);
      assert.equal(await watchlisted(film), true, 'one account watching is not the other');
    });

    it('leaves other titles on the same account alone', async () => {
      const watched = await t.createMovie('Come and See', 2011);
      const untouched = await t.createMovie('Hard to Be a God', 2012);

      await addToWatchlist(watched);
      await addToWatchlist(untouched);

      await call(`set_bucket($1, $2, 'loved')`, [await uuid(), watched]);

      assert.equal(await watchlisted(watched), false);
      assert.equal(await watchlisted(untouched), true);
    });
  });

  describe('the rankings trigger, in isolation', () => {
    /**
     * Every route a user can take to a `rankings` row goes through `rank_start`,
     * which upserts a bucket first — so the user_media trigger fires and the
     * rankings trigger is never the thing being observed. The suite's other ranking
     * test would pass with this trigger deleted.
     *
     * Writing the row directly is the only way to isolate it. It deliberately
     * violates I3 (a ranking with no matching user_media row), which is exactly why
     * it is confined to this one probe and asserts nothing about ranking itself.
     */
    it('removes on a bare rankings insert with no user_media row', async () => {
      const film = await t.createMovie('Bare Ranking', 2016);
      await addToWatchlist(film);

      await t.sql(
        `insert into rankings (user_id, media_item_id, category, bucket, position)
         values ($1, $2, 'movies', 'loved', 1)`,
        [user, film],
      );

      assert.equal(await watchlisted(film), false);

      await t.sql(`delete from rankings where user_id = $1 and media_item_id = $2`, [
        user,
        film,
      ]);
    });
  });
});

/**
 * The schema-qualification property, as a standing regression test.
 *
 * `_leave_watchlist` names `public.watchlist` and pins `pg_temp` last in its
 * search_path. Both matter: Postgres searches the temporary schema *first* for
 * relation names whenever `pg_temp` is not listed explicitly, so a session-local
 * decoy can capture an unqualified reference inside a SECURITY DEFINER function and
 * redirect the delete — leaving the real row in place and the invariant quietly
 * broken rather than raising.
 *
 * There is no route to this through PostgREST, which cannot issue `CREATE TEMP
 * TABLE`, so this is hygiene rather than a live hole (CVE-2018-1058 is the general
 * form). It is a test because the property is invisible in the function body once
 * you stop looking for it, and a later edit dropping the `public.` prefix would
 * otherwise pass every other test in this file.
 *
 * Its own database: the decoy lives for the length of the session and would shadow
 * the relation for anything that ran afterwards.
 *
 * What this catches, measured rather than assumed: the two defences are each
 * *individually* sufficient, so removing either one alone leaves the property intact
 * and this test still passes — correctly, because nothing is broken. It fails on a
 * full revert to the original form (unqualified relation *and* `search_path = public`),
 * which is the realistic regression: that is the prevailing convention everywhere else
 * in this schema, so it is what a later edit would drift back toward.
 */
describe('watchlist invariant — relation cannot be shadowed', () => {
  let t;

  before(async () => {
    t = await createTestDb();
  });

  after(async () => t.close());

  it('deletes from public.watchlist even with a pg_temp decoy present', async () => {
    const user = await t.createUser({ username: 'shadowed' });
    const film = await t.createMovie('Decoy Target', 2017);

    await t.actAs(user);
    const { rows: op } = await t.sql(`select gen_random_uuid() as id`);
    await t.sql(`select set_watchlist($1, $2, true)`, [op[0].id, film]);

    // As the signed-in role, which is the identity the property has to hold for.
    // Seeded before the decoy exists because set_watchlist is itself unqualified —
    // that is the pre-existing pattern this test deliberately does not depend on.
    await t.asUser(user, async () => {
      await t.sql(`create temp table watchlist (user_id uuid, media_item_id uuid)`);
    });

    const { rows: resolved } = await t.sql(
      `select n.nspname from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where c.oid = 'watchlist'::regclass`,
    );
    assert.match(
      resolved[0].nspname,
      /^pg_temp/,
      'the decoy must actually shadow the name, or this test proves nothing',
    );

    // A watch signal written directly, so only the trigger is under test.
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`,
      [user, film],
    );

    const { rows: real } = await t.sql(
      `select 1 from public.watchlist where user_id = $1 and media_item_id = $2`,
      [user, film],
    );
    assert.equal(real.length, 0, 'the real row must be gone, not the decoy');
  });
});

/**
 * The backfill, tested at the migration boundary.
 *
 * This needs its own database because the point is a state the shared snapshot cannot
 * represent: rows that violate the invariant, existing *before* the migration runs. In
 * the ordinary harness every migration has already been applied to an empty database,
 * so the `do` block deleted nothing and any assertion made afterwards is really
 * measuring the triggers.
 */
describe('watchlist invariant — historical backfill', () => {
  let t;
  let user;
  let other;
  const items = {};

  before(async () => {
    t = await createTestDbBefore(MIGRATION);
    user = await t.createUser({ username: 'historical' });
    other = await t.createUser({ username: 'bystander' });

    const series = await t.createSeries('Legacy Show', 3001);

    items.ranked = await t.createMovie('Legacy Ranked', 3002);
    items.bucketed = await t.createMovie('Legacy Bucketed', 3003);
    items.dated = await t.createMovie('Legacy Dated', 3004);
    items.completed = await t.createSeason(series, 1, 'Season 1');
    items.noteOnly = await t.createMovie('Legacy Note Only', 3005);
    items.watching = await t.createSeason(series, 2, 'Season 2');
    // Both seasons are released, so the parent's survival below states the refined
    // contract of 20260906000100 — a released season (Season 2) remains unmet — and
    // not merely the old exact-object scoping of this migration's backfill.
    await t.sql(`update media_items set release_date = '2020-01-01' where id in ($1, $2)`, [
      items.completed,
      items.watching,
    ]);
    items.untouched = await t.createMovie('Legacy Untouched', 3006);
    items.series = series;
    items.otherAccount = await t.createMovie('Legacy Other', 3007);

    // Everything goes on the watchlist first, as it would have historically.
    for (const id of Object.values(items)) {
      await t.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [
        user,
        id,
      ]);
    }
    await t.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [
      other,
      items.otherAccount,
    ]);

    // Violating rows: written directly, because before this migration the RPCs left
    // the watchlist alone and that is precisely the state being reproduced.
    await t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       values ($1, $2, 'movies', 'loved', 1)`,
      [user, items.ranked],
    );
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'fine')`,
      [user, items.bucketed],
    );
    await t.sql(
      `insert into user_media (user_id, media_item_id, watched_on) values ($1, $2, '2026-01-01')`,
      [user, items.dated],
    );
    await t.sql(
      `insert into user_media (user_id, media_item_id, progress) values ($1, $2, 'completed')`,
      [user, items.completed],
    );

    // Control rows: on the watchlist, with a user_media row that says nothing about
    // having watched it.
    await t.sql(`insert into user_media (user_id, media_item_id, note) values ($1, $2, 'soon')`, [
      user,
      items.noteOnly,
    ]);
    await t.sql(
      `insert into user_media (user_id, media_item_id, progress) values ($1, $2, 'watching')`,
      [user, items.watching],
    );

    // The other account has watched its copy; ours must be unaffected by that.
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')`,
      [other, items.otherAccount],
    );

    await t.applyMigration(MIGRATION);
  });

  after(async () => t.close());

  const survives = async (id, forUser = user) =>
    (
      await t.sql(`select 1 from watchlist where user_id = $1 and media_item_id = $2`, [
        forUser,
        id,
      ])
    ).rows.length === 1;

  it('removes a historically ranked title', async () => {
    assert.equal(await survives(items.ranked), false);
  });

  it('removes a historically bucketed title', async () => {
    assert.equal(await survives(items.bucketed), false);
  });

  it('removes a historically dated title', async () => {
    assert.equal(await survives(items.dated), false);
  });

  it('removes a historically completed season', async () => {
    assert.equal(await survives(items.completed), false);
  });

  it('keeps a title whose only collection state is a note', async () => {
    assert.equal(await survives(items.noteOnly), true);
  });

  it('keeps a season that is only in progress', async () => {
    assert.equal(await survives(items.watching), true);
  });

  it('keeps a title with no collection state at all', async () => {
    assert.equal(await survives(items.untouched), true);
  });

  it('keeps the parent series while a released season remains unmet', async () => {
    // Season 1 is completed and Season 2 is only in progress, so under the refined
    // contract as well as under this migration's exact-object backfill the series
    // entry is still a true intention. The terminating case — every released normal
    // season met — is 20260906000100's backfill, tested at its own boundary in
    // series-watchlist.test.mjs.
    assert.equal(await survives(items.series), true);
  });

  it('keeps our row when a different account watched the same title', async () => {
    assert.equal(await survives(items.otherAccount, other), false);
    assert.equal(await survives(items.otherAccount), true);
  });

  it('is idempotent — re-running the migration removes nothing further', async () => {
    const count = async () =>
      (await t.sql(`select count(*)::int as n from watchlist`)).rows[0].n;

    const before = await count();
    await t.applyMigration(MIGRATION);

    assert.equal(await count(), before);
  });

  describe('the trigger function is not callable by a client', () => {
    it('has no execute grant', async () => {
      const { rows } = await t.sql(`
        select has_function_privilege('authenticated', '_leave_watchlist()', 'execute') as granted`);
      assert.equal(rows[0].granted, false);
    });
  });
});
