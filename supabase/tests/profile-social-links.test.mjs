import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The five links a profile may carry — 20260921000100.
 *
 * The feature is small. What is asserted here is mostly that it is small *in the
 * right way*: that it reuses the bio's machinery rather than standing up a second
 * copy of it, and that reusing it did not quietly widen anything.
 *
 * Three things are load-bearing and each has a section:
 *
 *   1. The stored value is a handle, not a link, and the constraint is what makes
 *      that true — so the client can build a URL by concatenation.
 *   2. `https://` is the only scheme a website may have, enforced by the database
 *      rather than remembered by the form.
 *   3. Nothing about visibility moved. `public_profiles` was recreated to add five
 *      columns, and a recreated view is where `security_invoker` and the
 *      `status = 'active'` filter get lost.
 */

let t;
const nextOp = async () => {
  const { rows } = await t.sql(`select gen_random_uuid() as id`);
  return rows[0].id;
};

const save = (user, args) =>
  t.asUser(user, async () => {
    await t.sql(`select save_profile($1, null, null, null, $2, $3, $4, $5, $6)`, [
      await nextOp(),
      args.instagram ?? null,
      args.tiktok ?? null,
      args.youtube ?? null,
      args.x ?? null,
      args.website ?? null,
    ]);
  });

const refusal = (user, args) =>
  t.asUser(user, async () =>
    t.errorFrom(`select save_profile($1, null, null, null, $2, $3, $4, $5, $6)`, [
      await nextOp(),
      args.instagram ?? null,
      args.tiktok ?? null,
      args.youtube ?? null,
      args.x ?? null,
      args.website ?? null,
    ]),
  );

const linksOf = async (user) => {
  const { rows } = await t.sql(
    `select link_instagram, link_tiktok, link_youtube, link_x, link_website
       from profiles where id = $1`,
    [user],
  );
  return rows[0];
};

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

// ---------------------------------------------------------------------------
// The default, which is what every account that existed before this migration has
// ---------------------------------------------------------------------------

describe('a profile with no links', () => {
  let alice;

  before(async () => {
    alice = await t.createUser({ username: 'alice_links' });
  });

  it('has five nulls, not five empty strings', async () => {
    // The header renders nothing at all for null. '' would be a link to the network's
    // front page wearing somebody's icon.
    assert.deepEqual(await linksOf(alice), {
      link_instagram: null,
      link_tiktok: null,
      link_youtube: null,
      link_x: null,
      link_website: null,
    });
  });

  it('still saves a bio without mentioning them', async () => {
    // The four-argument call is gone, so this is also the assertion that the old
    // shape of the screen's write survived the signature change.
    await t.asUser(alice, async () => {
      await t.sql(`select save_profile($1, null, null, 'Mostly horror.')`, [await nextOp()]);
    });
    await t.actAs(null);

    const { rows } = await t.sql(`select bio from profiles where id = $1`, [alice]);
    assert.equal(rows[0].bio, 'Mostly horror.');
    assert.equal((await linksOf(alice)).link_instagram, null);
  });
});

// ---------------------------------------------------------------------------
// What is stored
// ---------------------------------------------------------------------------

