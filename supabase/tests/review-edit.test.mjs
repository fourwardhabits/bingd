import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Editing a published review — founder physical finding, 2026-08-28.
 *
 * ---------------------------------------------------------------------------
 * THE REPORT, AND WHERE THE FAULT ACTUALLY WAS
 *
 * "If I edit an existing public review, the edited text is not updating in the Reviews
 * tab for that title." It reads like a write that did not persist, and it was not one.
 * The audit went through the whole path and found exactly one broken link, at the end:
 *
 *   1. **the write**        `save_note` assigns `note = v_note`. Not a coalesce, not an
 *                           append, not an insert. Proven below.
 *   2. **the record**       `user_media` is keyed `(user_id, media_item_id)`, so an edit
 *                           is an UPDATE of the one row that can exist for a pair. There
 *                           is no revision table and no second row to select the wrong
 *                           one out of — a duplicate review is *unreachable*, not merely
 *                           absent. Proven below.
 *   3. **the read**         `title_reviews` (20260825000100) selects `um.note` live. It
 *                           returns the new text the instant it is asked. Proven below.
 *   4. **the ask**          nothing asked. `['title-reviews', …]` appeared in exactly one
 *                           place in the client — the hook that reads it — and no writer
 *                           invalidated it. With a 60s global `staleTime` and a log sheet
 *                           that opens *over* the title screen (so nothing unmounts), the
 *                           stale slate simply stayed. Fixed in
 *                           `features/collection/invalidate.ts`, pinned in its own test.
 *
 * So this file owns steps 1 to 3 and `invalidate.test.ts` owns step 4. Both are needed:
 * a test that only forced a refetch would pass over a genuine persistence bug, and a test
 * that only checked persistence is what this suite already had.
 *
 * The founder's lettered script maps onto the cases below: A/B publish and show, C/D/E
 * edit and show the edit, F/G re-read, H no duplicate, I privacy unchanged, J spoiler
 * state unchanged, plus the unshare/reshare round trip and the leaderboard interaction.
 */

let t;
let author;
let reader;
let film;
let seq = 95000;

const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

/** The app's own writer, not a raw UPDATE — the point is that this path is correct. */
const saveNote = async (text, { visibility = null, spoilers = null } = {}) => {
  await t.actAs(author);
  const { rows } = await t.sql(
    `select save_note($1, $2, $3, null, $4::note_visibility, $5) as r`,
    [await uuid(), film, text, visibility, spoilers],
  );
  return rows[0].r;
};

/** What the Reviews tab would draw, read as the other account. */
const reviews = (sort = 'top') =>
  t.asUser(reader, async () => {
    const { rows } = await t.sql(`select * from title_reviews($1, $2, 25)`, [film, sort]);
    return rows;
  });

before(async () => {
  t = await createTestDb();

  author = await t.createUser({ username: 're_author' });
  reader = await t.createUser({ username: 're_reader' });
  film = await t.createMovie('The Edited One', seq++);

  // The row a note is written on. `save_note` refuses a title that is not in the
  // collection, which is the state the log sheet reaches before it ever offers a field.
  await t.sql(
    `insert into user_media (user_id, media_item_id, bucket, watched_on)
     values ($1, $2, 'loved', current_date)`,
    [author, film],
  );
});

after(async () => {
  await t.close();
});

// ---------------------------------------------------------------------------

describe('the founder’s script, end to end on the server', () => {
  it('A/B — publishes a review, and the Reviews tab shows it', async () => {
    const result = await saveNote('Original', { visibility: 'public' });
    assert.equal(result.status, 'ok');

    const rows = await reviews();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].note, 'Original');
  });

  it('C/D/E — edits the same review, and the Reviews tab shows the new text', async () => {
    // The assertion the founder's report is about. `title_reviews` reads `um.note`, so
    // the only way this fails is a write that did not assign — which is what makes it
    // worth separating from the cache half rather than folding both into one story.
    const result = await saveNote('Updated');
    assert.equal(result.status, 'ok');

    const rows = await reviews();
    assert.equal(rows[0].note, 'Updated');
  });

  it('F/G — still shows the new text when it is read again', async () => {
    assert.equal((await reviews())[0].note, 'Updated');
    assert.equal((await reviews('recent'))[0].note, 'Updated');
  });

  it('H — leaves exactly one public review, on both sorts', async () => {
    // Structural rather than lucky: `user_media`'s primary key is (user, title), so a
    // second review by the same author on the same film has nowhere to live. A test that
    // merely counted would pass on a schema that allowed one; this counts *and* says why.
    assert.equal((await reviews('top')).length, 1);
    assert.equal((await reviews('recent')).length, 1);

    const { rows } = await t.sql(
      `select count(*)::int as n from user_media where user_id = $1 and media_item_id = $2`,
      [author, film],
    );
    assert.equal(rows[0].n, 1);
  });

  it('advances the version on an edit, so a concurrent edit can still be detected', async () => {
    // `note_updated_at` is the offline-sync conflict version. The edit above must have
    // moved it, or two devices editing the same review would both think they were current.
    const before = (await reviews())[0].updated_at;
    await saveNote('Updated again');
    const after = (await reviews())[0].updated_at;

    assert.ok(after > before);
    assert.equal((await reviews())[0].note, 'Updated again');
  });
});

