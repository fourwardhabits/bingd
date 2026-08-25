import * as Sentry from '@sentry/react-native';

import { env, isProduction, lane } from './env';
import { releaseTags } from './release';

/**
 * Crash and error reporting.
 *
 * Two things this file is careful about.
 *
 * **It is optional.** With no DSN configured every function here is a no-op, so
 * the project runs for a contributor who has no Sentry account and no reason to
 * want one. Crash reporting that forces credentials on everyone gets disabled
 * locally, and then nobody notices it is disabled in CI either.
 *
 * **It assumes the payload is hostile to privacy until proved otherwise.** A
 * crash reporter's default behaviour is to send as much context as it can find,
 * and in this app that context is somebody's viewing history. PRD §22 does not
 * carve out an exception for error reports.
 */

/** Expo Router is React Navigation underneath, so this is the right integration. */
export const navigationIntegration = Sentry.reactNavigationIntegration({
  enableTimeToInitialDisplay: true,
});

export const monitoringEnabled = Boolean(env.sentryDsn);

export function initMonitoring(): void {
  if (!env.sentryDsn) return;

  Sentry.init({
    dsn: env.sentryDsn,

    /**
     * **The lane, not the variant**, and the difference is the whole point once there are
     * two backends.
     *
     * `variant` has three values and a Beta build carries `production` — the bundle
     * identifier cannot change between a TestFlight build and the App Store release that
     * replaces it. So while this read `env.variant`, a friend-Beta crash against
     * `bingd-nonprod` and a public crash against the production database arrived in Sentry
     * under the same `environment: production`, distinguishable only by the `eas_channel`
     * tag below.
     *
     * That was survivable while beta was the only thing deployed. It is not survivable as a
     * public launch property: `environment` is what a Sentry alert rule, an issue filter and
     * a release-health chart are keyed on, and "production is broken" has to mean the thing
     * strangers installed.
     *
     * Four values now, matching `eas.json`: development, preview, beta, production. The tags
     * below stay — they answer a different question, which is *which device on the desk*.
     */
    environment: lane,

    // Off by default and left off. Sentry's "default PII" includes IP address
    // and, where it can find them, usernames and email addresses.
    sendDefaultPii: false,

    // Full sampling outside production because the traffic is a handful of
    // testers and every trace is worth having. In production this is a cost and
    // quota decision rather than a correctness one.
    tracesSampleRate: isProduction ? 0.2 : 1.0,

    integrations: [navigationIntegration],

    beforeSend: scrub,
    /**
     * **Transactions do not pass through `beforeSend`.** They are a separate hook, and
     * `tracesSampleRate` is 1.0 outside production — so every performance transaction was
     * leaving unscrubbed while the error path beside it was carefully filtered. Review 24
     * found it. A transaction carries the same `request` object an error does.
     */
    beforeSendTransaction: scrubTransaction,
    beforeBreadcrumb: scrubBreadcrumb,
  });

  /**
   * Which build this is, as searchable tags.
   *
   * **Not `release` and `dist`.** The Sentry Expo plugin sets those at build time from
   * the native project, and they are what the source maps are uploaded against —
   * overriding them with values read at runtime turns a symbolicated stack back into
   * minified output, which is most of what a crash reporter is for.
   *
   * These sit beside them and answer the question the founder will actually ask during
   * the beta: *which of the four things on my desk did this come from.* `environment` is
   * the lane, so it separates the four lanes and nothing finer; two Preview builds a week
   * apart share it, and `build_kind`, `eas_channel` and `eas_update_id` are what tell them
   * apart. Nothing here is a secret — every value is printed on a build's own About screen
   * (`lib/release.ts`).
   */
  Sentry.setTags(releaseTags());
}

