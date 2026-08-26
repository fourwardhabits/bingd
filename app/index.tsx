import { LoadingScreen } from '@/ui/components';

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
 * other route.
 *
 * ---------------------------------------------------------------------------
 * **IT RENDERS THE WAIT, AND THAT IS THE FOUNDER'S BLANK STARTUP**
 *
 * It returned `null`, on the reasoning that `AuthStatusOverlay` is what the user sees
 * until routing has an answer. That is true of exactly the window the overlay covers —
 * `loading` and `error` — and the gap is the window after it. Once the session resolves
 * to `ready` the overlay renders nothing, and routing still will not move anybody until
 * the first-run check answers (`nextRoute`: `if (tastePending) return null`). For that
 * whole interval the navigator is mounted, the only route it has is this one, and this
 * one drew nothing: a full screen of paper with no mark, no spinner and no text, on
 * every cold start. That is the ~20 second blank the founder photographed on build 4 —
 * not a frozen app, an unrendered one.
 *
 * `LoadingScreen` is the same thing the overlay shows one state earlier, so the handover
 * from the native splash through session resolution and on into the first-run check is
 * one continuous image rather than a cut to nothing and back.
 */
export default function Index() {
  return <LoadingScreen />;
}
