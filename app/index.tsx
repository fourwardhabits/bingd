import { Redirect } from 'expo-router';

/**
 * The route for `/`, which nothing else provides.
 *
 * `(tabs)` is a group, so it contributes no path segment: `(tabs)/feed.tsx` is
 * `/feed`, and there is no `(tabs)/index.tsx`. So the URL the app actually launches
 * with — `/` — matched no route and fell through to `+not-found`, on every cold
 * start. `useAuthRouting` could not correct it either, because its last branch only
 * moves a user who is *inside* the auth group; a signed-in user sitting on
 * `+not-found` is not, and stayed there.
 *
 * The destination matches what `useAuthRouting` already chooses when a user leaves
 * the auth group, so there is one answer to "where does the app open" rather than
 * two that can drift. A signed-out user is redirected on from here by the same hook,
 * exactly as they would be from any other route.
 */
export default function Index() {
  return <Redirect href="/feed" />;
}
