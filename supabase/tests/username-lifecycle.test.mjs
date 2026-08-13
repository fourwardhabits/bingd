import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * What happens to a username after its owner stops using it.
 *
 * The rule (data-model.md §2) is that a released name never returns to the pool,
 * because `bingd.app/u/alice` is a durable public link and letting someone else
 * claim `alice` turns every existing link into an impersonation vector. That is
 * INF-2.
 *
 * The rule was enforced for account *deletion* and not for *renaming*, which an
 * independent review caught by testing it rather than reading the comment beside
 * it — the comment in `20260813000200_identity.sql` asserted the primary key alone
 * made reuse impossible, which the later reservation trigger disproves.
 */

test('a released username cannot be claimed by someone else after a rename', async () => {
  const t = await createTestDb();
  try {
    const alice = await t.createUser({ username: 'alice' });

    await t.sql(`update profiles set username = 'alice_moved' where id = $1`, [alice]);

    const { rows: history } = await t.sql(
      `select username, profile_id, redirect_until from username_history where username = 'alice'`,
    );
    assert.equal(history.length, 1, 'renaming should reserve the name it released');
    assert.equal(history[0].profile_id, alice, 'and keep pointing at the account that moved');
    assert.ok(history[0].redirect_until > new Date(), 'with the redirect window still open');

    // The impersonation path: a different account taking the freed name.
    const err = await t.errorFrom(
      `insert into profiles (id, username, display_name)
       values (gen_random_uuid(), 'alice', 'Not Alice')`,
    );
    assert.ok(err, 'a stranger should not be able to claim the released name');
    assert.match(err.message, /reserved/i);
  } finally {
    await t.close();
  }
});

test('renaming stamps username_changed_at, which had no writer before', async () => {
  const t = await createTestDb();
  try {
    const alice = await t.createUser({ username: 'alice' });

    const before = await t.sql(`select username_changed_at from profiles where id = $1`, [alice]);
    assert.equal(before.rows[0].username_changed_at, null);

    await t.sql(`update profiles set username = 'alice_moved' where id = $1`, [alice]);

    const after = await t.sql(`select username_changed_at from profiles where id = $1`, [alice]);
    assert.ok(after.rows[0].username_changed_at, 'a rename should record when it happened');
  } finally {
    await t.close();
  }
});

test('an account can reclaim a name it previously held', async () => {
  const t = await createTestDb();
  try {
    // The reservation must not lock the owner out of their own former name, which
    // is the obvious way to get this wrong: the enforcement trigger checks the new
    // name against history, and history now contains a row naming this account.
    const alice = await t.createUser({ username: 'alice' });

    await t.sql(`update profiles set username = 'alice_moved' where id = $1`, [alice]);
    const err = await t.errorFrom(`update profiles set username = 'alice' where id = $1`, [alice]);

    assert.equal(err, null, 'the original owner should be able to take their name back');
  } finally {
    await t.close();
  }
});

test('an unrelated update does not reserve anything', async () => {
  const t = await createTestDb();
  try {
    // The trigger fires on `update of username`, but Postgres fires that for any
    // statement whose SET list mentions the column, even when the value is
    // unchanged. Without the equality guard, editing a display name through an
    // ORM that writes every column would reserve the user's current name against
    // them.
    const alice = await t.createUser({ username: 'alice' });

    await t.sql(`update profiles set username = 'alice', display_name = 'Alice A' where id = $1`, [
      alice,
    ]);

    const { rows } = await t.sql(
      `select count(*)::int as n from username_history where username = 'alice'`,
    );
    assert.equal(rows[0].n, 0, 'rewriting the same username should reserve nothing');

    const still = await t.sql(`select username_changed_at from profiles where id = $1`, [alice]);
    assert.equal(still.rows[0].username_changed_at, null, 'and should not stamp a change');
  } finally {
    await t.close();
  }
});

test('deleting an account still reserves its name permanently', async () => {
  const t = await createTestDb();
  try {
    // Regression guard: the rename trigger and the delete trigger both write to
    // username_history with an on-conflict clause, and the rename one retains
    // profile_id while the delete one nulls it. A deleted account's name must end
    // up as a bare reservation with no redirect target.
    const alice = await t.createUser({ username: 'alice' });
    await t.sql(`update profiles set username = 'alice_moved' where id = $1`, [alice]);
    await t.sql(`delete from profiles where id = $1`, [alice]);

    const { rows } = await t.sql(
      `select username, profile_id, redirect_until
         from username_history order by username`,
    );

    for (const row of rows) {
      assert.equal(row.profile_id, null, `${row.username} should not redirect to a deleted account`);
      assert.ok(row.redirect_until <= new Date(), `${row.username} should stop redirecting`);
    }

    const names = rows.map((r) => r.username).sort();
    assert.deepEqual(names, ['alice', 'alice_moved'], 'both names stay reserved');
  } finally {
    await t.close();
  }
});