// ---------------------------------------------------------------------------

describe('I/J — what the edit must not change', () => {
  it('keeps the review public without being told to on every save', async () => {
    // The edit above passed no visibility, and `save_note` keeps what the row had. A
    // review that silently went private on an edit would look identical to this bug from
    // the outside — the text stops updating because the row stops being returned.
    const { rows } = await t.sql(
      `select note_visibility from user_media where user_id = $1 and media_item_id = $2`,
      [author, film],
    );
    assert.equal(rows[0].note_visibility, 'public');
  });

  it('keeps the spoiler flag through an edit that does not mention it', async () => {
    await saveNote('Spoilery, and marked so', { spoilers: true });
    assert.equal((await reviews())[0].has_spoilers, true);

    await saveNote('Still spoilery, edited');
    assert.equal(
      (await reviews())[0].has_spoilers,
      true,
      'an edit must not quietly unmask a review its author flagged',
    );
  });

  it('keeps a private note out of the Reviews tab, before and after an edit', async () => {
    const shy = await t.createUser({ username: 're_shy' });
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket, note, note_visibility)
       values ($1, $2, 'loved', 'for me only', 'private')`,
      [shy, film],
    );

    assert.ok(!(await reviews()).some((r) => r.user_id === shy));

    await t.actAs(shy);
    await t.sql(`select save_note($1, $2, $3, null, null, null)`, [
      await uuid(),
      film,
      'for me only, revised',
    ]);
    await t.actAs(author);

    assert.ok(
      !(await reviews()).some((r) => r.user_id === shy),
      'editing a private note must not publish it',
    );
  });
});

// ---------------------------------------------------------------------------

describe('unshare and reshare, which is a supported flow', () => {
  it('removes the review from the tab and brings the same one back', async () => {
    await saveNote('Out loud', { visibility: 'public' });
    assert.equal((await reviews()).filter((r) => r.user_id === author).length, 1);

    await saveNote('Out loud', { visibility: 'private' });
    assert.equal((await reviews()).filter((r) => r.user_id === author).length, 0);

    await saveNote('Out loud', { visibility: 'public' });
    const mine = (await reviews()).filter((r) => r.user_id === author);
    assert.equal(mine.length, 1, 'resharing restores the one row, it does not add a second');
    assert.equal(mine[0].note, 'Out loud');
  });
});

// ---------------------------------------------------------------------------

/**
 * The interaction the founder called out by name.
 *
 * The monthly Reviews metric counts `note_first_published_at`, which `20260828000200`
 * stamps **once** and never moves. That is what stops the fix above from turning editing
 * into a way to farm points: the edit path this file exercises is exactly the path that
 * must not mint a second review, and the two changes shipped in the same tranche.
 *
 * Asserted here as well as in `leaderboard.test.mjs` because the two files are asking
 * different questions. That one asks whether the metric is right; this one asks whether
 * the *edit flow the founder reported* leaves it right — same property, reached through
 * the app's own writer rather than through a fixture.
 */
describe('the monthly Reviews metric, through the edit flow', () => {
  const myCount = () =>
    t.asUser(author, async () => {
      const { rows } = await t.sql(`select * from my_leaderboard_standing('reviews')`);
      return rows[0].metric_count;
    });

  it('counts one review, however many times it is edited', async () => {
    const start = await myCount();

    await saveNote('Edit one');
    await saveNote('Edit two');
    await saveNote('Edit three, at length');

    assert.equal(await myCount(), start, 'an edit is not a new review');
  });

  it('counts one review across an unshare and a reshare', async () => {
    const start = await myCount();

    await saveNote('Round trip', { visibility: 'private' });
    await saveNote('Round trip', { visibility: 'public' });

    assert.equal(await myCount(), start, 'republishing is not publishing again');
  });
});
