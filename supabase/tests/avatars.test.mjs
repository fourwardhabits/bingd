import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The avatars bucket and set_avatar.
 *
 * Two subsystems have to agree here and neither can see the other: a storage
 * policy decides which bytes a user may write, and an RPC decides which path
 * their profile may point at. A hole in either one is a hole -- a user who can
 * upload into somebody else's folder can replace their face, and a user who can
 * point their profile at an arbitrary path can claim one.
 */
describe('avatars', () => {
  let t;
  let alice;
  let bob;

  before(async () => {
    t = await createTestDb();
    alice = await t.createUser({ username: 'alice' });
    bob = await t.createUser({ username: 'bob' });
  });

  after(async () => t.close());

  beforeEach(async () => {
    await t.exec(`delete from storage.objects where bucket_id = 'avatars'`);
    await t.exec(`update profiles set avatar_path = null`);
  });

  const upload = (userId, name) =>
    t.asUser(userId, () =>
      t.errorFrom(`insert into storage.objects (bucket_id, name) values ('avatars', $1)`, [name]),
    );

  const setAvatar = (userId, path) =>
    t.asUser(userId, async () => {
      const { rows } = await t.sql(`select set_avatar($1) as path`, [path]);
      return rows[0].path;
    });

  describe('the bucket', () => {
    it('is public, so a face does not need a signed URL per feed row', async () => {
      const { rows } = await t.sql(`select public from storage.buckets where id = 'avatars'`);
      assert.equal(rows[0].public, true);
    });

    it('refuses anything that is not an image, and anything large', async () => {
      const { rows } = await t.sql(
        `select allowed_mime_types, file_size_limit from storage.buckets where id = 'avatars'`,
      );
      assert.deepEqual(rows[0].allowed_mime_types, ['image/jpeg', 'image/png', 'image/webp']);
      assert.equal(Number(rows[0].file_size_limit), 2 * 1024 * 1024);
    });
  });

  describe('uploading', () => {
    it('lets a user write into their own uuid folder', async () => {
      assert.equal(await upload(alice, `${alice}/1755230000.jpg`), null);
    });

    it('refuses a write into somebody else\u2019s folder', async () => {
      // The whole reason ownership is carried by the path. Without this policy
      // any authenticated account could overwrite any other account's face.
      const error = await upload(alice, `${bob}/1755230000.jpg`);
      assert.ok(error, 'alice was allowed to write into bob\u2019s folder');
    });

    it('refuses a write at the bucket root, which belongs to nobody', async () => {
      assert.ok(await upload(alice, 'face.jpg'));
    });

    it('refuses a signed-out write', async () => {
      const error = await t.asAnon(() =>
        t.errorFrom(`insert into storage.objects (bucket_id, name) values ('avatars', 'x/y.jpg')`),
      );
      assert.ok(error);
    });
  });

  describe('reading', () => {
    it('is open, including to a signed-out client', async () => {
      // Profile pages are served signed-out. This is also the trade the bucket
      // makes: anyone holding the URL keeps it.
      await upload(alice, `${alice}/face.jpg`);

      const rows = await t.asAnon(async () => {
        const { rows } = await t.sql(`select name from storage.objects where bucket_id = 'avatars'`);
        return rows;
      });
      assert.equal(rows.length, 1);
    });
  });

  describe('deleting', () => {
    it('lets a user remove their own old avatar', async () => {
      await upload(alice, `${alice}/old.jpg`);

      const error = await t.asUser(alice, () =>
        t.errorFrom(`delete from storage.objects where name = $1`, [`${alice}/old.jpg`]),
      );
      assert.equal(error, null);

      const { rows } = await t.sql(`select count(*)::int as n from storage.objects`);
      assert.equal(rows[0].n, 0);
    });

    it('does not let a user remove somebody else\u2019s', async () => {
      await upload(bob, `${bob}/face.jpg`);

      // A delete matching no rows is not an error in Postgres, so the
      // assertion is that the object survived rather than that it raised.
      await t.asUser(alice, () =>
        t.sql(`delete from storage.objects where name = $1`, [`${bob}/face.jpg`]),
      );

      const { rows } = await t.sql(`select count(*)::int as n from storage.objects`);
      assert.equal(rows[0].n, 1);
    });
  });

  describe('set_avatar', () => {
    it('stores a path under the caller\u2019s own folder', async () => {
      const path = `${alice}/1755230000.jpg`;
      assert.equal(await setAvatar(alice, path), path);

      const { rows } = await t.sql(`select avatar_path from profiles where id = $1`, [alice]);
      assert.equal(rows[0].avatar_path, path);
    });

    it('refuses a path in another user\u2019s folder', async () => {
      // The storage policy already blocks the *upload*, but nothing stops a
      // modified client from pointing its profile at a path somebody else
      // wrote. That would let an account wear another account's face.
      const error = await t.asUser(alice, () =>
        t.errorFrom(`select set_avatar($1)`, [`${bob}/face.jpg`]),
      );
      assert.match(error.message, /avatar path must be/);
    });

    it('refuses a path that climbs out of the folder', async () => {
      const error = await t.asUser(alice, () =>
        t.errorFrom(`select set_avatar($1)`, [`${alice}/../${bob}/face.jpg`]),
      );
      assert.ok(error);
    });

    it('refuses an absolute URL', async () => {
      // The reason the RPC takes a path and not a URL. Storing what it is given
      // would let any account point its avatar at an off-site tracker that
      // fires once per feed impression.
      const error = await t.asUser(alice, () =>
        t.errorFrom(`select set_avatar($1)`, ['https://example.com/tracker.gif']),
      );
      assert.ok(error);
    });

    it('clears the avatar when passed null', async () => {
      await setAvatar(alice, `${alice}/face.jpg`);
      assert.equal(await setAvatar(alice, null), null);

      const { rows } = await t.sql(`select avatar_path from profiles where id = $1`, [alice]);
      assert.equal(rows[0].avatar_path, null);
    });

    it('cannot be reached before a profile exists', async () => {
      // create_profile deletes the auth.users row of an under-13 signup, and a
      // storage object referencing that row would block the delete -- leaving a
      // refused child's account in place. 20260813002200 names the hazard.
      const { rows } = await t.sql(`select gen_random_uuid() as id`);
      const orphan = rows[0].id;
      await t.sql(`insert into auth.users (id) values ($1)`, [orphan]);

      const error = await t.asUser(orphan, () =>
        t.errorFrom(`select set_avatar($1)`, [`${orphan}/face.jpg`]),
      );
      assert.match(error.message, /no profile/);
    });

    it('is not callable by a signed-out client', async () => {
      const error = await t.asAnon(() => t.errorFrom(`select set_avatar('x/y.jpg')`));
      assert.ok(error);
    });
  });

  describe('the profile projection', () => {
    it('carries the path through public_profiles', async () => {
      await setAvatar(alice, `${alice}/face.jpg`);

      const { rows } = await t.sql(`select avatar_path from public_profiles where id = $1`, [alice]);
      assert.equal(rows[0].avatar_path, `${alice}/face.jpg`);
    });

    it('still runs as its invoker after being recreated', async () => {
      // The view had to be dropped to rename a column out from under it, and a
      // view recreated without security_invoker runs as its owner -- which
      // bypasses RLS on profiles and publishes every private account.
      const { rows } = await t.sql(
        `select reloptions from pg_class where relname = 'public_profiles'`,
      );
      assert.ok(
        (rows[0].reloptions ?? []).includes('security_invoker=true'),
        'public_profiles lost security_invoker',
      );
    });
  });
});
