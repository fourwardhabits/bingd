import type { Query } from '@tanstack/react-query';

import { NETWORK_LIMIT, type FlightSnapshot, type LastSession, type NetworkRecord } from './flight-recorder';

/**
 * The copyable report, and the one place its contents are decided.
 *
 * Everything the founder pastes back goes through this file, so this is where the privacy
 * argument lives rather than being spread across a screen. Two rules, both enforced by
 * `flight-report.test.ts`:
 *
 *   · **Nothing is interpolated that the app did not name itself.** Operation names come
 *     from `logicalName`, query names from the first element of a query key, route names
 *     from the router. All three are schema — identical for every user of the app.
 *   · **Identifiers are reduced, never printed.** A query key's later elements are account
 *     and title ids; they are replaced by their *count*, which is what makes two keys
 *     distinguishable without naming anybody.
 *
 * What that leaves out, deliberately and completely: access tokens, refresh tokens,
 * authorization headers, OTPs, the push token, the service-role key, notes, comments,
 * review text, search terms, email addresses, request bodies, and PostgREST error
 * messages — which echo rejected input, and so are reduced to the error's class name at
 * the point of capture.
 */

export type QueryFacts = {
  /** The first element of the query key: `collection`, `profile-stats`, `feed`. */
  name: string;
  /** How many further elements the key had — ids, counted rather than shown. */
  keyParts: number;
  status: string;
  fetchStatus: string;
  failureCount: number;
  /** Milliseconds since this process started, or undefined for never. */
  updatedAgoMs?: number;
  hasData: boolean;
};

export type AuthFacts = {
  sessionExists: boolean;
  /** False when the read did not come back — which is not the same as "no session". */
  sessionKnown?: boolean;
  /** Seconds until the access token expires. Negative means it already has. */
  expiresInSeconds?: number;
  hydrationMs?: number;
  authCallbacks: number;
  /**
   * Which provider this session was actually created by — `apple`, `google` or `email`.
   *
   * **The one fact that settles a provider-routing report from the device itself.** The
   * founder reported that Continue with Apple "just picks the last Google account", and
   * the backend says otherwise: accounts carry a single `apple` identity or a single
   * `google` one and never both. But that is an answer read from a database by somebody
   * else, and the person who can reproduce it in one tap could not see it at all — so the
   * session now names its own provider, and one Apple sign-in followed by opening this
   * sheet is the whole experiment.
   *
   * A provider name is a closed set of three words. It is not a credential, not an
   * address, and not an account.
   */
  provider?: string;
};

export type ReleaseFacts = {
  appVersion: string | null;
  buildNumber: string | null;
  runtimeVersion: string | null;
  updateId: string | null;
  channel: string | null;
  embedded: boolean;
  commit?: string | null;
  launchedAtIso: string;
};

export type OnboardingFacts = {
  storedPhase: string;
  derivedNeeded: string;
  ranked: number | null;
  logged: number | null;
};

export type ReportInput = {
  release: ReleaseFacts;
  auth: AuthFacts;
  onboarding: OnboardingFacts;
  route: string;
  appState: string;
  flight: FlightSnapshot;
  queries: QueryFacts[];
  lastSession: LastSession | null;
};

/**
 * Reads what React Query knows, reduced to facts that name nothing.
 *
 * `status` and `fetchStatus` together are what distinguish a query that never ran from one
 * whose request is in flight — `pending`/`idle` versus `pending`/`fetching` — which is the
 * discriminator the whole exercise turns on when read beside the network log.
 */
