import type { Query } from '@tanstack/react-query';

import {
  note,
  recordRequest,
  resetFlightRecorder,
  snapshot,
  tally,
  type NetworkRecord,
} from './flight-recorder';
import {
  formatReport,
  phaseOf,
  queryFacts,
  quiescence,
  type ReportInput,
} from './flight-report';

/**
 * The report the founder pastes into a chat, and the audit of what may be in it.
 *
 * Every test below that looks paranoid is one: this text leaves the device and lands
 * somewhere it cannot be recalled, so the standard is not "we did not mean to include it"
 * but "the value was never in scope at the point the string was built".
 */

beforeEach(resetFlightRecorder);

/** A query key of the shape this app really uses: a name, then ids. */
const fakeQuery = (key: readonly unknown[], state: Partial<Query['state']>): Query =>
  ({
    queryKey: key,
    state: {
      status: 'pending',
      fetchStatus: 'idle',
      fetchFailureCount: 0,
      dataUpdatedAt: 0,
      data: undefined,
      ...state,
    },
  }) as unknown as Query;

const baseInput = (): ReportInput => ({
  release: {
    appVersion: '0.1.0',
    buildNumber: '4',
    runtimeVersion: 'd3b308f7',
    updateId: '01a03fc3',
    channel: 'beta',
    embedded: false,
    commit: null,
    launchedAtIso: '2026-08-26T23:00:00.000Z',
  },
  auth: { sessionExists: true, expiresInSeconds: 2400, hydrationMs: 42, authCallbacks: 2 },
  onboarding: {
    storedPhase: 'disk=active memory=absent',
    derivedNeeded: 'YES (of 5)',
    ranked: 5,
    logged: 5,
  },
  route: 'onboarding/taste',
  appState: 'active',
  flight: snapshot(),
  queries: [],
  lastSession: null,
});

describe('what the report may never contain', () => {
  /**
   * The whole audit in one test: a session's worth of realistic traffic, every piece of it
   * carrying something that must not travel, and then a search of the finished string.
   */
  it('carries no token, handle, search term, note or error message', () => {
    const handle = recordRequest(
      'https://x.supabase.co/rest/v1/profiles?select=id,bio&username=eq.fourward_test',
    );
    handle.sent();
    handle.settled({
      error: Object.assign(new Error('value "a private note about a film" violates check'), {
        name: 'PostgrestError',
      }),
    });
    recordRequest('https://x.supabase.co/rest/v1/rpc/search_titles?q=something+embarrassing');
    recordRequest('https://x.supabase.co/storage/v1/object/avatars/13b51cfb-bc61-4b8b.jpg');
    recordRequest('https://x.supabase.co/auth/v1/token?grant_type=refresh_token').sent();

    const report = formatReport({
      ...baseInput(),
      flight: snapshot(),
      queries: queryFacts(
        [
          fakeQuery(['my-profile', '13b51cfb-bc61-4b8b-a3e1-4e3c544e3cbf'], {}),
          fakeQuery(['log-state', '13b51cfb', 'media-id-9'], {}),
        ],
        Date.now(),
      ),
    });

    for (const secret of [
      'fourward_test',
      'a private note about a film',
      'something embarrassing',
      '13b51cfb',
      'grant_type=refresh_token',
      'eq.',
      'Bearer',
    ]) {
      expect(report).not.toContain(secret);
    }
  });

  /**
   * A query key is `[name, userId, ...]`. The name is schema and stays; everything after it
   * is an identifier and is replaced by how many there were, which is enough to tell two
   * keys apart without naming anybody.
   */
  it('reduces query key identifiers to a count', () => {
    // Sorted by name, so `log-state` comes first.
    const [logState, profile] = queryFacts(
      [
        fakeQuery(['my-profile', '13b51cfb-bc61-4b8b-a3e1-4e3c544e3cbf'], {}),
        fakeQuery(['log-state', '13b51cfb', 'media-id-9'], {}),
      ],
      Date.now(),
    );

    expect(logState).toMatchObject({ name: 'log-state', keyParts: 2 });
    expect(profile).toMatchObject({ name: 'my-profile', keyParts: 1 });
    expect(JSON.stringify([profile, logState])).not.toContain('13b51cfb');
  });

  /**
   * The access token's *expiry* is a number of seconds and explains a refresh storm; the
   * token is a credential and explains nothing. Only the first is a field at all.
   */
  it('reports when the session expires and never what it is', () => {
    const report = formatReport(baseInput());
    expect(report).toContain('expires in   2400s');
    expect(report).not.toMatch(/eyJ[A-Za-z0-9_-]/);
  });
});

