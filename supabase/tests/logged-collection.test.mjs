import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * `logged_collection` (20260827000400): the PRD §22 projection behind another
 * person's bingd. Awards.
 *
 * The defect this view exists to remove: `user_media` is owner-only by policy, so a
 * visitor's read of somebody else's collection returned zero rows and no error, and
 * Movie Muncher stated `0 / 50` on a profile whose own header said 34 movies. The
 * founder read that number off a real phone. The award and the profile were counting
 * different tables under different policies, and the wrong one of the two answered
 * with a confident zero.
 *
 * What is pinned here, in order of what it would cost to lose:
 *
 *   1. **A visitor sees exactly the owner's logged set** — same media ids, no more,
 *      no fewer — so the visitor's Movie Muncher and the owner's own cannot disagree.
 *   2. **The private columns are not merely hidden, they are absent.** Selecting
 *      `watched_on` or `note` through the view is a 42703, not an empty column.
 *   3. **`can_i_view` is the whole gate**: private-unfollowed and blocked viewers get
 *      zero rows; an approved follower of a private account gets the rows; the base
 *      table stays owner-only even for that follower.
 *   4. **`anon` is refused outright** — the grant is explicit and the revoke is too,
 *      because 20260817001200 records what happens when a view's readable set is left
 *      to default privileges.
 *   5. **One row per title.** The view projects a table keyed by
 *      `(user_id, media_item_id)`, so a rewatch or an edited date can never mint a
 *      second row — the unique-titles rule the watch awards count by.
 */
