import {
  lastRouteSeen,
  logicalName,
  note,
  recordRequest,
  rememberRoute,
  resetFlightRecorder,
  snapshot,
  tailForPersistence,
  tally,
  timed,
  withoutRecording,
} from './flight-recorder';

/**
 * The flight recorder, and the two properties it lives or dies by.
 *
 * **It must distinguish the four ways a screen fails to load.** Three tranches have been
 * spent arguing about which one the founder's phone was doing, from a desktop, without
 * evidence. The distinction that settles it is `reachedFetch`: a request opened before the
 * session wait and never sent is a stall *upstream of the network*, and it looks identical
 * from the outside to a query that was never made.
 *
 * **And it must never carry anything private.** The whole point is that the founder pastes
 * this into a chat, so every field is either a schema name or a number.
 */

beforeEach(resetFlightRecorder);

describe('logicalName', () => {
  /**
   * The redaction test, written as the URL that would hurt: a real handle in a filter, a
   * bearer token in the query string, and a search term. All three are downstream of the
   * `?` and none of them survives.
   */
  it('keeps the table and drops everything that identifies anybody', () => {
    const name = logicalName(
      'https://abheeqyjzekiowkztfxv.supabase.co/rest/v1/profiles?select=id&username=eq.fourward_test&apikey=eyJhbGciOi',
    );

    expect(name).toBe('rest:profiles');
    expect(name).not.toContain('fourward_test');
    expect(name).not.toContain('eyJhbGciOi');
  });

  it('names an RPC by its function, which is schema', () => {
    expect(logicalName('https://x.supabase.co/rest/v1/rpc/profile_identity')).toBe(
      'rpc:profile_identity',
    );
  });

  it('names the auth endpoint, which is what says a refresh is happening', () => {
    expect(logicalName('https://x.supabase.co/auth/v1/token?grant_type=refresh_token')).toBe(
      'auth:token',
    );
    expect(logicalName('https://x.supabase.co/auth/v1/logout')).toBe('auth:logout');
  });

  /** An avatar path carries an account id, so storage is collapsed rather than split. */
  it('collapses storage, because the path is an account', () => {
    expect(
      logicalName('https://x.supabase.co/storage/v1/object/avatars/13b51cfb-bc61-4b8b.jpg'),
    ).toBe('storage:object');
  });
});

describe('the four ways a request can fail', () => {
  /**
   * **BLOCKED — the finding.** Opened, never sent. On the device this means the request
   * never got past `auth.getSession()`, which is upstream of the network and invisible to
   * every backend health check.
   */
  it('shows a request that never reached fetch as started but unsent', () => {
    recordRequest('https://x.supabase.co/rest/v1/rankings');

    const record = snapshot().network[0]!;
    expect(record.name).toBe('rest:rankings');
    expect(record.reachedFetch).toBe(false);
    expect(record.endedAt).toBeUndefined();
  });

  it('shows a request that left and did not come back', () => {
    recordRequest('https://x.supabase.co/rest/v1/rankings').sent();

    const record = snapshot().network[0]!;
    expect(record.reachedFetch).toBe(true);
    expect(record.endedAt).toBeUndefined();
  });

  it('shows a request that was answered, with its status', () => {
    const handle = recordRequest('https://x.supabase.co/rest/v1/rankings');
    handle.sent();
    handle.settled({ status: 200 });

    const record = snapshot().network[0]!;
    expect(record.status).toBe(200);
    expect(record.endedAt).toBeDefined();
  });

  /** The class name, never the message: a PostgREST message can echo rejected input. */
  it('records a failure by class and not by message', () => {
    class RequestDeadlineError extends Error {
      override readonly name = 'RequestDeadlineError';
    }
    const handle = recordRequest('https://x.supabase.co/rest/v1/rankings');
    handle.sent();
    handle.settled({ error: new RequestDeadlineError('value "fourward_test" is invalid') });

    const record = snapshot().network[0]!;
    expect(record.errorClass).toBe('RequestDeadlineError');
    expect(JSON.stringify(record)).not.toContain('fourward_test');
  });
});

describe('bounds', () => {
  /** A ring buffer, because an app left open for an hour must not grow a log. */
  it('keeps only the most recent network records', () => {
    for (let i = 0; i < 45; i += 1) recordRequest('https://x.supabase.co/rest/v1/rankings');

    const { network } = snapshot();
    expect(network.length).toBe(30);
    // The oldest were dropped, not the newest.
    expect(network[network.length - 1]!.seq).toBeGreaterThan(network[0]!.seq);
  });

  it('keeps only the most recent events', () => {
    for (let i = 0; i < 120; i += 1) note('route', `step-${i}`);
    expect(snapshot().events.length).toBe(80);
  });

  /**
   * The repeat counter is the thermal answer: identical work happening over and over is a
   * number here rather than something to be inferred from a screenshot.
   */
  it('counts how many times the same operation has been started', () => {
    for (let i = 0; i < 4; i += 1) recordRequest('https://x.supabase.co/rest/v1/rankings');
    recordRequest('https://x.supabase.co/rest/v1/follows');

    const byName = Object.fromEntries(snapshot().network.map((r) => [r.name, r.repeat]));
    expect(byName['rest:rankings']).toBe(3);
    expect(byName['rest:follows']).toBe(0);
  });
});