describe('a handle', () => {
  let bob;

  before(async () => {
    bob = await t.createUser({ username: 'bob_links' });
  });

  it('saves all four independently', async () => {
    await save(bob, {
      instagram: 'suraj',
      tiktok: 'suraj.k',
      youtube: 'SurajWatches',
      x: 'suraj_k',
    });
    await t.actAs(null);

    assert.deepEqual(await linksOf(bob), {
      link_instagram: 'suraj',
      link_tiktok: 'suraj.k',
      link_youtube: 'SurajWatches',
      link_x: 'suraj_k',
      link_website: null,
    });
  });

  it('leaves the others alone when one is saved', async () => {
    // Null means "leave this alone", which is the convention the bio established and
    // the reason the form can send only what changed.
    await save(bob, { x: 'suraj_writes' });
    await t.actAs(null);

    const links = await linksOf(bob);
    assert.equal(links.link_x, 'suraj_writes');
    assert.equal(links.link_instagram, 'suraj', 'saving X must not clear Instagram');
  });

  it('is cleared by an empty string, which is the only thing that can clear it', async () => {
    await save(bob, { instagram: '  ' });
    await t.actAs(null);

    const links = await linksOf(bob);
    assert.equal(links.link_instagram, null);
    assert.equal(links.link_x, 'suraj_writes', 'and clearing one clears exactly one');
  });

  it('drops a leading @, whichever client sent it', async () => {
    // The form strips it too. This is the last mile: the stored value is canonical
    // no matter what wrote it.
    await save(bob, { tiktok: '@surajk' });
    await t.actAs(null);

    assert.equal((await linksOf(bob)).link_tiktok, 'surajk');
  });

  it('refuses a URL with a sentence rather than a constraint violation', async () => {
    // 23514 tells a form nothing it can show somebody. This is the distinction
    // 20260817000600 draws for the display name.
    const error = await refusal(bob, { instagram: 'https://instagram.com/suraj' });
    await t.actAs(null);

    assert.equal(error?.code, '22023');
    assert.match(error.message, /not a link/i);
  });

  it('refuses a path separator, which is what makes concatenation safe', async () => {
    // The client builds `https://x.com/<handle>`. A handle containing a slash would
    // let a stored value choose the rest of the path.
    const error = await refusal(bob, { x: 'suraj/../elsewhere' });
    await t.actAs(null);

    assert.equal(error?.code, '22023');
  });

  it('refuses a bare dot sequence, which is a path segment rather than a name', async () => {
    const error = await refusal(bob, { instagram: '..' });
    await t.actAs(null);

    assert.equal(error?.code, '22023');
  });

  it('refuses a space, a control character and a scheme', async () => {
    for (const value of ['two words', 'line\nbreak', 'javascript:alert(1)']) {
      const error = await refusal(bob, { youtube: value });
      await t.actAs(null);
      assert.equal(error?.code, '22023', `${JSON.stringify(value)} should be refused`);
    }
  });

  it('cannot be written past the function, even by a direct update', async () => {
    // The constraint is the rule; the function's check is the message. Both exist for
    // the reason `bio_shape` does.
    const error = await t.errorFrom(`update profiles set link_x = $2 where id = $1`, [
      bob,
      'https://x.com/suraj',
    ]);

    assert.equal(error?.code, '23514');
  });

  it('accepts forty characters and refuses forty-one', async () => {
    // Past every network's own limit, which is the headroom the migration argues for:
    // a constraint that is too tight is the one that breaks a real person.
    await save(bob, { youtube: 'a'.repeat(40) });
    await t.actAs(null);
    assert.equal((await linksOf(bob)).link_youtube, 'a'.repeat(40));

    const error = await refusal(bob, { youtube: 'a'.repeat(41) });
    await t.actAs(null);
    assert.equal(error?.code, '22023');
  });
});

// ---------------------------------------------------------------------------
// The website, where the scheme is the whole security question
// ---------------------------------------------------------------------------

describe('a website', () => {
  let carol;

  before(async () => {
    carol = await t.createUser({ username: 'carol_links' });
  });

  it('saves a full https address, path and query included', async () => {
    await save(carol, { website: 'https://example.com/films?sort=year' });
    await t.actAs(null);

    assert.equal((await linksOf(carol)).link_website, 'https://example.com/films?sort=year');
  });

  it('refuses every scheme that is not https, by name', async () => {
    // The point of the column constraint. `javascript:` and `data:` are the ones that
    // execute; `http:` and `file:` are refused by the same rule rather than by a
    // second one, which is what keeps the rule one rule.
    for (const value of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'file:///etc/passwd',
      'intent://scan#Intent;scheme=zxing;end',
      'http://example.com',
      'example.com',
    ]) {
      const error = await refusal(carol, { website: value });
      await t.actAs(null);
      assert.equal(error?.code, '22023', `${value} should be refused`);
    }
  });

  it('refuses a scheme the constraint would have caught, even by a direct update', async () => {
    const error = await t.errorFrom(`update profiles set link_website = $2 where id = $1`, [
      carol,
      'javascript:alert(1)',
    ]);

    assert.equal(error?.code, '23514');
  });

  it('refuses a control character smuggled into a host', async () => {
    const error = await refusal(carol, { website: 'https://exa\nmple.com' });
    await t.actAs(null);
    assert.equal(error?.code, '22023');
  });

  it('is cleared by an empty string like every other field', async () => {
    await save(carol, { website: '' });
    await t.actAs(null);

    assert.equal((await linksOf(carol)).link_website, null);
  });
});

