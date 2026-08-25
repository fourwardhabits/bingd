/**
 * The root tabs, by route, in one place.
 *
 * **Why this file exists.** The founder's device test found "Explore For You" at the
 * end of onboarding landing on the Feed. The cause was a helper that had the
 * destination written into it rather than taking one, and what made that survive
 * review is that a bare `'/(tabs)/feed'` string looks correct wherever it appears —
 * nothing about it says which button it belongs to.
 *
 * The other half of the trap is that **the tab labels and the route names disagree,
 * on purpose.** The bar reads Feed · Collection · Search · For you · Profile; the
 * routes are `feed`, `collection`, `log`, `recommendations`, `profile`. Two of those
 * five are renames the layout records and explains — Search is still `log` because
 * renaming a file to match a label costs deep links and history for nothing. So a
 * screen navigating by the word on the bar guesses wrong twice out of five.
 *
 * Named by the *label* and valued by the *route*, so the caller writes what the button
 * says and this file owns the translation. Deliberately not an index: `<Tabs>` order is
 * a layout decision and navigating by position re-breaks the moment the bar is
 * reordered, silently and in a way no type can catch.
 */
export const TAB_ROUTES = {
  feed: '/(tabs)/feed',
  collection: '/(tabs)/collection',
  /** The centre tab. Labelled Search, routed `log` — see `app/(tabs)/_layout.tsx`. */
  search: '/(tabs)/log',
  /** Labelled "For you". This is the one onboarding's Explore For You means. */
  forYou: '/(tabs)/recommendations',
  profile: '/(tabs)/profile',
} as const;

export type TabRoute = (typeof TAB_ROUTES)[keyof typeof TAB_ROUTES];
