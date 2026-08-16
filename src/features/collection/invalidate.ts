import type { QueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query';

/**
 * Everything that stops being true when someone logs or ranks a title.
 *
 * The founder ranked a film and the Feed did not show it. The cause was not a race
 * or a cache time — the ranking path simply never invalidated the feed key. It
 * invalidated the category's rankings, the collection and the title, which is the set
 * that was correct when it was written and has been wrong since the feed started
 * reading `feed_events`, which `_rank_finalize` writes to.
 *
 * The reason it went unnoticed is that each writer kept its own list. Two sheets,
 * two lists, and a surface added later only ever gets added to one of them. So the
 * list lives here now, and both writers call it — a new surface is added in one place
 * or it is broken in both, which is at least a failure that shows up immediately.
 *
 * This is deliberately not `queryClient.clear()` or an unkeyed invalidate. Every key
 * below is one a completed ranking genuinely changes, and the expensive reads that it
 * does not change — the catalogue, search, another person's profile, credits, videos —
 * are left alone.
 */
export function invalidateAfterCollectionChange(
  queryClient: QueryClient,
  userId: string,
  mediaItemId: string,
  // The ranking session reports its category as a bare string from the server, so
  // this takes one too and narrows it here rather than making every caller cast.
  options: { category?: string } = {},
) {
  const invalidate = (queryKey: readonly unknown[]) =>
    void queryClient.invalidateQueries({ queryKey });

  // The ranked list this title landed in. Both are invalidated when the category is
  // not known, because a re-bucket can move a title between them and the caller that
  // knows which one is the one that just finished a session.
  if (options.category === 'movies' || options.category === 'tv_seasons') {
    invalidate(queryKeys.rankings(userId, options.category));
  } else {
    invalidate(queryKeys.rankings(userId, 'movies'));
    invalidate(queryKeys.rankings(userId, 'tv_seasons'));
  }

  // Logged/ranked counts, the unranked queue, and — by prefix — the watchlist, whose
  // key is `[...collection(userId), 'watchlist']`. Ranking removes the title from the
  // watchlist server-side (20260815040000), so this is what stops a just-ranked title
  // still reading "In watchlist".
  invalidate(queryKeys.collection(userId));

  // The title page: the catalogue half and, by prefix, the personal half at
  // `[...title(id), 'personal', userId]`.
  invalidate(queryKeys.title(mediaItemId));
  invalidate(queryKeys.logState(userId, mediaItemId));

  // The feed. `_rank_finalize` writes a `feed_events` row, so the activity exists the
  // moment the session ends and only the cache was hiding it. Keyed by prefix because
  // the full key carries a cursor object.
  invalidate(['feed', userId]);

  // Profile → Recent activity, which asks about one actor rather than a follow set.
  invalidate(['actor-activity', userId]);

  // The spoiler set. Watching something is what unmasks other people's spoiler notes
  // about it, so a title logged now must stop being masked now.
  invalidate(['watched', userId]);

  // The community aggregate for this exact title: the reader's own new rating is part
  // of it, and a score that excludes the rating you just gave reads as broken.
  invalidate(['community-score', mediaItemId]);

  // Yearly goal progress. Keyed by prefix rather than by `queryKeys.goals(userId,
  // year)`, because the year the user just logged is not necessarily the year on
  // screen: logging a film watched last December has to move *that* year's bar, and
  // this module has no business computing which year that was.
  invalidate(['goals', userId]);
}