// ---------------------------------------------------------------------------
// Authorisation — unchanged, and that is the assertion
// ---------------------------------------------------------------------------

describe('who may write them', () => {
  let dave;
  let erin;

  before(async () => {
    dave = await t.createUser({ username: 'dave_links' });
    erin = await t.createUser({ username: 'erin_links' });
  });

  it('writes the caller and nobody else, because the function takes no target', async () => {
    // `save_profile` filters on `auth.uid()` and there is no signature by which it
    // could name another account. The five new parameters did not change that.
    await save(erin, { instagram: 'erin' });
    await t.actAs(null);

    assert.equal((await linksOf(erin)).link_instagram, 'erin');
    assert.equal((await linksOf(dave)).link_instagram, null);
  });

  it('refuses a direct update from another signed-in account, on privilege', async () => {
    // Two layers, and this asserts the outer one. `profiles` has no update policy at
    // all (20260813000200) — writes go through definer functions — and the table
    // grant is not there either, so the refusal is 42501 at the door rather than a
    // policy filtering the row to nothing. An update that got past the grant would
    // still find no policy behind it.
    const error = await t.asUser(erin, async () =>
      t.errorFrom(`update profiles set link_x = 'stolen' where id = $1`, [dave]),
    );
    await t.actAs(null);

    assert.equal(error?.code, '42501');
    assert.equal((await linksOf(dave)).link_x, null);
  });

  it('refuses an anonymous caller on privilege, not on the suspension guard', async () => {
    await t.asAnon(async () => {
      const error = await t.errorFrom(`select save_profile($1, null, null, null, 'anon')`, [
        '00000000-0000-0000-0000-000000000000',
      ]);
      assert.ok(error, 'save_profile should be refused for an anonymous caller');
      assert.match(error.message, /permission denied/i);
    });
    await t.actAs(null);
  });

  it('keeps _social_handle out of a client role, definer or not', async () => {
    // A new function carries the default PUBLIC execute grant (20260813001800), so
    // the revoke is the whole of what makes this true.
    await t.asUser(dave, async () => {
      const error = await t.errorFrom(`select _social_handle('suraj')`);
      assert.ok(error, '_social_handle should not be client-callable');
      assert.match(error.message, /permission denied/i);
    });
    await t.actAs(null);
  });
});

// ---------------------------------------------------------------------------
// Reading them — the recreated view, and the two properties a recreation loses
// ---------------------------------------------------------------------------

