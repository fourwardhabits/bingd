import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Account creation (20260813002200).
 *
 * Every test runs through `asUser`, as a real `authenticated` role rather than
 * the table owner, because the owner bypasses RLS and would prove nothing about
 * what a client can actually do.
 */
describe('create_profile', () => {
  let t;

  before(async () => {
    t = await createTestDb();
  });

  after(async () => {
    await t.close();
  });

  /** An auth.users row with no profile — what a completed sign-in produces. */
  const newAuthUser = async () => {
    const { rows } = await t.sql(`select gen_random_uuid() as id`);
    const id = rows[0].id;
    await t.sql(`insert into auth.users (id) values ($1)`, [id]);
    return id;
  };

  const createProfileAs = async (userId, args) =>
    t.asUser(userId, () =>
      t.errorFrom(`select create_profile($1, $2, $3::date)`, [
        args.username,
        args.displayName ?? null,
        args.dob ?? '1990-01-01',
      ]),
    );

  /** The returned value, for the cases that answer instead of raising. */
  const createProfileResult = async (userId, args) =>
    t.asUser(userId, async () => {
      const { rows } = await t.sql(`select create_profile($1, $2, $3::date) as r`, [
        args.username,
        args.displayName ?? null,
        args.dob ?? '1990-01-01',
      ]);
      return rows[0].r;
    });

  it('creates the profile and its private row together', async () => {
    const user = await newAuthUser();
    assert.equal(await createProfileAs(user, { username: 'rosalind', displayName: 'Rosalind' }), null);

    const { rows } = await t.sql(
      `select p.username, p.display_name, p.visibility, p.founding_member,
              pp.date_of_birth
         from profiles p join profile_private pp on pp.profile_id = p.id
        where p.id = $1`,
      [user],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].username, 'rosalind');
    assert.equal(rows[0].display_name, 'Rosalind');
    assert.equal(rows[0].visibility, 'public', 'PRD §22 default');
    assert.equal(rows[0].founding_member, true);
  });

  it('falls back to the username when no display name is given', async () => {
    const user = await newAuthUser();
    assert.equal(await createProfileAs(user, { username: 'quiet_type' }), null);
    const { rows } = await t.sql(`select display_name from profiles where id = $1`, [user]);
    assert.equal(rows[0].display_name, 'quiet_type');
  });

  it('trims and lowercases the username rather than rejecting it', async () => {
    const user = await newAuthUser();
    assert.equal(await createProfileAs(user, { username: '  MixedCase  ' }), null);
    const { rows } = await t.sql(`select username from profiles where id = $1`, [user]);
    assert.equal(rows[0].username, 'mixedcase');
  });

  it('refuses an unauthenticated caller', async () => {
    const err = await t.asAnon(() =>
      t.errorFrom(`select create_profile('nobody', null, '1990-01-01'::date)`),
    );
    assert.ok(err, 'expected a refusal');
    // anon has no execute grant, so this is a privilege denial rather than the
    // guard's 28000. Either is a refusal; asserting the code keeps the test from
    // passing for an unrelated reason such as the function not existing.
    assert.equal(err.code, '42501');
  });

  it('refuses a second profile for the same account, distinguishably', async () => {
    const user = await newAuthUser();
    assert.equal(await createProfileAs(user, { username: 'only_once' }), null);

    const err = await createProfileAs(user, { username: 'again_please' });
    assert.ok(err);
    assert.equal(err.code, '42710', 'so a retried request can continue instead of erroring');

    const { rows } = await t.sql(`select count(*)::int as n from profiles where id = $1`, [user]);
    assert.equal(rows[0].n, 1);
  });

  /**
   * auth.md §4: an under-13 refusal deletes the account rather than leaving it
   * dormant. That is why the refusal is a returned value — an exception would roll
   * the deletion back with everything else, and the account would survive every
   * attempt to remove it. These tests exist mainly to pin that down, because
   * "raise on invalid input" is the obvious shape and it is wrong here.
   */
  describe('the age gate', () => {
    it('refuses an under-13 date of birth without raising', async () => {
      const user = await newAuthUser();
      const { rows } = await t.sql(`select (current_date - interval '9 years')::date as d`);
      const result = await createProfileResult(user, { username: 'too_young', dob: rows[0].d });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'under_13');
    });

    /**
     * The delete succeeds today because everything referencing auth.users(id) at this
     * point cascades. A future foreign key that does not cascade blocks it, and
     * storage.objects.owner is the usual culprit, so an avatar uploaded during
     * onboarding would break the age gate rather than the upload.
     *
     * What must not happen then is returning {"ok": false, "account_deleted": true}
     * while the account still exists, because the screen tells the child their
     * details were not kept. This simulates that future by adding exactly such a
     * reference, and asserts the request fails loudly instead.
     */
    it('fails loudly rather than claiming a deletion that did not happen', async () => {
      await t.sql(`
        create table blocks_the_delete (
          user_id uuid primary key references auth.users(id)
        )
      `);
      try {
        const user = await newAuthUser();
        await t.sql(`insert into blocks_the_delete (user_id) values ($1)`, [user]);
        const { rows: d } = await t.sql(`select (current_date - interval '7 years')::date as d`);

        const err = await createProfileAs(user, { username: 'undeletable', dob: d[0].d });
        assert.ok(err, 'a blocked deletion must not be reported as a successful one');
        assert.equal(err.code, 'P0001');

        const { rows } = await t.sql(
          `select count(*)::int as n from profiles where id = $1`,
          [user],
        );
        assert.equal(rows[0].n, 0, 'and it must not have created a profile either');
      } finally {
        await t.sql(`drop table blocks_the_delete`);
      }
    });

    it('deletes the account, so no dormant authenticated user is left behind', async () => {
      const user = await newAuthUser();
      const { rows: d } = await t.sql(`select (current_date - interval '8 years')::date as d`);
      await createProfileResult(user, { username: 'not_stored', dob: d[0].d });

      const { rows } = await t.sql(
        `select (select count(*) from auth.users      where id = $1)
              + (select count(*) from profiles        where id = $1)
              + (select count(*) from profile_private where profile_id = $1) as n`,
        [user],
      );
      assert.equal(Number(rows[0].n), 0, 'auth.users row must be gone, not just the profile');
    });

    it('stores the refused date of birth nowhere', async () => {
      const user = await newAuthUser();
      const { rows: d } = await t.sql(`select (current_date - interval '7 years')::date as d`);
      await createProfileResult(user, { username: 'no_trace', dob: d[0].d });

      const { rows } = await t.sql(
        `select count(*)::int as n from profile_private where date_of_birth = $1`,
        [d[0].d],
      );
      assert.equal(rows[0].n, 0, 'the refused date must not survive anywhere in the table');
    });

    /**
     * The boundary, from both sides, on real calendar dates.
     *
     * DOB-1, decided by the founder on 2026-08-24: the exact date of birth is retained
     * privately, and **13+ stays exactly-calendar and server-side**. `create_profile`
     * compares `p_date_of_birth > current_date - interval '13 years'`, which is why day
     * precision is worth keeping — a birth *year* would have to decide what to do with
     * somebody who turns 13 later this year, and would get one of those two answers
     * wrong for every one of them.
     *
     * Three cases and not one, because an off-by-one in either direction is invisible
     * to a test that only checks an obviously-young and an obviously-old date. The
     * middle case is the one that moves if the comparison is ever loosened to `>=`.
     */
    it('refuses the day before a thirteenth birthday', async () => {
      const user = await newAuthUser();
      const { rows } = await t.sql(
        `select (current_date - interval '13 years' + interval '1 day')::date as d`,
      );
      const result = await createProfileResult(user, {
        username: 'thirteen_tomorrow',
        dob: rows[0].d,
      });

      assert.equal(result.ok, false, 'not yet thirteen is not thirteen');
      assert.equal(result.reason, 'under_13');
    });

    it('accepts exactly thirteen years to the day', async () => {
      const user = await newAuthUser();
      const { rows } = await t.sql(`select (current_date - interval '13 years')::date as d`);
      const result = await createProfileResult(user, {
        username: 'thirteen_today',
        dob: rows[0].d,
      });
      assert.equal(result.ok, true);
    });

    it('accepts the day after a thirteenth birthday', async () => {
      const user = await newAuthUser();
      const { rows } = await t.sql(
        `select (current_date - interval '13 years' - interval '1 day')::date as d`,
      );
      const result = await createProfileResult(user, {
        username: 'thirteen_yesterday',
        dob: rows[0].d,
      });
      assert.equal(result.ok, true);
    });

    it('raises rather than deletes for a missing date of birth', async () => {
      const user = await newAuthUser();
      const err = await t.asUser(user, () =>
        t.errorFrom(`select create_profile('no_dob', null, null)`),
      );
      assert.ok(err);
      assert.equal(err.code, '22023');

      // A blank form field is a form error. Deleting the account over one would
      // make a mistyped signup unrecoverable.
      const { rows } = await t.sql(`select count(*)::int as n from auth.users where id = $1`, [
        user,
      ]);
      assert.equal(rows[0].n, 1, 'the account must survive an input error');
    });

    it('raises rather than deletes for an impossible date', async () => {
      const user = await newAuthUser();
      const err = await createProfileAs(user, { username: 'methuselah', dob: '1850-01-01' });
      assert.ok(err);
      assert.equal(err.code, '22023');
      const { rows } = await t.sql(`select count(*)::int as n from auth.users where id = $1`, [
        user,
      ]);
      assert.equal(rows[0].n, 1);
    });

    it('raises rather than deletes for a malformed username, even with a young date', async () => {
      const user = await newAuthUser();
      const { rows: d } = await t.sql(`select (current_date - interval '9 years')::date as d`);
      const err = await createProfileAs(user, { username: 'no', dob: d[0].d });
      assert.ok(err);
      assert.equal(err.code, '22023');
      const { rows } = await t.sql(`select count(*)::int as n from auth.users where id = $1`, [
        user,
      ]);
      assert.equal(rows[0].n, 1, 'the username error is reported before eligibility is decided');
    });
  });

  describe('username rules', () => {
    it('refuses a name already in use', async () => {
      await t.createUser({ username: 'taken_name' });
      const user = await newAuthUser();
      const err = await createProfileAs(user, { username: 'taken_name' });
      assert.ok(err);
      assert.equal(err.code, '23505');
    });

    it('refuses a name reserved by a deleted account', async () => {
      const gone = await t.createUser({ username: 'departed' });
      await t.sql(`delete from profiles where id = $1`, [gone]);

      const user = await newAuthUser();
      const err = await createProfileAs(user, { username: 'departed' });
      assert.ok(err);
      assert.equal(err.code, '23505', 'same code as in-use: the next action is identical');
    });

    for (const bad of ['ab', 'a'.repeat(25), 'has space', 'has-hyphen', 'has.dot', '']) {
      it(`refuses ${JSON.stringify(bad)} with a legible code`, async () => {
        const user = await newAuthUser();
        const err = await createProfileAs(user, { username: bad });
        assert.ok(err, `expected ${JSON.stringify(bad)} to be refused`);
        assert.equal(err.code, '22023', 'not 23514 from the table constraint');
      });
    }
  });

  /**
   * A display name renders on every social surface and is a named report subject, so
   * an unbounded column is a free-text field pointed at whoever reads it. The client
   * caps it at 50; a modified client is what the server check is for, which is the
   * same reasoning that closed reports.note and reactions.kind.
   */
  describe('display name', () => {
    it('refuses one longer than the client allows', async () => {
      const user = await newAuthUser();
      const err = await createProfileAs(user, {
        username: 'longnamed',
        displayName: 'q'.repeat(51),
      });
      assert.ok(err, 'a megabyte display name must not be storable');
      assert.equal(err.code, '22023');
    });

    it('refuses embedded control characters', async () => {
      const user = await newAuthUser();
      const err = await createProfileAs(user, {
        username: 'multiline',
        displayName: 'first\nsecond',
      });
      assert.ok(err, 'a newline lets one name occupy two rows of every list');
      assert.equal(err.code, '22023');
    });

    it('holds even against a direct insert, not only through the RPC', async () => {
      // The constraint rather than the function check. update_profile and the import
      // path do not exist yet, and this is what makes the rule true for them.
      const user = await newAuthUser();
      const err = await t.errorFrom(
        `insert into profiles (id, username, display_name) values ($1, 'directly', $2)`,
        [user, 'z'.repeat(200)],
      );
      assert.ok(err, 'the table itself should refuse it');
      assert.equal(err.code, '23514');
    });
  });

  /**
   * The reason both functions exist is that the form can answer before
   * submitting. The reason that is a risk is that two implementations of one rule
   * drift, and the symptom is a user told a name is free and then refused it.
   */
  describe('username_available agrees with create_profile', () => {
    it('never reports available for a name create_profile would refuse', async () => {
      // Fixtures are created here rather than inherited from earlier tests in this
      // file. The previous version leaned on names those tests happened to leave
      // behind, and it mattered: 'MixedCase' asserted the two functions agreed, they
      // genuinely disagreed because only create_profile normalized, and the test
      // passed because an earlier test had already created 'mixedcase' so the insert
      // failed for an unrelated reason. Reordering the file would have exposed it.
      await t.createUser({ username: 'agree_taken' });
      const departed = await t.createUser({ username: 'agree_gone' });
      await t.sql(`delete from profiles where id = $1`, [departed]);

      const candidates = [
        'agree_fresh',
        'agree_taken',
        'agree_gone',
        'ab',
        'has space',
        // Normalized by both, so this now passes because they agree rather than
        // because the name was already taken.
        'MixedFresh',
        'a'.repeat(25),
        'agree_ok_2',
      ];

      for (const candidate of candidates) {
        const user = await newAuthUser();
        const available = await t.asUser(user, async () => {
          const { rows } = await t.sql(`select username_available($1) as ok`, [candidate]);
          return rows[0].ok;
        });
        const err = await createProfileAs(user, { username: candidate });

        if (available) {
          assert.equal(err, null, `said ${candidate} was available and then refused it`);
        } else {
          assert.ok(err, `said ${candidate} was unavailable and then accepted it`);
        }
      }
    });

    it('lets a user reclaim their own former name', async () => {
      const user = await t.createUser({ username: 'first_name' });
      await t.sql(`update profiles set username = 'second_name' where id = $1`, [user]);

      const ownView = await t.asUser(user, async () => {
        const { rows } = await t.sql(`select username_available('first_name') as ok`);
        return rows[0].ok;
      });
      assert.equal(ownView, true, 'their own reservation should not block them');

      const other = await newAuthUser();
      const otherView = await t.asUser(other, async () => {
        const { rows } = await t.sql(`select username_available('first_name') as ok`);
        return rows[0].ok;
      });
      assert.equal(otherView, false, 'but it must block everyone else');
    });
  });

  it('is not executable by anon', async () => {
    for (const call of [`username_available('anything')`, `create_profile('anything')`]) {
      const err = await t.asAnon(() => t.errorFrom(`select ${call}`));
      assert.ok(err, `${call} should be refused for anon`);
      assert.equal(err.code, '42501', `${call} should be a privilege denial`);
    }
  });
});
