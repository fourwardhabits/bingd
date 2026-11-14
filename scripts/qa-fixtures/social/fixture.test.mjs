/**
 * Unit tests for the social QA fixture. No network: every run is against the in-memory fake
 * in fake-backend.mjs, injected through `main({ makeClient })` or `createContext({ client })`.
 *
 *   node --test "scripts/qa-fixtures/social/*.test.mjs"   (deliberately not an npm script: package.json scripts are a fingerprint input)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFakeBackend } from './fake-backend.mjs';
import {
  OwnershipError,
  createContext,
  derivePassword,
  main,
  parseArgs,
  runSetup,
  runTeardown,
  runVerify,
} from './fixture.mjs';
import { GuardError, assertEnvironmentAnswer, classifyTarget, guardTarget } from './guard.mjs';
import { createMutationLog } from './mutation-log.mjs';
import {
  FIXTURE_MARKER,
  PROTECTED_HANDLES,
  PlanError,
  buildPlan,
  expectedHelpfulCounts,
  expectedScores,
  operationId,
  uuidV5,
  validatePlan,
} from './plan.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const STAGING = 'https://fjxhcbowoxuzulwirzyr.supabase.co';
const PROD = 'https://abheeqyjzekiowkztfxv.supabase.co';
const SECRET = 'unit-test-fixture-secret-0123456789';
const ENV = Object.freeze({
  EXPO_PUBLIC_SUPABASE_URL: STAGING,
  EXPO_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-unit-test-AAAA',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-unit-test-BBBB',
  QA_FIXTURE_PASSWORD: SECRET,
});
const quiet = { log() {}, error() {} };

/** An env object that records which variables were read, in order. */
function recordingEnv(values) {
  const reads = [];
  const env = new Proxy(
    { ...values },
    {
      get(target, name) {
        if (typeof name === 'string') reads.push(name);
        return target[name];
      },
    },
  );
  return { env, reads };
}

function harness({ fake = createFakeBackend(), env = ENV } = {}) {
  const lines = [];
  const made = [];
  const deps = {
    env,
    out: quiet,
    logSink: (line) => lines.push(line),
    makeClient: (options) => {
      made.push(options);
      return fake;
    },
  };
  return { fake, lines, made, deps, run: (...argv) => main(argv, deps) };
}

function context(fake, { plan = buildPlan(), command = 'setup', dryRun = false } = {}) {
  const log = createMutationLog({ command, target: 'test', path: null, sink: () => {} });
  return createContext({
    plan,
    client: fake,
    log,
    command,
    dryRun,
    secret: SECRET,
    out: quiet,
  });
}

function seedQaAccounts(fake) {
  return {
    refine: fake.seedAccount({ email: 'qa-refine@example.com', username: 'qa_refine_g3' }),
    test2: fake.seedAccount({ email: 'bingdtest2@example.com', username: 'bingdtest2' }),
  };
}