describe('the boundary the whole exercise turns on', () => {
  it('calls an unsent request BLOCKED and a sent one PENDING', () => {
    recordRequest('https://x.supabase.co/rest/v1/rankings');
    const sent = recordRequest('https://x.supabase.co/rest/v1/follows');
    sent.sent();

    const [blocked, pending] = snapshot().network as [NetworkRecord, NetworkRecord];
    expect(phaseOf(blocked)).toBe('BLOCKED');
    expect(phaseOf(pending)).toBe('PENDING');
  });

  it('separates answered from failed', () => {
    const ok = recordRequest('https://x.supabase.co/rest/v1/rankings');
    ok.sent();
    ok.settled({ status: 200 });
    const bad = recordRequest('https://x.supabase.co/rest/v1/follows');
    bad.sent();
    bad.settled({ error: new TypeError('network') });

    const [answered, failed] = snapshot().network as [NetworkRecord, NetworkRecord];
    expect(phaseOf(answered)).toBe('ANSWERED');
    expect(phaseOf(failed)).toBe('FAILED');
  });

  /**
   * **Never started** is the one the network log cannot show on its own, and does not have
   * to: React Query says `pending`/`idle` for a query whose function has not run, and
   * `pending`/`fetching` for one that is out. Read beside an empty network log, the first
   * is unambiguous.
   */
  it('shows a query that never ran as pending and idle', () => {
    const [facts] = queryFacts(
      [fakeQuery(['collection', 'u'], { status: 'pending', fetchStatus: 'idle' })],
      Date.now(),
    );
    expect(facts).toMatchObject({ status: 'pending', fetchStatus: 'idle', hasData: false });
  });
});

describe('the finished text', () => {
  it('has a section for every question the device has been asked', () => {
    note('signout', 'signOut.supabase', 'timeout', 2000);
    note('onboarding', 'read', 'active(disk)');
    tally('auth.callbacks', 3);

    const report = formatReport({ ...baseInput(), flight: snapshot() });

    for (const heading of [
      'RELEASE',
      'AUTH',
      'ONBOARDING',
      'APP',
      'NETWORK',
      'QUERIES',
      'EVENTS',
      'COUNTS',
    ]) {
      expect(report).toContain(heading);
    }
    expect(report).toContain('signOut.supabase');
    expect(report).toContain('active(disk)');
  });

  it('says plainly that the previous session is not a crash report', () => {
    const report = formatReport({
      ...baseInput(),
      lastSession: {
        endedAtIso: '2026-08-26T22:00:00.000Z',
        uptimeMs: 90_000,
        route: 'onboarding/taste',
        events: [],
        pending: ['rest:rankings'],
      },
    });

    expect(report).toContain('PREVIOUS SESSION ENDED WITH');
    expect(report).toContain('rest:rankings');
    expect(report).toContain('not that anything crashed');
  });

  it('renders empty sections rather than omitting them', () => {
    const report = formatReport(baseInput());
    expect(report).toContain('(none)');
  });
});

