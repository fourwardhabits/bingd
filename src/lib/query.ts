import { focusManager, QueryClient } from '@tanstack/react-query';
import { AppState } from 'react-native';

/**
 * Structured so invalidation can be surgical (docs/architecture/client.md §3).
 *
 * Completing a ranking invalidates that category's rankings and the owner's
 * collection, and nothing else. The feed refreshes on its own schedule rather
 * than being blown away by an unrelated write.
 */
export const queryKeys = {
  capabilities: () => ['capabilities'] as const,
  // Keyed by user id so a sign-out followed by a different sign-in cannot read the
  // previous account's profile out of the cache.
  myProfile: (userId: string) => ['my-profile', userId] as const,
  collection: (userId: string) => ['collection', userId] as const,
  rankings: (userId: string, category: string) => ['rankings', userId, category] as const,
  /**
   * The reader's own score for every ranked title — Search's row badges read it.
   * A named key, so the post-ranking invalidation cannot forget it again (founder QA,
   * 2026-09-21: a just-ranked Black Panther showed the dashed Rank badge in Search).
   */
  myScores: (userId: string) => ['my-scores', userId] as const,
  // The feed is an infinite query (feed pagination, 2026-09-04): its cursor is a *page
  // param*, which React Query stores inside the entry itself. A cursor in the key as well
  // would give every page its own cache entry, and the list would be one page long.
  feed: (userId: string) => ['feed', userId] as const,
  recommendations: (userId: string) => ['recommendations', userId] as const,
  title: (mediaItemId: string) => ['title', mediaItemId] as const,
  // What the log sheet opens onto: the user's own bucket, note, watch date and
  // whether the title is ranked. Separate from `title` for the same reason
  // `comparisonCard` is — a different shape read by a different screen.
  // Keyed by the account as well as the title, like every other per-user key here.
  // It was not, and independent review found what that costs: this entry holds a
  // note, and a note is the one thing in the collection PRD §22 keeps private at
  // every visibility level. `queryClient.clear()` on sign-out (session.tsx) is what
  // has been preventing the leak in practice, which is a second mechanism doing this
  // one's job — and `myProfile` above is keyed this way for exactly the reason given
  // in its own comment. One argument is a cheaper guarantee than a lifecycle.
  logState: (userId: string, mediaItemId: string) => ['log-state', userId, mediaItemId] as const,
  // One title's viewings and placements, for the Watch History screen (§J.2). Keyed by
  // the account for the reason `logState` records above: a watch date is owner-only at
  // every profile visibility (PRD §22), so an entry holding one must not be reachable
  // from a second account signed in on the same device.
  watchHistory: (userId: string, mediaItemId: string) =>
    ['watch-history', userId, mediaItemId] as const,
  // Just the integer the title page's context line draws. Its own key, not a slice of
  // `watchHistory`, because the line renders on every title page visit and the history
  // is a list — sharing a key would put a twenty-row diary on the wire to draw four
  // words, and the `head: true` count sends no rows at all.
  watchCount: (userId: string, mediaItemId: string) =>
    ['watch-count', userId, mediaItemId] as const,
  // Deliberately separate from `title`: the comparison card reads three columns, and
  // sharing a key with a full title row would let whichever query ran first serve the
  // other a shape it did not ask for.
  comparisonCard: (mediaItemId: string) => ['comparison-card', mediaItemId] as const,
  // Refine's standing for one category (T5 + unified design): the status and whether the
  // Collection card may invite a sitting, read with a limit of one. Per account.
  refineAvailability: (userId: string, category: string) =>
    ['refine-availability', userId, category] as const,
  // The unranked backlog's standing for one category (unified design §9): on or off, and
  // the exact count the Unranked tab names. Per account.
  rankingBacklog: (userId: string, category: string) =>
    ['ranking-backlog', userId, category] as const,
  // What a long press during ranking opens: enough of a title to remember it by. Its
  // own key rather than `title`'s for the reason directly above — it reads a different
  // subset of the same row, and two shapes under one key is a race over which screen
  // ran first. Fetched only on the long press, so a reader who never asks never pays.
  titleRecall: (mediaItemId: string) => ['title-recall', mediaItemId] as const,
  // Not keyed by user: the catalogue is the same for everyone, so a sign-out need not
  // discard it and two accounts on one device share the cache.
  search: (query: string) => ['search', query] as const,
  // Separate from `search`, and separately cached, because the two passes have very
  // different costs: the local one is a table read and the provider one spends a TMDB
  // request against a shared quota. Sharing a key would let an invalidation of the cheap
  // pass silently re-spend the expensive one.
  // One entry per normalised query **and page**, so backspacing to an earlier query reuses
  // every page already read for it, and a later page never refetches the ones before it.
  providerSearch: (query: string, page = 1) => ['search', 'provider', query, page] as const,
  // Cast search, which also spends a provider request and is keyed on the same normalised
  // query for the same reason. Its own branch so it can never be mistaken for title rows.
  castSearch: (query: string) => ['search', 'cast', query] as const,
  seasons: (seriesId: string) => ['seasons', seriesId] as const,
  profile: (username: string) => ['profile', username] as const,
  // The four counts the own-profile header draws. Named here rather than left inline in
  // `useProfileStats`, where it was: an inline key is one nothing else can refer to, and
  // these counts are moved by writes that happen elsewhere — following somebody changes
  // two accounts' numbers, and completing a ranking changes a third. Movies and TV count
  // the watched collection (20260917001600), so `invalidateAfterCollectionChange` and
  // `invalidateAfterImport` invalidate it.
  profileStats: (userId: string) => ['profile-stats', userId] as const,
  // Targets and progress for one year. Keyed by the account for the reason `logState`
  // records above — a goal is own-read only, so an entry holding one must not be
  // reachable from a second account signed in on the same device.
  goals: (userId: string, year: number) => ['goals', userId, year] as const,
  notifications: () => ['notifications'] as const,
  // Not keyed by account, for the reason `search` records: what TMDB is featuring is
  // the same list for everyone. Named here rather than left inline in the hook because
  // the Feed's pull-to-refresh has to name it too — the shelf owns its own query, so
  // the key is the only way that gesture can reach it.
  trending: () => ['trending', 'day'] as const,
  // Whether this account has ever ranked or logged anything, read once on arrival.
  // Deliberately *not* under `collection`, which the ranking flow invalidates: sharing
  // that prefix would answer "no longer new" the moment the first film was placed and
  // evict the user from the flow they were in the middle of.
  tasteOnboarding: (userId: string) => ['taste-onboarding', userId] as const,

  // ---------------------------------------------------------------------------
  // Lists (20261010000100).
  //
  // Two branches, deliberately not one. `myLists` is the caller's own management
  // screen and holds every visibility; `profileLists` is the public shelf and holds
  // only what a visitor would see — for the owner as well (§Q.4). Sharing a prefix
  // would let an invalidation after creating a *private* list refill the profile
  // shelf from a read that answered a different question, and keeping the two
  // distinguishable is the whole reason the shelf is public-only.
  myLists: (userId: string) => ['my-lists', userId] as const,
  profileLists: (ownerId: string, limit: number) => ['profile-lists', ownerId, limit] as const,
  // One list's header. Not keyed by viewer: the server answers per caller, and the
  // client clears the whole cache on sign-out (session.tsx) — the same treatment
  // `title` has.
  list: (listId: string) => ['list', listId] as const,
  // Separate from `list` for the reason `comparisonCard` is separate from `title`: a
  // different shape read by a different query, and one key over two shapes is a race
  // about which ran first. It is also an infinite query, so its cursor is a page param
  // and deliberately not in the key.
  listItems: (listId: string) => ['list-items', listId] as const,
  // "You've seen X of N", over the whole list rather than over the loaded pages. Its
  // own key because logging a *watch* moves it while nothing about the list changed.
  listProgress: (listId: string) => ['list-progress', listId] as const,
  // What the Add-to-list sheet reads: the caller's lists plus a membership flag for
  // one title. Keyed by the title, because that flag is the whole answer.
  listsForTitle: (mediaItemId: string) => ['lists-for-title', mediaItemId] as const,
} as const;

