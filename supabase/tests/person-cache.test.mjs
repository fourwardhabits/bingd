import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * `person_cache`, `tmdb_put_person` and `tmdb_claim_person` — 20260817000500.
 *
 * The properties under test are the ones a person page depends on and the ones a
 * mistake here would silently break:
 *
 *   - a person is world-readable and holds nothing viewer-relative;
 *   - a malformed payload is a failed write, not a row nothing can render;
 *   - exactly one caller wins a claim, and the loser is told to stop;
 *   - a claim placeholder does not look like a person with no work;
 *   - neither writer is reachable by a client.
 *
 * The last is the one worth stating plainly. A client holding `tmdb_put_person`
 * could write any filmography onto any person id and every viewer of that page would
 * render it; a client holding `tmdb_claim_person` could keep any person blank
 * indefinitely, two minutes at a time.
 */

let t;

const PAYLOAD = {
  person: { name: 'Test Person', profile_path: '/p.jpg', known_for: 'Acting' },
  credits: [],
  credit_total: 0,
};

const claim = async (personId) => {
  const { rows } = await t.sql(`select tmdb_claim_person($1) as won`, [personId]);
  return rows[0].won;
};

const row = async (personId) => {
  const { rows } = await t.sql(
    `select payload, expires_at, expires_at > now() as fresh
       from person_cache where tmdb_person_id = $1`,
    [personId],
  );
  return rows[0] ?? null;
};

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

/**
 * The reviews facet had a suite here for one day.
 *
 * It asserted that `media_cache` accepted the facet, that a published review was
 * readable signed out, and that the TTL was a day. All true, and all describing
 * something the founder's acceptance pass removed: a tab called Reviews on a social
 * product should be Bingd's own, so TMDB's left the primary UX and
 * `20260817001000` deleted the rows and narrowed the facet set back.
 *
 * What replaced the behaviour is `title_reviews`, tested in
 * `profile-reviews.test.mjs`. The two assertions worth keeping moved with it: that a
 * private author's writing does not leak, and that a note the author made private does
 * not appear.
 */

describe('writing a person', () => {
  it('stores the payload whole and dates it from app_config', async () => {
    await t.sql(`select tmdb_put_person($1, $2::jsonb)`, [1001, JSON.stringify(PAYLOAD)]);

    const stored = await row(1001);
    assert.equal(stored.payload.person.name, 'Test Person');
    assert.equal(stored.fresh, true);
  });

  it('replaces rather than merges', async () => {
    // A filmography is an ordering, and merging two of them leaves credits behind
    // that the provider has since corrected. Same argument as tmdb_put_list.
    await t.sql(`select tmdb_put_person($1, $2::jsonb)`, [
      1001,
      JSON.stringify({ person: { name: 'Renamed' }, credits: [], credit_total: 0 }),
    ]);

    const stored = await row(1001);
    assert.equal(stored.payload.person.name, 'Renamed');
    assert.equal(stored.payload.credit_total, 0);
  });

  it('refuses a payload with no credits array', async () => {
    // The shape is the contract this table's readers rely on and this function is
    // the only writer, so it is checked here rather than left to whichever caller
    // gets it wrong.
    const error = await t.errorFrom(`select tmdb_put_person($1, $2::jsonb)`, [
      1002,
      JSON.stringify({ person: { name: 'No credits' } }),
    ]);

    assert.equal(error?.code, '22023');
  });

  it('refuses a payload with no person object', async () => {
    const error = await t.errorFrom(`select tmdb_put_person($1, $2::jsonb)`, [
      1003,
      JSON.stringify({ credits: [] }),
    ]);

    assert.equal(error?.code, '22023');
  });

  it('refuses a person id that is not positive', async () => {
    const error = await t.errorFrom(`select tmdb_put_person($1, $2::jsonb)`, [
      0,
      JSON.stringify(PAYLOAD),
    ]);

    assert.equal(error?.code, '23514');
  });

  it('takes its expiry from app_config rather than from a constant', async () => {
    const { rows } = await t.sql(
      `select (value ->> 'person')::integer as hours
         from app_config where key = 'tmdb.cache_ttl_hours'`,
    );
    assert.equal(rows[0].hours, 168);

    // Compared in SQL rather than in JavaScript: an interval crosses the driver
    // boundary as whichever of several shapes the client feels like, and asserting
    // on that shape tests the driver instead of the function.
    const { rows: stored } = await t.sql(
      `select expires_at - fetched_at = interval '168 hours' as week
         from person_cache where tmdb_person_id = 1001`,
    );
    assert.equal(stored[0].week, true);
  });

  it('cannot be configured past the retention window', async () => {
    // Carried over from tmdb_put_facet and tmdb_put_list. A config row is operator
    // data, and no value in it may outlive PRD §19's six months.
    await t.sql(
      `update app_config set value = value || '{"person": 99999}'::jsonb
        where key = 'tmdb.cache_ttl_hours'`,
    );
    await t.sql(`select tmdb_put_person($1, $2::jsonb)`, [1004, JSON.stringify(PAYLOAD)]);

    const { rows } = await t.sql(
      `select expires_at - fetched_at < interval '3601 hours' as capped
         from person_cache where tmdb_person_id = 1004`,
    );
    assert.equal(rows[0].capped, true);

    await t.sql(
      `update app_config set value = value || '{"person": 168}'::jsonb
        where key = 'tmdb.cache_ttl_hours'`,
    );
  });
});

