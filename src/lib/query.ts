import { QueryClient } from '@tanstack/react-query';

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
  feed: (cursor?: string) => ['feed', { cursor }] as const,
  recommendations: (userId: string) => ['recommendations', userId] as const,
  title: (mediaItemId: string) => ['title', mediaItemId] as const,
  // Deliberately separate from `title`: the comparison card reads three columns, and
  // sharing a key with a full title row would let whichever query ran first serve the
  // other a shape it did not ask for.
  comparisonCard: (mediaItemId: string) => ['comparison-card', mediaItemId] as const,
  // Not keyed by user: the catalogue is the same for everyone, so a sign-out need not
  // discard it and two accounts on one device share the cache.
  search: (query: string) => ['search', query] as const,
  seasons: (seriesId: string) => ['seasons', seriesId] as const,
  profile: (username: string) => ['profile', username] as const,
  notifications: () => ['notifications'] as const,
} as const;

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