/**
 * **Quiescence: the founder's thermal blocker turned into something a report can state.**
 *
 *     "iPhone becomes noticeably hot with continued Bingd use"
 *     "app crashes every few minutes during ordinary navigation"
 *
 * Three tranches have now guessed at the cause of that. This does not. It reduces the
 * thirty-record network ring the app already keeps to the one question that separates a
 * thermal cause *inside* Bingd from an app that merely happens to be open: after a screen
 * settles, does the client keep making requests?
 *
 * The span and the saturation flag are load-bearing rather than decoration. Thirty records
 * over four minutes is an app doing nothing much; thirty over four seconds is a storm whose
 * real size the ring cannot see — and printing the same "30" for both would be the report
 * hiding the finding it exists to surface.
 */
describe('quiescence', () => {
  const at = (startedAt: number, name: string): NetworkRecord => ({
    seq: 1,
    name,
    startedAt,
    reachedFetch: true,
    endedAt: startedAt + 40,
    status: 200,
    repeat: 0,
  });

  const withNetwork = (network: NetworkRecord[], uptimeMs: number) => ({
    enabled: true,
    uptimeMs,
    network,
    events: [],
    counters: {},
  });

  it('reports zero for an app that has gone quiet', () => {
    const quiet = quiescence(withNetwork([at(1_000, 'rest:rankings')], 120_000));

    expect(quiet.last10s).toBe(0);
    expect(quiet.last60s).toBe(0);
    expect(quiet.saturated).toBe(false);
  });

  it('counts what is still happening, and names the operation doing it', () => {
    const busy = Array.from({ length: 12 }, (_, i) => at(59_000 + i * 50, 'rest:media_items'));
    const quiet = quiescence(withNetwork([at(1_000, 'rpc:my_feed'), ...busy], 60_000));

    expect(quiet.last10s).toBe(12);
    expect(quiet.busiest).toEqual({ name: 'rest:media_items', count: 12 });
  });

  it('flags a full ring, and prints the counts as floors when it cannot see the window', () => {
    const storm = Array.from({ length: 30 }, (_, i) => at(58_000 + i * 60, 'rpc:search_users'));
    const flight = withNetwork(storm, 60_000);
    const quiet = quiescence(flight);

    expect(quiet.saturated).toBe(true);
    // Two seconds of window for the whole buffer, so the real figure is larger than 30.
    expect(quiet.spanMs).toBeLessThan(3_000);
    expect(formatReport({ ...baseInput(), flight })).toContain('requests /10s  30+');
  });

  /**
   * **Review 52's MINOR.** A full ring is a fact about the buffer, not about either count.
   * One that reaches back four minutes contains every request of the last ten seconds
   * exactly — marking that `+` tells a quiet app it might be busy, which is the opposite
   * of what this section is read for.
   */
  it('does not mark a count as a floor when the ring reaches back past the window', () => {
    const old = Array.from({ length: 30 }, (_, i) => at(1_000 + i * 5_000, 'rest:media_items'));
    const flight = withNetwork(old, 300_000);
    const quiet = quiescence(flight);

    expect(quiet.saturated).toBe(true);
    expect(quiet.last10s).toBe(0);
    const report = formatReport({ ...baseInput(), flight });
    expect(report).toContain('requests /10s  0\n');
    expect(report).not.toContain('requests /10s  0+');
  });

  it('appears in the text, with the instruction that makes it interpretable', () => {
    const report = formatReport(baseInput());

    // The measurement is useless without the protocol, so the protocol is in the heading:
    // a founder who opens the sheet mid-scroll would read their own scrolling as a loop.
    expect(report).toContain('QUIESCENCE (put the phone down for 30s, then open this)');
    expect(report).toContain('requests /10s');
    expect(report).toContain('busiest op');
  });
});

describe('which provider signed this session in', () => {
  it('names it, so the device can answer the Apple-versus-Google report itself', () => {
    const report = formatReport({
      ...baseInput(),
      auth: { ...baseInput().auth, provider: 'apple' },
    });

    expect(report).toContain('provider     apple');
  });

  it('says nothing rather than guessing when there is no session to ask', () => {
    const report = formatReport({
      ...baseInput(),
      auth: { sessionExists: false, sessionKnown: true, authCallbacks: 0 },
    });

    expect(report).toContain('provider     —');
  });
});