// ---------------------------------------------------------------------------
describe('target guard', () => {
  it('refuses production by URL, over any scheme, port or path', () => {
    for (const url of [
      PROD,
      `${PROD}/`,
      `${PROD}/rest/v1`,
      'http://abheeqyjzekiowkztfxv.supabase.co',
      `${PROD}:443`,
      'HTTPS://ABHEEQYJZEKIOWKZTFXV.SUPABASE.CO',
    ]) {
      assert.throws(() => classifyTarget(url), GuardError, url);
      assert.throws(() => classifyTarget(url), /PRODUCTION/, url);
    }
  });

  it('refuses look-alike hosts that a string check would pass', () => {
    for (const url of [
      'https://fjxhcbowoxuzulwirzyr.supabase.co.evil.example',
      'https://evil.example/?x=fjxhcbowoxuzulwirzyr.supabase.co',
      'https://fjxhcbowoxuzulwirzyr.supabase.co@evil.example',
      'https://user:pw@fjxhcbowoxuzulwirzyr.supabase.co',
      'http://fjxhcbowoxuzulwirzyr.supabase.co',
      'https://fjxhcbowoxuzulwirzyr.supabase.co:8443',
      'https://xfjxhcbowoxuzulwirzyr.supabase.co',
    ]) {
      assert.throws(() => classifyTarget(url), GuardError, url);
    }
  });

  it('refuses unknown refs, other hosts, non-URLs and nothing', () => {
    for (const url of [
      'https://abcdefghijklmnopqrst.supabase.co',
      'https://example.com',
      'https://127.0.0.1:54321',
      'not a url',
      '',
      undefined,
      null,
    ]) {
      assert.throws(() => classifyTarget(url), GuardError, String(url));
    }
  });

  it('accepts staging exactly, and a local stack over http', () => {
    assert.deepEqual(classifyTarget(STAGING), {
      kind: 'staging',
      ref: 'fjxhcbowoxuzulwirzyr',
      origin: STAGING,
      host: 'fjxhcbowoxuzulwirzyr.supabase.co',
    });
    assert.equal(classifyTarget(`${STAGING}/`).kind, 'staging');
    assert.equal(classifyTarget('http://127.0.0.1:54321').kind, 'local');
    assert.equal(classifyTarget('http://localhost:54321').origin, 'http://localhost:54321');
  });

  it('refuses a database that answers prod, whatever the URL says', async () => {
    for (const url of [STAGING, 'http://127.0.0.1:54321']) {
      await assert.rejects(
        guardTarget(url, async () => 'prod'),
        /'prod'/,
      );
    }
    assert.throws(
      () => assertEnvironmentAnswer({ kind: 'staging', ref: 'x' }, 'prod'),
      GuardError,
    );
    await assert.rejects(
      guardTarget(STAGING, async () => null),
      GuardError,
    );
    await assert.rejects(
      guardTarget(STAGING, async () => 'staging'),
      GuardError,
    );
    await assert.rejects(
      guardTarget(STAGING, async () => {
        throw new Error('offline');
      }),
      GuardError,
    );
    const ok = await guardTarget(STAGING, async () => 'nonprod');
    assert.equal(ok.environment, 'nonprod');
    assert.equal(
      (await guardTarget('http://localhost:54321', async () => 'nonprod')).kind,
      'local',
    );
  });

  it('main refuses production before reading any key or building a client', async () => {
    const { env, reads } = recordingEnv({ ...ENV, EXPO_PUBLIC_SUPABASE_URL: PROD });
    const h = harness({ env });
    assert.equal(await h.run('setup'), 2);
    assert.equal(h.made.length, 0);
    assert.ok(!reads.includes('EXPO_PUBLIC_SUPABASE_ANON_KEY'));
    assert.ok(!reads.includes('SUPABASE_SERVICE_ROLE_KEY'));
    assert.ok(!reads.includes('QA_FIXTURE_PASSWORD'));
  });

  it('main refuses a prod-answering database before reading the service key', async () => {
    const { env, reads } = recordingEnv(ENV);
    const h = harness({ env, fake: createFakeBackend({ environment: 'prod' }) });
    assert.equal(await h.run('setup'), 2);
    assert.equal(h.made.length, 1, 'only the anon-key probe is built');
    assert.equal(h.made[0].serviceKey, undefined);
    assert.ok(!reads.includes('SUPABASE_SERVICE_ROLE_KEY'));
    assert.ok(!reads.includes('QA_FIXTURE_PASSWORD'));
    assert.equal(h.fake.writes.length, 0);
  });

  it('main refuses a look-alike host with exit 2', async () => {
    const h = harness({
      env: {
        ...ENV,
        EXPO_PUBLIC_SUPABASE_URL: 'https://fjxhcbowoxuzulwirzyr.supabase.co.evil.example',
      },
    });
    assert.equal(await h.run('verify'), 2);
    assert.equal(h.made.length, 0);
  });
});