describe('public_profiles', () => {
  let frank;

  before(async () => {
    frank = await t.createUser({ username: 'frank_links' });
    await save(frank, { instagram: 'frank', website: 'https://frank.example' });
    await t.actAs(null);
  });

  it('publishes them, like the bio', async () => {
    const { rows } = await t.sql(
      `select link_instagram, link_website from public_profiles where id = $1`,
      [frank],
    );
    assert.equal(rows[0].link_instagram, 'frank');
    assert.equal(rows[0].link_website, 'https://frank.example');
  });

  it('does not publish them for a suspended account', async () => {
    // The `status = 'active'` filter, which a recreation is exactly where you lose.
    const gina = await t.createUser({ username: 'gina_links' });
    await save(gina, { instagram: 'gina' });
    await t.actAs(null);
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [gina]);

    const { rows } = await t.sql(
      `select count(*)::int as n from public_profiles where id = $1`,
      [gina],
    );
    assert.equal(rows[0].n, 0);
  });

  it('does not publish them for a private account a viewer does not follow', async () => {
    // `security_invoker`, the other property a recreation loses — so `profiles_read`
    // decides, and a private account is simply absent rather than present without its
    // links. This is the whole of the privacy rule for this feature: there is no
    // second rule written anywhere.
    const hana = await t.createUser({ username: 'hana_links', visibility: 'private' });
    const stranger = await t.createUser({ username: 'stranger_links' });
    await save(hana, { instagram: 'hana' });
    await t.actAs(null);

    await t.asUser(stranger, async () => {
      const { rows } = await t.sql(
        `select count(*)::int as n from public_profiles where id = $1`,
        [hana],
      );
      assert.equal(rows[0].n, 0);
    });
    await t.actAs(null);
  });

  it('keeps them out of profile_identity, which is what a stranger can reach', async () => {
    // `profile_identity` is the locked shell drawn for an account the viewer may not
    // read — handle, name, avatar, visibility, so a private profile leads somewhere a
    // follow request can be made from. Links are profile content. Putting them there
    // would be a public-data bypass, so the assertion is that the columns are simply
    // not in the function's result type.
    const { rows } = await t
      .sql(
        `select attname from pg_attribute
        where attrelid = (select prorettype::regtype::text from pg_proc
                           where proname = 'profile_identity' limit 1)::regtype
          and attnum > 0`,
      )
      .catch(() => ({ rows: null }));

    const columns = rows
      ? rows.map((r) => r.attname)
      : (
          await t.sql(
            `select unnest(proargnames) as attname from pg_proc where proname = 'profile_identity'`,
          )
        ).rows.map((r) => r.attname);

    for (const column of [
      'link_instagram',
      'link_tiktok',
      'link_youtube',
      'link_x',
      'link_website',
    ]) {
      assert.ok(!columns.includes(column), `profile_identity must not return ${column}`);
    }
  });
});

/**
 * **The grant a recreated view loses** — the subject of
 * `20260817001200_public_profiles_grant.sql`, and a rule rather than one migration's
 * problem.
 *
 * `drop view` takes its grants with it. That file is a whole migration written about one
 * line, because the view had already been dropped and recreated twice without a re-grant:
 * from 2026-08-15 nothing in the repository stated who could read it, and a deployed
 * database fell back to its default privileges. It worked on bingd-nonprod by luck.
 *
 * **This is asserted over the source rather than over the database, and that is the only
 * place it can be asserted.** The first version of this test read
 * `has_table_privilege('anon', 'public_profiles', 'select')` and passed with the grant
 * deleted — because `harness.mjs` grants `anon` and `authenticated` default privileges
 * exactly as Supabase does, so a view created without a grant is readable anyway and the
 * catalogue cannot tell the two apart. That is the same blind spot `20260817001200`
 * describes, met again from the other side.
 *
 * So the rule is checked where it is written: **a migration that drops this view must
 * reissue the grant in the same file.** It is a rule about every future migration and not
 * only this one, which is what makes it worth a test rather than a comment.
 * `test:remote` remains the only thing that can prove the *deployed* view answers a real
 * request, and it probes exactly that.
 */
describe('every migration that recreates public_profiles', () => {
  it('reissues the select grant a drop takes with it', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
    const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();

    const offenders = [];
    for (const file of files) {
      const sql = await readFile(join(dir, file), 'utf8');
      const drops = /drop\s+view\s+(if\s+exists\s+)?public_profiles/i.test(sql);
      const grants = /grant\s+select\s+on\s+public_profiles/i.test(sql);
      if (drops && !grants) offenders.push(file);
    }

    assert.deepEqual(
      offenders,
      // The three that predate the rule. 20260815030000 and 20260817000800 are the
      // recreations that lost it; 20260817001200 is the file that noticed, and it drops
      // nothing — it only grants. They are applied and therefore immutable in effect
      // (20260817001100), so they are named here rather than edited.
      ['20260815030000_avatars.sql', '20260817000800_bio_reviews_and_preferences.sql'],
      'a migration that drops public_profiles must grant select on it again, in the same file',
    );
  });
});