export function queryFacts(queries: readonly Query[], now: number): QueryFacts[] {
  return queries
    .map((query): QueryFacts => {
      const key = query.queryKey as readonly unknown[];
      return {
        name: typeof key[0] === 'string' ? key[0] : 'unnamed',
        keyParts: Math.max(0, key.length - 1),
        status: query.state.status,
        fetchStatus: query.state.fetchStatus,
        failureCount: query.state.fetchFailureCount,
        updatedAgoMs: query.state.dataUpdatedAt ? now - query.state.dataUpdatedAt : undefined,
        hasData: query.state.data !== undefined,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((facts) => ({
      ...facts,
      updatedAgoMs:
        facts.updatedAgoMs === undefined ? undefined : Math.max(0, facts.updatedAgoMs),
    }));
}

/** `blocked` is the finding; the other three are ordinary. See `NetworkRecord.reachedFetch`. */
export function phaseOf(record: NetworkRecord): string {
  if (record.endedAt === undefined) return record.reachedFetch ? 'PENDING' : 'BLOCKED';
  if (record.errorClass) return 'FAILED';
  return 'ANSWERED';
}

const ms = (value: number | undefined) =>
  value === undefined ? '—' : `${Math.round(value)}ms`;

export type Quiescence = {
  /** Requests started within the last ten seconds of the recorded window. */
  last10s: number;
  /** And within the last minute. Both are capped by the ring — see `saturated`. */
  last60s: number;
  /** How long the whole ring covers, in ms. Thirty records over 4s is not thirty over 4m. */
  spanMs: number;
  /**
   * True when the ring is full — which is a fact about the buffer, not about either count.
   *
   * **Review 52's correction.** A full ring only makes a window's count a *floor* when the
   * ring cannot see the whole window: thirty records spanning four seconds hides an unknown
   * number more, while thirty spanning four minutes contains every request of the last
   * minute exactly. Marking both counts `+` on saturation alone told a quiet app it might
   * be busy, which is the opposite of what this section is read for. `spanMs` beside this
   * is what decides it — see `formatReport`.
   */
  saturated: boolean;
  /** The operation with the most records in the ring, and how many. */
  busiest?: { name: string; count: number };
};

/**
 * **Whether the app goes quiet once a screen has settled**, which is the founder's second
 * blocker stated as something measurable.
 *
 * The phone gets hot and the app dies every few minutes, and three tranches have now
 * guessed at why. This does not guess. It reads the thirty-record network ring the app
 * already keeps and reduces it to the one question that separates a thermal *cause* inside
 * Bingd from an app that is merely present while something else runs hot: **after the
 * screen stops changing, does the client keep making requests?**
 *
 * How to use it, which matters as much as the numbers: open a screen, put the phone down
 * for thirty seconds, then open Diagnostics. A settled app shows `requests /10s` at or near
 * zero. Anything else is a loop, and `busiest` names it.
 *
 * `spanMs` and `saturated` exist because the ring is short. Thirty records covering four
 * minutes is an app doing nothing much; thirty covering four seconds is a storm whose true
 * size this cannot see, and reporting the same "30" for both would be the report hiding the
 * finding.
 */
export function quiescence(flight: FlightSnapshot): Quiescence {
  const records = flight.network;
  const now = flight.uptimeMs;
  const within = (windowMs: number) =>
    records.filter((record) => now - record.startedAt <= windowMs).length;

  const counts = new Map<string, number>();
  for (const record of records) counts.set(record.name, (counts.get(record.name) ?? 0) + 1);
  let busiest: Quiescence['busiest'];
  for (const [name, count] of counts) {
    if (!busiest || count > busiest.count) busiest = { name, count };
  }

  const oldest = records[0]?.startedAt ?? now;
  return {
    last10s: within(10_000),
    last60s: within(60_000),
    spanMs: Math.max(0, now - oldest),
    saturated: records.length >= NETWORK_LIMIT,
    busiest,
  };
}

const pad = (value: string, width: number) => value.padEnd(width).slice(0, width);

/**
 * The whole report, as plain text, because the founder is going to paste it into a chat.
 *
 * Deliberately fixed-width columns rather than JSON: it has to be readable on a phone
 * screen before it is copied, so that an obvious answer can be obvious without a round
 * trip.
 */
export function formatReport(input: ReportInput): string {
  const { release, auth, onboarding, flight, queries, lastSession } = input;
  const lines: string[] = [];

  lines.push('bingd. diagnostics');
  lines.push(
    `captured ${new Date().toISOString()} · uptime ${Math.round(flight.uptimeMs / 1000)}s`,
  );
  if (!flight.enabled) lines.push('RECORDER DISABLED (release build)');

  lines.push('');
  lines.push('RELEASE');
  lines.push(
    `  app          ${release.appVersion ?? '—'} (build ${release.buildNumber ?? '—'})`,
  );
  lines.push(`  runtime      ${release.runtimeVersion ?? '—'}`);
  lines.push(`  update       ${release.updateId ?? '—'}`);
  lines.push(`  source       ${release.commit ?? '—'}`);
  lines.push(`  channel      ${release.channel ?? '—'}`);
  lines.push(
    `  launched     ${release.embedded ? 'embedded' : 'downloaded update'} at ${release.launchedAtIso}`,
  );

  lines.push('');
  lines.push('AUTH');
  lines.push(
    `  session      ${auth.sessionKnown === false ? 'UNKNOWN (read did not answer)' : auth.sessionExists ? 'YES' : 'NO'}`,
  );
  lines.push(
    `  expires in   ${auth.expiresInSeconds === undefined ? '—' : `${auth.expiresInSeconds}s`}`,
  );
  lines.push(`  hydration    ${ms(auth.hydrationMs)}`);
  lines.push(`  callbacks    ${auth.authCallbacks}`);
  lines.push(`  provider     ${auth.provider ?? '—'}`);

  lines.push('');
  lines.push('ONBOARDING');
  lines.push(`  stored phase ${onboarding.storedPhase}`);
  lines.push(`  derived need ${onboarding.derivedNeeded}`);
  lines.push(`  ranked       ${onboarding.ranked ?? '—'}`);
  lines.push(`  logged       ${onboarding.logged ?? '—'}`);

  lines.push('');
  lines.push('APP');
  lines.push(`  route        ${input.route}`);
  lines.push(`  app state    ${input.appState}`);

  const quiet = quiescence(flight);
  /**
   * A count is a floor only where the ring is full **and** does not reach back past the
   * window. A full ring spanning four minutes holds every request of the last ten seconds
   * exactly; a full ring spanning four seconds is hiding an unknown number more.
   */
  const floor = (windowMs: number) => (quiet.saturated && quiet.spanMs <= windowMs ? '+' : '');
  lines.push('');
  lines.push('QUIESCENCE (put the phone down for 30s, then open this)');
  lines.push(`  requests /10s  ${quiet.last10s}${floor(10_000)}`);
  lines.push(`  requests /60s  ${quiet.last60s}${floor(60_000)}`);
  lines.push(
    `  window         ${Math.round(quiet.spanMs / 1000)}s for ${flight.network.length} records${quiet.saturated ? ' (ring full)' : ''}`,
  );
  lines.push(
    `  busiest op     ${quiet.busiest ? `${quiet.busiest.name} ×${quiet.busiest.count}` : '—'}`,
  );

  lines.push('');
  lines.push(`NETWORK (last ${flight.network.length})`);
  lines.push('  at      op                        phase     took     status  rpt');
  for (const record of flight.network) {
    lines.push(
      `  ${pad(`${Math.round(record.startedAt)}`, 7)} ${pad(record.name, 25)} ${pad(phaseOf(record), 9)} ${pad(
        record.endedAt === undefined ? '—' : ms(record.endedAt - record.startedAt),
        8,
      )} ${pad(record.status !== undefined ? String(record.status) : (record.errorClass ?? '—'), 7)} ${record.repeat}`,
    );
  }
  if (!flight.network.length) lines.push('  (none)');

  lines.push('');
  lines.push('QUERIES');
  lines.push('  name                      status     fetch      fails  data   updated');
  for (const query of queries) {
    lines.push(
      `  ${pad(`${query.name}/${query.keyParts}`, 25)} ${pad(query.status, 10)} ${pad(query.fetchStatus, 10)} ${pad(
        String(query.failureCount),
        6,
      )} ${pad(query.hasData ? 'yes' : 'no', 6)} ${ms(query.updatedAgoMs)}`,
    );
  }
  if (!queries.length) lines.push('  (none)');

  lines.push('');
  lines.push('EVENTS');
  for (const event of flight.events) {
    lines.push(
      `  ${pad(`${Math.round(event.at)}`, 7)} ${pad(event.channel, 11)} ${pad(event.label, 26)} ${pad(
        event.detail ?? '',
        18,
      )} ${event.ms === undefined ? '' : ms(event.ms)}`,
    );
  }
  if (!flight.events.length) lines.push('  (none)');

  const counters = Object.entries(flight.counters).sort(([a], [b]) => a.localeCompare(b));
  lines.push('');
  lines.push('COUNTS');
  for (const [key, value] of counters) lines.push(`  ${pad(key, 34)} ${value}`);
  if (!counters.length) lines.push('  (none)');

  if (lastSession) {
    lines.push('');
    lines.push('PREVIOUS SESSION ENDED WITH');
    lines.push(
      `  ended        ${lastSession.endedAtIso} after ${Math.round(lastSession.uptimeMs / 1000)}s`,
    );
    lines.push(`  route        ${lastSession.route ?? '—'}`);
    lines.push(`  unfinished   ${lastSession.pending.join(', ') || '(none)'}`);
    for (const event of lastSession.events) {
      lines.push(
        `  ${pad(`${Math.round(event.at)}`, 7)} ${pad(event.channel, 11)} ${event.label} ${event.detail ?? ''}`,
      );
    }
    lines.push('  (this says what was running, not that anything crashed)');
  }

  return lines.join('\n');
}
