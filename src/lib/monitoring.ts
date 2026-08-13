import * as Sentry from '@sentry/react-native';

import { env, isProduction } from './env';

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
    environment: env.variant,

    // Off by default and left off. Sentry's "default PII" includes IP address
    // and, where it can find them, usernames and email addresses.
    sendDefaultPii: false,

    // Full sampling outside production because the traffic is a handful of
    // testers and every trace is worth having. In production this is a cost and
    // quota decision rather than a correctness one.
    tracesSampleRate: isProduction ? 0.2 : 1.0,

    integrations: [navigationIntegration],

    beforeSend: scrub,
    beforeBreadcrumb: scrubBreadcrumb,
  });
}

/**
 * Strips the parts of an event that can carry taste data.
 *
 * The interesting case is the URL. Route paths are safe — `/title/<uuid>` names
 * an identifier, not a film — but a query string is not, because the search
 * screen puts what the user typed into it. "Did anyone crash on the search
 * screen" is answerable without knowing they were looking for something
 * embarrassing.
 */
function scrub(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.user) {
    // The internal UUID is the only useful identifier and the only one kept.
    // Correlating a crash to an account needs an id; it does not need a name.
    event.user = { id: event.user.id };
  }

  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    event.request.url = stripQuery(event.request.url);
  }

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumbShape);
  }

  return event;
}

function scrubBreadcrumb(breadcrumb: Sentry.Breadcrumb): Sentry.Breadcrumb | null {
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
