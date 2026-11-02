import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb, migrationFiles } from './harness.mjs';

/**
 * Proactive notifications arrive after the security release, and cannot undo it.
 *
 * `20261024000300` gives push and the inbox one rule: a comment's text reaches only somebody
 * who could open that comment now. The proactive migrations rebuild both functions from
 * older bodies, and drop `claim_push_batch(integer)` for a two-argument version, so the rule
 * survives only if `20261101000100` restores it and nothing after that removes it.
 *
 * `comment-excerpt-access.test.mjs` proves the behaviour. This file proves the order, which
 * that one cannot see: run the other way round, `20261024000300` would recreate the
 * one-argument overload beside the proactive function.
 */

const RULE = '_can_read_comment';

let t;

before(async () => {
  t = await createTestDb();
});

after(() => t.close());

describe('the order of the migrations', () => {
  it('runs all five security files before any proactive one', async () => {
    const files = await migrationFiles();
    const security = files.filter((f) => f.startsWith('20261024'));
    const proactive = files.filter((f) => /^(20261028|20261031)/.test(f));

    assert.equal(security.length, 5, 'the security release is five files');
    assert.ok(proactive.length >= 3, 'the scan found no proactive migrations');
    assert.ok(security.at(-1) < proactive[0], `${security.at(-1)} must run before ${proactive[0]}`);
  });
});

describe('what is left when every migration has run', () => {
  const definitions = async (name) =>
    (await t.sql(
      `select pg_get_functiondef(p.oid) as body, p.oid::regprocedure::text as signature
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1`,
      [name],
    )).rows;

  it('leaves one claim_push_batch, which keeps the rule', async () => {
    const rows = await definitions('claim_push_batch');
    assert.deepEqual(rows.map((r) => r.signature), ['claim_push_batch(integer,timestamp with time zone)']);
    assert.ok(rows[0].body.includes(RULE), 'the claim sends text without asking who can read it');
  });

  it('leaves one my_notifications, which keeps the rule', async () => {
    const rows = await definitions('my_notifications');
    assert.equal(rows.length, 1);
    assert.ok(rows[0].body.includes(RULE), 'the inbox shows text without asking who can read it');
  });

  it('keeps the rule asking about the activity owner as well as the comment author', async () => {
    const [rule] = await definitions(RULE);
    assert.ok(rule.body.includes('feed_events'), 'the rule has stopped reading the activity');
    assert.ok(rule.body.includes('can_view_profile'), 'the rule has stopped asking about access');
  });

  it('keeps the consent fix beside the proactive functions', async () => {
    const [accept] = await definitions('accept_invite');
    assert.ok(accept, 'accept_invite is gone');
    const [redeem] = await definitions('redeem_invite');
    assert.ok(redeem.body.includes('22023'), 'redeem_invite is live again, which reopens B-1');
    assert.equal((await definitions('_redeem_invite')).length, 0);
  });
});