/**
 * Teaches React Query what "focused" means on a phone.
 *
 * Its own focus detection is `visibilitychange`, which is a browser event and never
 * fires here — so without this, `refetchOnWindowFocus` is not merely disabled by the
 * default below, it is *inert*, and a query can only ever refetch when a new observer
 * mounts against stale data. That is what the notification badge was living with: the
 * Feed tab stays mounted, so nothing asked the server again while somebody sat on it.
 *
 * Wired once at the root, next to the session refresh and the update check, which are
 * the two things already listening to this event for the same reason. Returns its own
 * teardown so the effect that starts it can stop it.
 *
 * The global default below stays `false`. This makes the mechanism *work*; which
 * queries opt into it is still each query's own decision, and today that is the
 * notification inbox and the Trending shelf.
 */
export function startQueryFocusTracking() {
  const subscription = AppState.addEventListener('change', (next) => {
    focusManager.setFocused(next === 'active');
  });

  return () => subscription.remove();
}

/**
 * How long a provider search answer is kept, fresh and in memory: half an hour.
 *
 * Both halves matter. `staleTime` alone is not enough on Search, because every earlier
 * query loses its last observer the moment the reader types past it, and an unobserved
 * entry is garbage-collected after `gcTime` — five minutes by default. So backspacing to a
 * title searched ten minutes ago was a fresh charged TMDB request for an answer the device
 * had already held (2026-09-13).
 *
 * `gcTime` is set here, as defaults for the two provider keys, rather than on the hooks: a
 * per-query value would override the test client's `gcTime: 0` and leave half-hour timers
 * holding every screen suite open after its last test.
 */
export const PROVIDER_SEARCH_CACHE_MS = 30 * 60_000;

export const createQueryClient = () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        retry: 2,
        // The app is expected to open offline and render from SQLite, so a
        // failed refetch must not blank a screen that already has content.
        refetchOnReconnect: true,
        refetchOnWindowFocus: false,
      },
      mutations: {
        // Only outbox-eligible operations retry. Ranking mutations are online-only
        // by design (docs/architecture/offline-sync.md §1) and fail visibly.
        retry: 0,
      },
    },
  });

  for (const key of [queryKeys.providerSearch(''), queryKeys.castSearch('')]) {
    // The two-segment prefix, so every query under it inherits the default.
    client.setQueryDefaults(key.slice(0, 2), { gcTime: PROVIDER_SEARCH_CACHE_MS });
  }

  return client;
};
