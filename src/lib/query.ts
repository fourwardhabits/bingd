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
  feed: (userId: string, cursor?: string) => ['feed', userId, { cursor }] as const,
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
  // Deliberately separate from `title`: the comparison card reads three columns, and
  // sharing a key with a full title row would let whichever query ran first serve the
  // other a shape it did not ask for.
  comparisonCard: (mediaItemId: string) => ['comparison-card', mediaItemId] as const,
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
  providerSearch: (query: string) => ['search', 'provider', query] as const,
  seasons: (seriesId: string) => ['seasons', seriesId] as const,
  profile: (username: string) => ['profile', username] as const,
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

export const createQueryClient = () =>
  new QueryClient({
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