describe('claiming a person', () => {
  it('is granted when nobody holds one', async () => {
    assert.equal(await claim(2001), true);
  });

  it('leaves a placeholder that carries no credits', async () => {
    // The reader treats a payload without `credits` as "not cached", so a claim must
    // not look like a person with no work — otherwise a losing caller renders an
    // empty filmography under a real name for two minutes.
    const stored = await row(2001);

    assert.equal(stored.payload.credits, undefined);
    assert.ok(stored.payload.claimed_at, 'the placeholder should say what it is');
    assert.equal(stored.fresh, true);
  });

  it('expires in minutes rather than at the person TTL', async () => {
    // A claim is a promise to go and fetch, and a promise can be broken. A broken one
    // must cost one refresh cycle, not a person who stays blank for the week the
    // configured TTL would give them.
    const { rows } = await t.sql(
      `select expires_at - now() < interval '5 minutes' as short
         from person_cache where tmdb_person_id = 2001`,
    );

    assert.equal(rows[0].short, true);
  });

  it('is refused to everybody else while it is held', async () => {
    assert.equal(await claim(2001), false);
    assert.equal(await claim(2001), false);
  });

  it('does not let a losing caller extend the holder’s claim', async () => {
    const before = (await row(2001)).expires_at;
    assert.equal(await claim(2001), false);
    const after = (await row(2001)).expires_at;

    // A steady stream of losers pushing the expiry out would keep a dead claim alive
    // forever.
    assert.deepEqual(after, before);
  });

  it('is granted once the claim has expired', async () => {
    await t.sql(
      `update person_cache set expires_at = now() - interval '1 minute'
        where tmdb_person_id = 2001`,
    );

    assert.equal(await claim(2001), true);
  });

  it('is refused while a real answer is fresh', async () => {
    await t.sql(`select tmdb_put_person($1, $2::jsonb)`, [2002, JSON.stringify(PAYLOAD)]);

    assert.equal(await claim(2002), false);
    // A refused claim must not damage the answer it was refused over.
    assert.equal((await row(2002)).payload.person.name, 'Test Person');
  });
});

describe('who can read and write a person', () => {
  it('is readable signed out, like every other catalogue table', async () => {
    // A filmography is what TMDB publishes on a public page. It says nothing about
    // any account, and nothing viewer-relative is stored in it.
    const { rows } = await t.asAnon(() =>
      t.sql(`select tmdb_person_id from person_cache where tmdb_person_id = 1001`),
    );

    assert.equal(rows.length, 1);
  });

  it('cannot be written by a signed-in client', async () => {
    const alice = await t.createUser({ username: 'alice_person' });
    const error = await t.asUser(alice, () =>
      t.errorFrom(`select tmdb_put_person(3001, $1::jsonb)`, [JSON.stringify(PAYLOAD)]),
    );
    await t.actAs(null);

    assert.equal(error?.code, '42501');
  });

  it('cannot be claimed by a signed-in client', async () => {
    const bob = await t.createUser({ username: 'bob_person' });
    const error = await t.asUser(bob, () => t.errorFrom(`select tmdb_claim_person(3002)`));
    await t.actAs(null);

    assert.equal(error?.code, '42501');
  });

  it('cannot be written signed out', async () => {
    const error = await t.asAnon(() =>
      t.errorFrom(`select tmdb_put_person(3003, $1::jsonb)`, [JSON.stringify(PAYLOAD)]),
    );

    assert.equal(error?.code, '42501');
  });

  it('admits no client insert directly either', async () => {
    // The policy grants select and nothing else, so the definer functions are the
    // only write path rather than merely the intended one.
    const carol = await t.createUser({ username: 'carol_person' });
    const error = await t.asUser(carol, () =>
      t.errorFrom(`insert into person_cache (tmdb_person_id, payload, expires_at)
                   values (4001, '{}'::jsonb, now() + interval '1 day')`),
    );
    await t.actAs(null);

    assert.ok(error, 'a client insert should be refused');
  });
});