/**
 * Strips the parts of an event that can carry taste data.
 *
 * The interesting case is the URL. Route paths are safe — `/title/<uuid>` names
 * an identifier, not a film — but a query string is not, because the search
 * screen puts what the user typed into it. "Did anyone crash on the search
 * screen" is answerable without knowing they were looking for something
 * embarrassing.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES **NOT** REMOVE, AND THE RESIDUAL RISK
 *
 * Exception messages and stack frames are kept. That is not an oversight: they are
 * the entire product. A crash reporter that redacts the error is a crash reporter
 * that reports nothing, and the alternative — a recursive allowlist over the whole
 * payload — would drop the one field anybody opens the dashboard to read.
 *
 * The residual, named so it is a known risk rather than a false claim of safety:
 * **PostgreSQL echoes rejected input in constraint and cast errors.** A `23514` or a
 * `22P02` can carry the value that failed. `lib/diagnose.ts` refuses to put those
 * messages on screen for exactly this reason, and the same exposure exists here for
 * any such error that reaches Sentry as an exception.
 *
 * **Plenty of query functions do throw one** — every `if (error) throw error` in a
 * `queryFn`, which is most of them. What keeps those out of Sentry today is that React
 * Query catches them and turns them into an error state a screen renders; no call site
 * forwards one on, and `reportHandled` has no callers at all. That is a property of the
 * current call sites rather than of this file, so it is written down rather than assumed:
 * the first `reportHandled(supabaseError)` anybody adds inherits this exposure. Recorded
 * as debt, not closed here.
 */
export function scrub(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.user) {
    // The internal UUID is the only useful identifier and the only one kept.
    // Correlating a crash to an account needs an id; it does not need a name.
    event.user = { id: event.user.id };
  }

  scrubRequest(event);

  /**
   * `extra` is the one bag a caller fills by hand, so it is the one that can be handed
   * an object without anybody noticing. Scalars only — an object or an array is dropped
   * rather than walked, which is the same rule `lib/analytics.ts` applies for the same
   * reason: the accident to guard is somebody spreading a row into a context bag.
   *
   * `contexts` is left alone. It is Sentry's own device, OS and app metadata, which is
   * what makes a report actionable and carries nothing a person wrote.
   */
  if (event.extra) event.extra = scalarsOnly(event.extra);

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumbShape);
  }

  return event;
}

/**
 * The same treatment for a performance transaction.
 *
 * A transaction has no `exception` and no `user` worth reducing, but it does carry a
 * `request` — and it never sees `beforeSend`, which is how this one went unfiltered.
 */
export function scrubTransaction<T extends Sentry.Event>(event: T): T {
  scrubRequest(event);
  if (event.extra) event.extra = scalarsOnly(event.extra);
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumbShape);
  return event;
}

function scrubRequest(event: Sentry.Event) {
  if (!event.request) return;
  delete event.request.data;
  delete event.request.cookies;
  event.request.url = stripQuery(event.request.url);
  if (event.request.query_string) delete event.request.query_string;
}

const scalarsOnly = (bag: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bag)) {
    const type = typeof value;
    if (type === 'string' || type === 'number' || type === 'boolean') out[key] = value;
  }
  return out;
};

export function scrubBreadcrumb(breadcrumb: Sentry.Breadcrumb): Sentry.Breadcrumb | null {
  // Console breadcrumbs replay whatever was logged during development, which is
  // the least controlled surface in the app.
  if (breadcrumb.category === 'console') return null;
  return scrubBreadcrumbShape(breadcrumb);
}

function scrubBreadcrumbShape(breadcrumb: Sentry.Breadcrumb): Sentry.Breadcrumb {
  const data = breadcrumb.data;
  if (data && typeof data.url === 'string') {
    return { ...breadcrumb, data: { ...data, url: stripQuery(data.url) } };
  }
  return breadcrumb;
}

function stripQuery(url: string | undefined): string | undefined {
  if (!url) return url;
  const cut = url.indexOf('?');
  return cut === -1 ? url : url.slice(0, cut);
}

/**
 * Ties errors to an account without naming the person. Called on sign-in, and
 * with null on sign-out so a subsequent crash is not attributed to whoever was
 * signed in last.
 */
export function identifyForMonitoring(userId: string | null): void {
  if (!monitoringEnabled) return;
  Sentry.setUser(userId ? { id: userId } : null);
}

/** Reports a handled error that the user was shown a recovery path for. */
export function reportHandled(error: unknown, context?: Record<string, number | string | boolean>) {
  if (!monitoringEnabled) return;
  Sentry.captureException(error, context ? { extra: context } : undefined);
}