// ---------------------------------------------------------------------------
describe('plan', () => {
  it('is deterministic: two builds are deep-equal', () => {
    assert.deepEqual(buildPlan(), buildPlan());
    assert.deepEqual(buildPlan({ linkQaAccounts: true }), buildPlan({ linkQaAccounts: true }));
  });

  it('has stable ids and stable operation ids', () => {
    const plan = buildPlan();
    const ids = plan.entries.map((e) => e.id);
    assert.ok(ids.includes('review:fx2:tmdb150540'));
    assert.ok(ids.includes('note:fx2:tmdb361743'));
    assert.equal(new Set(ids).size, ids.length);
    const review = plan.entries.find((e) => e.id === 'review:fx2:tmdb150540');
    // Pinned: if this changes, a half-finished staging run would replay as new operations.
    assert.equal(review.operationId, '61631067-510f-5cf8-8b35-43f2e6b7def4');
    assert.equal(operationId(1, 'review:fx2:tmdb150540', 'save_note'), review.operationId);
    assert.notEqual(operationId(2, 'review:fx2:tmdb150540', 'save_note'), review.operationId);
    assert.equal(
      uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'),
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
    for (const entry of plan.entries) {
      for (const value of [
        entry.operationId,
        ...Object.values(entry.operationIds ?? {}),
      ].filter(Boolean)) {
        assert.match(
          value,
          /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
      }
    }
  });

  it('uses fixed dates and fixture identities only', () => {
    const plan = buildPlan();
    assert.deepEqual(
      plan.accounts.map((a) => a.username),
      [
        'qa_fx_social_1',
        'qa_fx_social_2',
        'qa_fx_social_3',
        'qa_fx_social_4',
        'qa_fx_social_5',
      ],
    );
    for (const a of plan.accounts) {
      assert.match(a.username, /^[a-z0-9_]{3,24}$/);
      assert.equal(a.email, `${a.username}@example.invalid`);
    }
    assert.deepEqual(
      plan.accounts.map((a) => a.displayName),
      ['QA Fixture 1', 'QA Fixture 2', 'QA Fixture 3', 'QA Fixture 4', 'QA Fixture 5'],
    );
    assert.equal(buildPlan({ generation: 2 }).accounts[0].username, 'qa_fx_social_1_g2');
    for (const e of plan.entries.filter((x) => x.watchedOn))
      assert.match(e.watchedOn, /^2026-\d{2}-\d{2}$/);
  });

  it('references no QA account unless linking is on, and then only as a target', () => {
    const text = JSON.stringify(buildPlan());
    for (const handle of PROTECTED_HANDLES) assert.ok(!text.includes(handle), handle);
    const linked = buildPlan({ linkQaAccounts: true });
    const mentions = linked.entries.filter((e) =>
      JSON.stringify(e).match(/qa_refine_g3|bingdtest2/),
    );
    assert.ok(mentions.length > 0);
    for (const e of mentions) {
      assert.ok(e.link);
      assert.ok(['follow', 'recommend'].includes(e.type));
      assert.match(e.actor, /^fx[1-5]$/);
    }
  });

  it('covers the required scenarios', () => {
    const plan = buildPlan();
    const io = plan.entries.filter(
      (e) => e.type === 'note' && e.visibility === 'public' && e.title === 'tmdb150540',
    );
    assert.ok(io.length >= 3 && io.length <= 5);
    const scores = expectedScores(plan);
    const ioScores = io.map((e) => scores[e.actor]?.tmdb150540 ?? null);
    assert.equal(new Set(ioScores).size, ioScores.length, 'distinct scores on Inside Out');
    assert.ok(plan.entries.some((e) => e.type === 'note' && e.visibility === 'private'));
    assert.ok(plan.entries.some((e) => e.type === 'note' && e.spoilers));
    assert.ok(
      plan.entries.some(
        (e) =>
          e.type === 'note' &&
          e.visibility === 'public' &&
          scores[e.actor]?.[e.title] === undefined,
      ),
      'a review with a null score',
    );
    const counts = Object.values(expectedHelpfulCounts(plan));
    assert.ok(counts.includes(0) && counts.includes(1) && counts.some((n) => n >= 3));
    assert.ok(plan.entries.some((e) => e.type === 'recommend' && e.readState === 'unread'));
    assert.ok(plan.entries.some((e) => e.type === 'recommend' && e.readState !== 'unread'));
  });

  it('refuses entries that target QA or non-fixture accounts, and self-votes', () => {
    const base = buildPlan();
    const withEntry = (entry) => ({ ...base, entries: [...base.entries, entry] });
    assert.throws(
      () =>
        validatePlan(
          withEntry({
            id: 'x1',
            type: 'follow',
            actor: 'fx1',
            target: '@qa_refine_g3',
            operationId: 'a',
          }),
        ),
      PlanError,
    );
    assert.throws(
      () =>
        validatePlan(
          withEntry({
            id: 'x2',
            type: 'follow',
            actor: 'fx1',
            target: 'qa_refine_g3',
            operationId: 'b',
          }),
        ),
      PlanError,
    );
    assert.throws(
      () =>
        validatePlan(
          withEntry({
            id: 'x3',
            type: 'follow',
            link: true,
            actor: 'fx1',
            target: '@somebody_else',
            operationId: 'c',
          }),
        ),
      PlanError,
    );
    assert.throws(
      () =>
        validatePlan(
          withEntry({
            id: 'x4',
            type: 'helpful',
            actor: 'fx1',
            review: 'review:fx1:tmdb150540',
            operationId: 'd',
          }),
        ),
      /self-votes/,
    );
    assert.throws(
      () =>
        validatePlan(
          withEntry({
            id: 'x5',
            type: 'note',
            actor: '@bingdtest2',
            title: 'tmdb150540',
            operationId: 'e',
          }),
        ),
      PlanError,
    );
    assert.throws(
      () =>
        validatePlan(
          withEntry({
            id: 'x6',
            type: 'helpful',
            link: true,
            actor: 'fx1',
            review: 'review:fx2:tmdb150540',
            target: '@bingdtest2',
            operationId: 'f',
          }),
        ),
      PlanError,
    );
    assert.throws(
      () =>
        validatePlan({
          ...base,
          accounts: base.accounts.map((a, i) =>
            i === 0 ? { ...a, username: 'bingdtest2', email: 'bingdtest2@example.invalid' } : a,
          ),
        }),
      PlanError,
    );
  });
});

// ---------------------------------------------------------------------------
describe('ownership', () => {
  it('stops before any write when an unmarked account holds a fixture email', async () => {
    const fake = createFakeBackend();
    const stranger = fake.seedAccount({
      email: 'qa_fx_social_3@example.invalid',
      username: 'someone_real',
    });
    await assert.rejects(runSetup(context(fake)), OwnershipError);
    assert.equal(fake.writes.length, 0);
    assert.ok(fake.state.users.has(stranger));
    assert.equal(fake.state.profiles.get(stranger).username, 'someone_real');
  });

  it('stops when a marked account has the wrong username or the wrong password', async () => {
    const fake = createFakeBackend();
    fake.seedAccount({
      email: 'qa_fx_social_1@example.invalid',
      username: 'not_the_fixture',
      password: derivePassword(SECRET, 'qa_fx_social_1'),
      appMetadata: { qa_fixture: FIXTURE_MARKER },
    });
    await assert.rejects(runSetup(context(fake)), /not @qa_fx_social_1/);
    assert.equal(fake.writes.length, 0);

    const other = createFakeBackend();
    other.seedAccount({
      email: 'qa_fx_social_2@example.invalid',
      username: 'qa_fx_social_2',
      appMetadata: { qa_fixture: FIXTURE_MARKER },
    });
    await assert.rejects(runSetup(context(other)), /does not accept the password/);
    assert.equal(other.writes.length, 0);
  });

  it('a different marker value in app_metadata is not ours, even with user_metadata set', async () => {
    const fake = createFakeBackend();
    fake.seedAccount({
      email: 'qa_fx_social_4@example.invalid',
      username: 'qa_fx_social_4',
      password: derivePassword(SECRET, 'qa_fx_social_4'),
      appMetadata: { qa_fixture: 'something-else' },
      userMetadata: { qa_fixture: FIXTURE_MARKER },
    });
    await assert.rejects(runSetup(context(fake)), OwnershipError);
    assert.equal(fake.writes.length, 0);
  });

  it('a username held by a non-fixture account rolls back the new auth user and stops', async () => {
    const fake = createFakeBackend();
    const holder = fake.seedAccount({
      email: 'real-person@example.com',
      username: 'qa_fx_social_1',
    });
    await assert.rejects(runSetup(context(fake)), /taken or reserved/);
    assert.ok(fake.state.users.has(holder), 'the holder is untouched');
    assert.equal(fake.state.profiles.get(holder).username, 'qa_fx_social_1');
    const fixtureUsers = [...fake.state.users.values()].filter((u) =>
      u.email.endsWith('@example.invalid'),
    );
    assert.equal(fixtureUsers.length, 0, 'the just-created auth user was removed');
  });

  it('accepts the user_metadata marker when app_metadata is not writable', async () => {
    const fake = createFakeBackend({ appMetadataWritable: false });
    const ctx = context(fake);
    const result = await runSetup(ctx);
    assert.deepEqual(result.problems, []);
    const again = context(fake);
    await runSetup(again);
    assert.equal(again.writes, 0);
  });
});

// ---------------------------------------------------------------------------
describe('setup, verify, re-run', () => {
  it('sets up, verifies from every point of view, and a second setup writes nothing', async () => {
    const fake = createFakeBackend();
    const first = context(fake);
    const result = await runSetup(first);
    assert.deepEqual(result.problems, []);
    assert.ok(first.writes > 40);

    const verify = context(fake, { command: 'verify' });
    const before = fake.writes.length;
    const checked = await runVerify(verify);
    assert.deepEqual(checked.problems, []);
    assert.ok(checked.checks.length > 200);
    assert.equal(fake.writes.length, before, 'verify writes nothing');

    const second = context(fake);
    await runSetup(second);
    assert.equal(second.writes, 0);
    assert.equal(fake.writes.length, before, 'second setup makes zero writes');
    assert.deepEqual(second.problems, []);
  });

  it('builds the scenario the plan describes', async () => {
    const fake = createFakeBackend();
    await runSetup(context(fake));
    const { follows, recs, votes } = fake.state;
    const id = (n) =>
      [...fake.state.profiles.values()].find((p) => p.username === `qa_fx_social_${n}`).id;
    assert.equal(follows.get(`${id(1)}>${id(2)}`), 'approved');
    assert.equal(follows.get(`${id(2)}>${id(1)}`), 'approved');
    assert.equal(follows.get(`${id(4)}>${id(1)}`), 'approved');
    assert.equal(follows.get(`${id(1)}>${id(4)}`), undefined);
    assert.equal(follows.get(`${id(3)}>${id(5)}`), 'approved');
    assert.equal(follows.get(`${id(4)}>${id(5)}`), 'pending');
    assert.equal(recs.filter((r) => r.state === 'pending').length, 2);
    assert.equal(recs.filter((r) => r.opened_at).length, 1);
    assert.equal(recs.filter((r) => r.seen_at && !r.opened_at).length, 1);
    assert.equal(votes.size, 6);
  });

  it('verify exits non-zero on drift', async () => {
    const h = harness();
    assert.equal(await h.run('setup'), 0);
    assert.equal(await h.run('verify'), 0);
    // Somebody takes a Helpful back by hand.
    h.fake.state.votes.delete([...h.fake.state.votes][0]);
    assert.equal(await h.run('verify'), 1);
  });

  it('a missing title is logged and its entries skipped, and the rest still verifies', async () => {
    const fake = createFakeBackend({
      media: [
        { tmdb_id: 150540, title: 'Inside Out' },
        { tmdb_id: 361743, title: 'Top Gun: Maverick' },
      ],
    });
    const lines = [];
    const log = createMutationLog({
      command: 'setup',
      target: 'test',
      path: null,
      sink: (l) => lines.push(l),
    });
    const ctx = createContext({
      plan: buildPlan(),
      client: fake,
      log,
      command: 'setup',
      secret: SECRET,
      out: quiet,
    });
    const result = await runSetup(ctx);
    assert.deepEqual(result.problems, []);
    assert.ok(result.skipped.includes('review:fx2:tmdb2062'));
    assert.ok(result.skipped.includes('helpful:fx1>review:fx2:tmdb2062'));
    assert.ok(lines.some((l) => JSON.parse(l).result === 'missing'));
    const verify = await runVerify(context(fake, { command: 'verify' }));
    assert.deepEqual(verify.problems, []);
  });

  it('registers no device token, so nothing can be pushed to a fixture account', async () => {
    const fake = createFakeBackend();
    await runSetup(context(fake));
    assert.equal(fake.deviceTokens.length, 0);
    for (const file of ['fixture.mjs', 'client.mjs', 'plan.mjs']) {
      const source = readFileSync(join(here, file), 'utf8');
      assert.ok(!source.includes('register_device_token'), file);
      assert.ok(!source.includes('report_device_context'), file);
    }
  });
});

// ---------------------------------------------------------------------------
describe('QA account links', () => {
  it('with linking off, no QA account receives or loses anything', async () => {
    const fake = createFakeBackend();
    const qa = seedQaAccounts(fake);
    await runSetup(context(fake));
    for (const qaId of Object.values(qa)) {
      assert.equal(fake.notifications.filter((n) => n.recipient === qaId).length, 0);
      assert.equal([...fake.state.follows.keys()].filter((k) => k.includes(qaId)).length, 0);
      assert.equal(
        fake.state.recs.filter((r) => r.recipient === qaId || r.sender === qaId).length,
        0,
      );
      assert.equal(fake.writes.filter((w) => w.actor === qaId).length, 0);
    }
  });

  it('with linking on, fixtures follow and recommend to QA accounts, and never act as them', async () => {
    const fake = createFakeBackend();
    const qa = seedQaAccounts(fake);
    const plan = buildPlan({ linkQaAccounts: true });
    const ctx = context(fake, { plan });
    const result = await runSetup(ctx);
    assert.deepEqual(result.problems, []);
    for (const qaId of Object.values(qa)) {
      assert.equal(
        fake.writes.filter((w) => w.actor === qaId).length,
        0,
        'never writes as a QA account',
      );
      assert.equal(
        [...fake.state.follows.keys()].filter((k) => k.startsWith(`${qaId}>`)).length,
        0,
        'never edits their follows',
      );
      assert.equal(
        [...fake.state.follows.keys()].filter((k) => k.endsWith(`>${qaId}`)).length,
        2,
      );
      assert.equal(fake.state.rankings.get(qaId), undefined, 'never ranks as them');
      const toQa = fake.state.recs.filter((r) => r.recipient === qaId);
      assert.equal(toQa.length, 1);
      assert.equal(
        toQa[0].state,
        'pending',
        'a QA account that does not follow back gets a request, not a delivery',
      );
      // What a QA tester sees: two follow notifications, no recommendation notification.
      assert.deepEqual(
        fake.notifications.filter((n) => n.recipient === qaId).map((n) => n.type),
        ['follow', 'follow'],
      );
    }
    const verify = await runVerify(context(fake, { plan, command: 'verify' }));
    assert.deepEqual(verify.problems, []);
    const again = context(fake, { plan });
    await runSetup(again);
    assert.equal(again.writes, 0);
  });

  it('teardown with linking refuses the flag; deleting fixtures removes the links', async () => {
    assert.throws(
      () => parseArgs(['teardown', '--link-qa-accounts']),
      /never touches QA accounts/,
    );
    const fake = createFakeBackend();
    const qa = seedQaAccounts(fake);
    await runSetup(context(fake, { plan: buildPlan({ linkQaAccounts: true }) }));
    await runTeardown(context(fake, { command: 'teardown' }));
    for (const qaId of Object.values(qa)) {
      assert.ok(fake.state.users.has(qaId));
      assert.equal([...fake.state.follows.keys()].filter((k) => k.includes(qaId)).length, 0);
    }
  });
});

// ---------------------------------------------------------------------------
describe('teardown', () => {
  it('deletes only marked fixture accounts; look-alikes and QA accounts survive', async () => {
    const fake = createFakeBackend();
    const qa = seedQaAccounts(fake);
    const lookalikes = [
      fake.seedAccount({ email: 'qa_fx_social_6@example.invalid', username: 'qa_fx_social_6' }),
      fake.seedAccount({
        email: 'qa_fx_social_1@example.invalid.evil',
        username: 'qa_fx_social_1x',
      }),
      fake.seedAccount({
        email: 'qa_fx_social_7@example.invalid',
        username: 'qa_fx_social_7',
        userMetadata: { qa_fixture: 'social-v0' },
      }),
    ];
    await runSetup(context(fake));
    const ctx = context(fake, { command: 'teardown' });
    // The marked-users scan would also find nothing marked among the survivors.
    const result = await runTeardown(ctx);
    assert.deepEqual(result.problems, []);
    for (const id of [...Object.values(qa), ...lookalikes]) {
      assert.ok(fake.state.users.has(id), id);
      assert.ok(fake.state.profiles.has(id), id);
    }
    const deletes = fake.writes.filter(
      (w) => w.name === 'delete_account' || w.name === 'admin.delete_user',
    );
    assert.equal(deletes.length, 5);
    for (const d of deletes)
      assert.ok(
        ![...Object.values(qa), ...lookalikes].includes(d.actor) &&
          ![...Object.values(qa), ...lookalikes].includes(d.target),
      );
    assert.equal(
      [...fake.state.users.values()].filter(
        (u) => u.app_metadata?.qa_fixture === FIXTURE_MARKER,
      ).length,
      0,
    );
  });

  it('refuses, deleting nothing, when an unmarked account holds a fixture email', async () => {
    const fake = createFakeBackend();
    await runSetup(context(fake));
    const before = fake.state.users.size;
    // A real person's account turns up at fx4's address (the fixture's fx4 is removed first).
    const fx4 = [...fake.state.users.values()].find(
      (u) => u.email === 'qa_fx_social_4@example.invalid',
    );
    fake.state.users.delete(fx4.id);
    fake.seedAccount({ email: 'qa_fx_social_4@example.invalid', username: 'real_person' });
    const deletesBefore = fake.writes.filter((w) => /delete/.test(w.name)).length;
    await assert.rejects(runTeardown(context(fake, { command: 'teardown' })), OwnershipError);
    assert.equal(fake.writes.filter((w) => /delete/.test(w.name)).length, deletesBefore);
    assert.equal(fake.state.users.size, before);
  });

  it('admin-deletes a marked auth user that never got a profile', async () => {
    const fake = createFakeBackend();
    const orphan = fake.seedAccount({
      email: 'qa_fx_social_5@example.invalid',
      password: derivePassword(SECRET, 'qa_fx_social_5'),
      appMetadata: { qa_fixture: FIXTURE_MARKER },
    });
    const result = await runTeardown(context(fake, { command: 'teardown' }));
    assert.deepEqual(result.problems, []);
    assert.ok(!fake.state.users.has(orphan));
    assert.deepEqual(
      fake.writes.map((w) => w.name),
      ['admin.delete_user'],
    );
  });

  it('usernames stay reserved after teardown: generation 1 refuses, generation 2 works', async () => {
    const fake = createFakeBackend();
    await runSetup(context(fake));
    await runTeardown(context(fake, { command: 'teardown' }));
    await assert.rejects(runSetup(context(fake)), /taken or reserved/);
    assert.equal(
      [...fake.state.users.values()].length,
      0,
      'the refused attempt left nothing behind',
    );
    const g2 = await runSetup(context(fake, { plan: buildPlan({ generation: 2 }) }));
    assert.deepEqual(g2.problems, []);
    assert.deepEqual(
      (
        await runVerify(
          context(fake, { plan: buildPlan({ generation: 2 }), command: 'verify' }),
        )
      ).problems,
      [],
    );
  });
});

// ---------------------------------------------------------------------------
describe('dry run', () => {
  it('needs no keys, builds no client and writes nothing', async () => {
    const { env, reads } = recordingEnv({});
    const h = harness({ env });
    assert.equal(await h.run('setup', '--dry-run'), 0);
    assert.equal(h.made.length, 0);
    assert.equal(h.fake.writes.length + h.fake.calls.length, 0);
    assert.ok(!reads.some((name) => /KEY|PASSWORD/.test(name)));
    const results = h.lines.map((l) => JSON.parse(l).result);
    assert.ok(results.length > 40);
    assert.ok(results.every((r) => r === 'dry_run' || r === 'skipped_missing_title'));
    assert.equal(await h.run('teardown', '--dry-run'), 0);
    assert.equal(h.fake.writes.length, 0);
  });

  it('still refuses production by URL', async () => {
    const h = harness({ env: { EXPO_PUBLIC_SUPABASE_URL: PROD } });
    assert.equal(await h.run('setup', '--dry-run'), 2);
    assert.equal(h.lines.length, 0);
  });

  it('a dry-run context against a live client writes nothing', async () => {
    const fake = createFakeBackend();
    await runSetup(context(fake, { dryRun: true }));
    assert.equal(fake.writes.length, 0);
  });
});

// ---------------------------------------------------------------------------
describe('mutation log', () => {
  it('records every write with the required fields and no secret values', async () => {
    const h = harness();
    assert.equal(await h.run('setup'), 0);
    assert.equal(await h.run('verify'), 0);
    assert.equal(await h.run('teardown'), 0);

    const secrets = [
      ENV.EXPO_PUBLIC_SUPABASE_ANON_KEY,
      ENV.SUPABASE_SERVICE_ROLE_KEY,
      SECRET,
      ...buildPlan().accounts.map((a) => derivePassword(SECRET, a.username)),
    ];
    const tokenish = /eyJfake\.|Bearer|access_token|password/i;
    assert.ok(h.lines.length >= 69 + 5);
    for (const line of h.lines) {
      for (const secret of secrets)
        assert.ok(!line.includes(secret), 'a secret reached the log');
      assert.doesNotMatch(line, tokenish);
      const entry = JSON.parse(line);
      for (const field of [
        'time',
        'command',
        'target',
        'actor',
        'operation',
        'entity',
        'result',
      ]) {
        assert.ok(entry[field] !== undefined, `${field} missing in ${line}`);
      }
      assert.equal(entry.target, 'fjxhcbowoxuzulwirzyr');
    }
    const writes = h.lines
      .map((l) => JSON.parse(l))
      .filter((e) => e.command === 'setup' && e.result !== 'problem');
    assert.equal(
      writes.length,
      h.fake.writes.filter((w) => w.name !== 'delete_account' && w.name !== 'admin.delete_user')
        .length,
    );
  });

  it('redacts a secret that reaches a detail field', () => {
    const lines = [];
    const log = createMutationLog({
      command: 'setup',
      target: 't',
      sink: (l) => lines.push(l),
      secrets: () => ['super-secret-value'],
    });
    log.record({
      actor: 'a',
      operation: 'o',
      entity: 'e',
      result: 'error',
      detail: 'failed with super-secret-value inside',
    });
    assert.ok(!lines[0].includes('super-secret-value'));
    assert.match(lines[0], /\[redacted\]/);
  });

  it('derives passwords deterministically and refuses a short secret', () => {
    assert.equal(
      derivePassword(SECRET, 'qa_fx_social_1'),
      derivePassword(SECRET, 'qa_fx_social_1'),
    );
    assert.notEqual(
      derivePassword(SECRET, 'qa_fx_social_1'),
      derivePassword(SECRET, 'qa_fx_social_2'),
    );
    assert.ok(!derivePassword(SECRET, 'qa_fx_social_1').includes(SECRET));
    assert.throws(() => derivePassword('short', 'qa_fx_social_1'));
    assert.throws(() => derivePassword(undefined, 'qa_fx_social_1'));
  });
});

describe('arguments', () => {
  it('parses the documented flags and refuses the rest', () => {
    assert.deepEqual(
      parseArgs(['setup', '--dry-run', '--log', '/tmp/x.jsonl', '--link-qa-accounts']),
      {
        command: 'setup',
        dryRun: true,
        logPath: '/tmp/x.jsonl',
        linkQaAccounts: true,
        generation: 1,
        help: false,
      },
    );
    assert.equal(parseArgs(['teardown', '--generation', '3']).generation, 3);
    assert.throws(() => parseArgs(['seed']));
    assert.throws(() => parseArgs(['setup', '--force']));
    assert.throws(() => parseArgs(['verify', '--dry-run']));
  });
});
