/**
 * The route for `/`, which nothing else provides.
 *
 * `(tabs)` is a group, so it contributes no path segment: `(tabs)/feed.tsx` is
 * `/feed`, and there is no `(tabs)/index.tsx`. So the URL the app actually launches
 * with — `/` — matched no route and fell through to `+not-found`, on every cold start.
 *
 * This screen waits rather than redirects. Sending users on from here with `Redirect`
 * mounted the feed on the first render, before the session had resolved, and the feed
 * calls `useCurrentProfile`, which throws outside a ready session — a render error on
 * every cold start. `useAuthRouting` owns the decision instead, as it does for every
 * other route, and `AuthStatusOverlay` is what the user sees until it has one.
 */
export default function Index() {
  return null;
}