describe('events and counters', () => {
  it('records a channel, a label and an optional detail', () => {
    note('signout', 'signOut.supabase', 'timeout', 2000);

    const [event] = snapshot().events;
    expect(event).toMatchObject({
      channel: 'signout',
      label: 'signOut.supabase',
      detail: 'timeout',
      ms: 2000,
    });
  });

  it('tallies repeated things', () => {
    tally('auth.callbacks');
    tally('auth.callbacks');
    expect(snapshot().counters['auth.callbacks']).toBe(2);
  });

  it('times work without changing what it returns', async () => {
    await expect(timed('auth', 'hydrate', Promise.resolve('value'))).resolves.toBe('value');
    expect(snapshot().events.at(-1)).toMatchObject({ label: 'hydrate', detail: 'ok' });
  });

  it('times work that throws, and still throws it', async () => {
    await expect(timed('auth', 'hydrate', Promise.reject(new TypeError('x')))).rejects.toThrow(
      TypeError,
    );
    expect(snapshot().events.at(-1)).toMatchObject({ label: 'hydrate', detail: 'TypeError' });
  });
});

describe('the tail kept for the next launch', () => {
  it('carries the last route and whatever was still unfinished', () => {
    recordRequest('https://x.supabase.co/rest/v1/rankings').sent();
    const answered = recordRequest('https://x.supabase.co/rest/v1/follows');
    answered.sent();
    answered.settled({ status: 200 });
    rememberRoute('onboarding/taste');

    const tail = tailForPersistence(lastRouteSeen());

    expect(tail.route).toBe('onboarding/taste');
    expect(tail.pending).toEqual(['rest:rankings']);
  });

  it('is small enough to hand to the Keychain once', () => {
    for (let i = 0; i < 200; i += 1) note('route', `step-${i}`, 'stay:ready');
    expect(tailForPersistence('feed').events.length).toBe(12);
  });
});

describe('the snapshot', () => {
  /** The sheet must not be handed live arrays it could mutate or watch. */
  it('is a copy, so the sheet cannot hold the recorder open', () => {
    recordRequest('https://x.supabase.co/rest/v1/rankings');
    const first = snapshot();
    recordRequest('https://x.supabase.co/rest/v1/follows');

    expect(first.network.length).toBe(1);
    expect(snapshot().network.length).toBe(2);
  });
});

describe('the sheet reading its own evidence', () => {
  /**
   * **Independent review 51's third finding.** Building the report asks for the session and
   * the two onboarding counts, and those are ordinary Supabase requests. Unsuppressed, they
   * entered this same thirty-record ring, bumped the same repeat counters, and on a busy
   * session could evict the records carrying the failure — a report that pushes the failure
   * out of its own buffer.
   */
  it('records nothing while the report is being built', async () => {
    recordRequest('https://x.supabase.co/rest/v1/rankings');

    await withoutRecording(async () => {
      recordRequest('https://x.supabase.co/rest/v1/rankings');
      recordRequest('https://x.supabase.co/rest/v1/user_media');
      note('auth', 'hydrate', 'ok', 5);
      tally('auth.callbacks');
    });

    const after = snapshot();
    expect(after.network.length).toBe(1);
    expect(after.events.length).toBe(0);
    expect(after.counters['auth.callbacks']).toBeUndefined();
  });

  it('starts recording again afterwards, and counts nothing it skipped', async () => {
    await withoutRecording(async () => {
      recordRequest('https://x.supabase.co/rest/v1/rankings');
    });
    recordRequest('https://x.supabase.co/rest/v1/rankings');

    const [record] = snapshot().network;
    // Zero, not one: the suppressed request must not inflate the repeat counter either.
    expect(record!.repeat).toBe(0);
  });

  it('restores recording even when the work throws', async () => {
    await expect(
      withoutRecording(async () => {
        throw new TypeError('boom');
      }),
    ).rejects.toThrow(TypeError);

    recordRequest('https://x.supabase.co/rest/v1/rankings');
    expect(snapshot().network.length).toBe(1);
  });
});

/**
 * **The lane the title-search blocker needed and did not have.**
 *
 * The founder's wider search failed and the report could not say a word about it: the
 * `tmdb-adapter` Edge Function is the only call in the app that is not PostgREST, and it
 * fell through `logicalName` to `other`. So a report showed the catalogue read succeeding
 * beside an anonymous entry, and the question — did the request leave the client, how long
 * did it take, what came back — had no answer anywhere.
 */
describe('the Edge Function lane', () => {
  it('names the function it called', () => {
    expect(logicalName('https://x.supabase.co/functions/v1/tmdb-adapter')).toBe(
      'fn:tmdb-adapter',
    );
  });

  it('keeps a query string out of the name, like every other lane', () => {
    // A function URL can carry `forceFunctionRegion`, and a future one could carry more.
    // The rule is the same rule: everything after `?` is dropped before anything else.
    expect(
      logicalName('https://x.supabase.co/functions/v1/tmdb-adapter?forceFunctionRegion=us-east-1'),
    ).toBe('fn:tmdb-adapter');
  });

  it('still falls back to `other` for a URL that is none of the four lanes', () => {
    expect(logicalName('https://x.supabase.co/something-else')).toBe('other');
  });
});
