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

/**
 * The Feed, opened on People (2026-09-07; **moved to the Feed tab 2026-09-08**).
 *
 * The social cold start has one answer in this app and it is a *state* of a tab rather than
 * a screen: `PeopleView` draws behind the Feed's own Feed / Leaderboard / People control,
 * and nothing else in the app leads to it. Two surfaces need to send somebody there
 * directly — the end of onboarding, and an empty Feed — and a parameter on the existing tab
 * is what lets them do that without a second People screen, a sixth tab or a duplicated
 * component.
 *
 * **It used to point at For You**, where People was a category of the Movies / TV shows
 * dropdown. The founder's §§A2 and A16 moved People onto the Feed and left For You as
 * titles only, and this constant existing is what made that a one-line change at both call
 * sites instead of two screens each having an opinion about where People lives.
 *
 * `from` rides along so `people_suggestions_viewed` can say which mechanism worked. It is a
 * `PeopleEntry`, checked against that union by the compiler at each call site rather than
 * here — this file has no business importing the analytics vocabulary.
 *
 * One factory rather than call sites each spelling `show: 'people'`, for the reason
 * `TAB_ROUTES` exists: a bare string looks right wherever it appears, and the screen
 * reading it has to agree with every writer.
 */
export const peopleDiscovery = (from: 'onboarding' | 'sparse_feed') =>
  ({ pathname: TAB_ROUTES.feed, params: { show: 'people', from } }) as const;

/** Somewhere a screen can send a person: a tab, or the one tab state that has a name. */
export type Destination = TabRoute | ReturnType<typeof peopleDiscovery>;
