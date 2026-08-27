import type { Query } from '@tanstack/react-query';

import type { FlightSnapshot, LastSession, NetworkRecord } from './flight-recorder';

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