describe('logged_collection', () => {
  let t;
  let owner;
  let visitor;
  /** Movies: a public note, a private note, one bare, and one offered as whitespace. */
  let noted;
  let secret;
  let bare;
  let blank;
  let season;

  const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

  before(async () => {
    t = await createTestDb();
    owner = await t.createUser({ username: 'collector' });
    visitor = await t.createUser({ username: 'passerby' });

    noted = await t.createMovie('Stalker', 910001);
    secret = await t.createMovie('Solaris', 910002);
    bare = await t.createMovie('Mirror', 910003);
    blank = await t.createMovie('Nostalghia', 910005);
    const series = await t.createSeries('Decalogue', 910004);
    season = await t.createSeason(series, 1, 'Season 1');

    await t.actAs(owner);
    await t.sql(`select log_watched($1, $2, '2026-08-01', 'seen at the cinema', 'public')`, [
      await uuid(),
      noted,
    ]);
    await t.sql(`select log_watched($1, $2, '2026-08-02', 'never telling anybody', 'private')`, [
      await uuid(),
      secret,
    ]);
    await t.sql(`select log_watched($1, $2, '2026-08-03', null)`, [await uuid(), bare]);
    // Whitespace offered as a public review — see the blank-note test for what it pins.
    await t.sql(`select log_watched($1, $2, '2026-08-05', '   ', 'public')`, [
      await uuid(),
      blank,
    ]);
    await t.sql(`select log_watched($1, $2, null, null)`, [await uuid(), season]);
  });

  after(async () => t.close());

  const rowsFor = async (target) =>
    (
      await t.sql(
        `select media_item_id, has_public_note
           from logged_collection
          where user_id = $1
          order by media_item_id`,
        [target],
      )
    ).rows;

  it('shows a visitor exactly the titles the owner logged', async () => {
    const seen = await t.asUser(visitor, () => rowsFor(owner));
    const own = (
      await t.sql(`select media_item_id from user_media where user_id = $1`, [owner])
    ).rows.map((row) => row.media_item_id);

    assert.equal(seen.length, 5, 'every logged title, dated or not, ranked or not');
    assert.deepEqual(new Set(seen.map((row) => row.media_item_id)), new Set(own));
  });

  it('says a public review exists, and keeps a private note to itself', async () => {
    const seen = await t.asUser(visitor, () => rowsFor(owner));
    const byId = new Map(seen.map((row) => [row.media_item_id, row.has_public_note]));

    assert.equal(byId.get(noted), true, 'the public note is an existence fact');
    assert.equal(byId.get(secret), false, 'a private note reads exactly like no note');
    assert.equal(byId.get(bare), false);
  });

  /**
   * The blank note, and why owner/visitor parity does not rest on the client.
   *
   * The view says a public review exists when `note is not null and note_visibility =
   * 'public'`; the owner's own awards read the note text and additionally require it
   * to be non-blank once trimmed (`use-awards.ts`). Two predicates not written the
   * same way, on the two sides of an equality this view exists to make structural —
   * so the question is whether a value can sit between them, and the answer is that
   * the writers do not let one be stored: every note path normalises through
   * `nullif(btrim(coalesce(p_note, '')), '')` (20260813002300, 20260816000000,
   * 20260825000200), so whitespace offered as a review is a NULL note, not an empty
   * one.
   *
   * Pinned here rather than reasoned about in a comment, because it is the writers'
   * invariant that makes the two predicates agree, and a writer that stopped
   * normalising would otherwise show a visitor a Comment Gremlin the owner does not
   * have. Independent review of the combined beta integration raised exactly this.
   */
  it('does not let whitespace become a review for either side', async () => {
    const stored = (
      await t.sql(
        `select note, note_visibility from user_media
           where user_id = $1 and media_item_id = $2`,
        [owner, blank],
      )
    ).rows[0];
    assert.equal(stored.note, null, 'a whitespace note is normalised to NULL by the writer');

    const seen = await t.asUser(visitor, () => rowsFor(owner));
    const byId = new Map(seen.map((row) => [row.media_item_id, row.has_public_note]));
    assert.equal(
      byId.get(blank),
      false,
      'so the view cannot claim a review the owner’s own sheet would not count',
    );
  });

  it('never grew the private columns', async () => {
    const error = await t.errorFrom(`select watched_on from logged_collection limit 1`);
    assert.equal(error?.code, '42703', 'watched_on must not exist on the view');
    const note = await t.errorFrom(`select note from logged_collection limit 1`);
    assert.equal(note?.code, '42703', 'note text must not exist on the view');
  });

  it('answers the owner about their own collection too', async () => {
    const seen = await t.asUser(owner, () => rowsFor(owner));
    assert.equal(seen.length, 5);
  });

  it('gives a stranger nothing from a private account, and a follower everything', async () => {
    const recluse = await t.createUser({ username: 'recluse', visibility: 'private' });
    const confidant = await t.createUser({ username: 'confidant' });
    await t.actAs(recluse);
    await t.sql(`select log_watched($1, $2, '2026-08-04', null)`, [await uuid(), bare]);
    await t.sql(
      `insert into follows (follower_id, followee_id, state, approved_at)
       values ($1, $2, 'approved', now())`,
      [confidant, recluse],
    );

    assert.equal((await t.asUser(visitor, () => rowsFor(recluse))).length, 0);
    assert.equal((await t.asUser(confidant, () => rowsFor(recluse))).length, 1);

    // The follow opens the *titles* and only the titles: the base row, with its date
    // and note, stays the owner's alone — the §22 line this view exists to draw.
    const base = await t.asUser(confidant, async () =>
      (await t.sql(`select count(*)::int as n from user_media where user_id = $1`, [recluse]))
        .rows[0].n,
    );
    assert.equal(base, 0, 'the approved follow must not open user_media itself');
  });

  it('gives a blocked viewer nothing', async () => {
    const wary = await t.createUser({ username: 'wary' });
    await t.actAs(wary);
    await t.sql(`select log_watched($1, $2, '2026-08-05', null)`, [await uuid(), bare]);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [wary, visitor]);

    assert.equal((await t.asUser(visitor, () => rowsFor(wary))).length, 0);
  });

  it('refuses a signed-out reader outright', async () => {
    const error = await t.asAnon(() =>
      t.errorFrom(`select media_item_id from logged_collection limit 1`),
    );
    assert.equal(error?.code, '42501', 'anon must be revoked, not merely filtered');
  });

  it('holds one row per title however the log is revised', async () => {
    // A corrected date is an upsert on the same key, not a second watch event.
    await t.actAs(owner);
    await t.sql(`select log_watched($1, $2, '2026-08-06', null)`, [await uuid(), bare]);

    const seen = await t.asUser(visitor, () => rowsFor(owner));
    assert.equal(seen.filter((row) => row.media_item_id === bare).length, 1);
  });
});
